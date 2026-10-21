import { useCallback, useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { apiGet, apiPostMultipart, errorText, expandPaths } from '@/ipc';
import { useToasts } from '@hooks';
import type { CreateTaskResponse, LibraryResponse } from '@/types';
import { dupKey, splitBatches, uuid } from '@tools';
import { Btn, Notice } from '@components/units';
import { BookOpenCheck, Check, FolderPlus, Image, ImagePlus, Info, SlidersHorizontal, Upload, X } from 'lucide-react';

const BATCH_LIMIT = 20; // 契约 §5.2 单次上限

interface Picked {
  path: string;
  name: string;
  batch: number;
}

function decorate(files: string[]): Picked[] {
  return files.map((p, i) => ({
    path: p,
    name: p.split('/').pop() ?? p,
    batch: Math.floor(i / BATCH_LIMIT) + 1,
  }));
}

/**
 * 画面 X-B1 · 本机投放（《02》§5.7）。
 *
 * 与插件共用同一契约与**同一条队列** —— 这里提交下去的任务，在队列页与插件提交的任务
 * 长得一模一样，唯一的区别是「来源」列显示「本机投放」（归因见 spec-notes G-04）。
 *
 * 两点必须说清楚：
 *  ① **阅读顺序**：磁盘上的文件没有页面坐标，故按文件名自然序排序（spec-notes G-05），
 *     这一排序由 Rust 侧的 `expand_paths` 完成，前端只消费结果。
 *  ② **落盘路径预览**：契约 §5.2 要求用**服务端回传的** `normalizedComicName` 渲染预览
 *     （§6 规定规范化只在服务端执行）。所以提交前这里只显示根目录，提交后才给出权威路径 ——
 *     绝不前端自己猜一个规范化结果。
 */
export function DropScreen({
  rootDir,
  onSubmitted,
  onGoLibrary,
}: {
  rootDir: string | null;
  onSubmitted: () => void;
  onGoLibrary: () => void;
}) {
  // 吐司单例总线：直接取用，不必由宿主透传（见 useToasts 注释）
  const { push: onToast } = useToasts();
  const [files, setFiles] = useState<Picked[]>([]);
  const [comicName, setComicName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateTaskResponse | null>(null);

  const ingest = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const expanded = await expandPaths(paths);
        setFiles(decorate(expanded));
        setResult(null);
        if (expanded.length > BATCH_LIMIT) {
          onToast(`${expanded.length} 张，将自动分 ${Math.ceil(expanded.length / BATCH_LIMIT)} 批提交`, 'info');
        }
      } catch (e) {
        onToast(errorText(e), 'bad');
      }
    },
    [onToast],
  );

  // Tauri 的拖放事件才带**真实文件路径**（HTML5 drop 事件出于安全不给路径）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (!alive) return;
        if (e.payload.type === 'over' || e.payload.type === 'enter') setDragging(true);
        else if (e.payload.type === 'leave') setDragging(false);
        else if (e.payload.type === 'drop') {
          setDragging(false);
          void ingest(e.payload.paths ?? []);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [ingest]);

  /*
   * 两个选择器都走宿主原生对话框：`open()` 在宿主不可用 / 被系统拒绝时是**拒绝**，
   * 而不是返回 null。不接住就是一条未处理的 Promise  rejection（控制台红字，界面上
   * 什么都不发生）—— 用户只会觉得"点了没反应"。失败一律落到吐司上，说清是哪一步。
   */
  const pickFiles = async () => {
    try {
      const picked = await open({
        multiple: true,
        directory: false,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (Array.isArray(picked)) await ingest(picked);
    } catch (e) {
      onToast(`打开图片选择器失败：${errorText(e)}`, 'bad');
    }
  };

  const pickDir = async () => {
    try {
      const picked = await open({ multiple: false, directory: true });
      if (typeof picked === 'string') await ingest([picked]);
    } catch (e) {
      onToast(`打开文件夹选择器失败：${errorText(e)}`, 'bad');
    }
  };

  const batches = splitBatches(
    files.map((f) => f.path),
    BATCH_LIMIT,
  );
  const nameOk = comicName.trim().length > 0;
  const canSubmit = !busy && nameOk && files.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    const name = comicName.trim();
    setBusy(true);
    setResult(null);
    try {
      /*
       * **重名校验（R1）**：提交前先用**同一个根目录**的库列表比对，命中同名直接拦下、
       * 不建任务队列 —— 避免"第 12 话"被重复投放成两份。
       *
       * 查库失败**不阻断**（服务不可达 / 首次还没扫过库）：重名是防呆，不该因此让正常投放
       * 用不了；服务端对同名本就有「续编号、不覆盖」的兜底（契约 §6.3）。
       * 需要**有意**补页走的是漫画库的「继续翻译」（`POST /library/{name}/resume`），不是这里。
       */
      try {
        const lib = await apiGet<LibraryResponse>('/library');
        const key = dupKey(name);
        const hit = (lib.comics ?? []).find((c) => dupKey(c.comicName) === key || dupKey(c.dirName) === key);
        if (hit) {
          onToast(`漫画名「${hit.comicName}」已存在，请换个名字；补页请用漫画库的「继续翻译」`, 'bad');
          setBusy(false);
          return;
        }
      } catch {
        // 读库不可达 —— 交给服务端兜底
      }

      const key = uuid();
      // B1：第一批走 POST /tasks（带 comicName，服务端在此规范化并给出 normalizedComicName）
      const first = await apiPostMultipart<CreateTaskResponse>(
        '/tasks',
        { comicName: name, idempotencyKey: key },
        batches[0],
      );
      /*
       * B2…Bn：追加同一任务的后续批次（契约 §5.3「分批提交的唯一实现路径」）。
       *
       * 🔴 中途一批失败时**不能说"全部已提交"**：第 1 批已经在队里了，用户得知道
       * 实际落了几批、去哪补剩下的。这里把已提交批数如实报出来，并把回执留在界面上
       * （`setResult`），而不是只吐一句错误 —— 只吐错误会让人以为什么都没发生，
       * 于是再点一次提交，撞上"同名不覆盖"再兜一圈。
       */
      let submitted = 1;
      let batchError: unknown = null;
      for (let i = 1; i < batches.length; i++) {
        try {
          await apiPostMultipart(`/tasks/${first.taskId}/batches`, { idempotencyKey: uuid() }, batches[i]);
          submitted += 1;
        } catch (e) {
          batchError = e;
          break;
        }
      }
      setResult(first);
      const landed = batches.slice(0, submitted).reduce((n, b) => n + b.length, 0);
      const rest = files.length - landed;
      setFiles((prev) => prev.slice(landed));
      onSubmitted();
      if (batchError) {
        onToast(
          `已提交 ${landed} 张（前 ${submitted} / ${batches.length} 批），第 ${submitted + 1} 批失败：${errorText(
            batchError,
          )}${rest > 0 ? `；剩下 ${rest} 张仍留在清单里，可重试提交` : ''}`,
          'bad',
        );
        return;
      }
      onToast(
        batches.length > 1
          ? `已提交 ${files.length} 张（${batches.length} 批），队内第 ${first.queuePosition} 位`
          : `已提交 ${files.length} 张，队内第 ${first.queuePosition} 位`,
        'good',
      );
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drop-scroll">
      <div className="drop-grid">
        {/* ── 左列：投放区 + 待投放清单 ───────────────────────────── */}
        <div className="drop-col">
          <section
            className={dragging ? 'drop-zone is-drag' : 'drop-zone'}
            onClick={() => void pickFiles()}
            role="button"
            tabIndex={0}
            aria-label="把图片或文件夹拖进这里，或选择文件"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void pickFiles();
            }}
          >
            <span className="drop-halftone" aria-hidden="true" />
            <span className="drop-orb">
              <ImagePlus size={26} />
            </span>
            <h2>把漫画图片拖到这里</h2>
            <p className="drop-sub">
              支持 png / jpg / jpeg / webp；服务端每批 {BATCH_LIMIT} 张，超出的部分会自动排队
              （序号连续，不需要你分批）。
            </p>
            <div className="drop-actions" onClick={(e) => e.stopPropagation()}>
              <Btn kind="primary" onClick={() => void pickFiles()}>
                <Upload size={14} /> 选择图片
              </Btn>
              <Btn kind="ghost" onClick={() => void pickDir()}>
                <FolderPlus size={14} /> 选择文件夹
              </Btn>
            </div>
            <div className="drop-tips">
              <span>
                <Check size={12} /> 按文件名自然序排页
              </span>
              <span>
                <Check size={12} /> 原图不会被修改
              </span>
              <span>
                <Check size={12} /> 每 {BATCH_LIMIT} 张自动分批
              </span>
            </div>
          </section>

          {result ? (
            <Notice kind="ok">
              <b>已进入同一条队列。</b> 落盘到：
              <div className="pathpreview">{result.outputDir}</div>
              <div className="notice-acts">
                <Btn kind="ghost" size="sm" onClick={onGoLibrary}>
                  去漫画库看
                </Btn>
              </div>
            </Notice>
          ) : null}

          {files.length > 0 ? (
            <section className="drop-queue">
              <div className="drop-queue-head">
                <h3>
                  待投放 <span className="num">{files.length}</span> 张
                  {batches.length > 1 ? (
                    <>
                      {' · '}分 <span className="num">{batches.length}</span> 批
                    </>
                  ) : null}
                </h3>
                <div className="drop-queue-actions">
                  <button type="button" className="text-btn" onClick={() => setFiles([])} disabled={busy}>
                    清空
                  </button>
                </div>
              </div>
              <div className="drop-files">
                {files.map((f, i) => (
                  <div key={f.path} className="drop-file">
                    <span className="drop-file-thumb">
                      <Image size={15} />
                    </span>
                    <span className="drop-file-meta">
                      <strong title={f.path}>{f.name}</strong>
                      <small>
                        <span className="num">{f.batch}</span> / <span className="num">{batches.length}</span> 批
                      </small>
                    </span>
                    <button
                      type="button"
                      className="drop-file-remove"
                      aria-label={`移除 ${f.name}`}
                      title="从本次投放中移除"
                      onClick={() => setFiles((prev) => decorate(prev.filter((_, j) => j !== i).map((p) => p.path)))}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* ── 右列：本次投放的表单与落盘预览 ─────────────────────── */}
        <aside className="drop-col">
          <section className="form-card">
            <h3>
              <SlidersHorizontal size={14} /> 本次投放
            </h3>
            <p className="form-sub">漫画名是落盘目录的唯一键；其余规则由服务端统一执行，不在这里临时改。</p>

            <div className="field">
              <label className="field-label" htmlFor="comicName">
                漫画名
              </label>
              <input
                id="comicName"
                className="input"
                placeholder="例如：第12话 · 学园祭"
                value={comicName}
                onChange={(e) => setComicName(e.target.value)}
              />
              <span className={nameOk || files.length === 0 ? 'field-hint' : 'field-hint is-error'}>
                名称由服务端统一规范化（全角转半角、非法字符剥离）；同名漫画会被拦下、不重复投放 ——
                要补页请用漫画库的「继续翻译」。
              </span>
            </div>

            <div className="drop-meta">
              <div className="drop-meta-row">
                <span>来源</span>
                <b>本机投放</b>
              </div>
              <div className="drop-meta-row">
                <span>批次</span>
                <b>
                  {files.length ? (
                    <>
                      <span className="num">{batches.length}</span> 批 · 每批最多{' '}
                      <span className="num">{BATCH_LIMIT}</span> 张
                    </>
                  ) : (
                    '尚未选择图片'
                  )}
                </b>
              </div>
              <div className="drop-meta-row">
                <span>落盘根目录</span>
                <b className="pathinline" title={rootDir ?? undefined}>
                  {rootDir ?? '（根目录未知）'}
                </b>
              </div>
              <div className="drop-meta-row">
                <span>预计输出</span>
                <b className="pathinline">{'提交后由服务端给出'}</b>
              </div>
            </div>

            <div className="drop-submit">
              <Btn kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
                <Upload size={14} /> {busy ? '提交中…' : `提交 ${files.length || ''}`.trim()}
              </Btn>
              {files.length > 0 ? (
                <Btn kind="ghost" onClick={() => setFiles([])} disabled={busy}>
                  清空
                </Btn>
              ) : null}
            </div>

            {!nameOk && files.length > 0 ? (
              <p className="field-hint is-error">请先填漫画名 —— 它是落盘目录的唯一键（契约 §6.3：重名不覆盖）。</p>
            ) : null}

            <p className="batch-note">
              <Info size={12} />
              同一时刻只翻译 1 个批次，其余会自动排队。翻译过程中可以关闭喵坞，任务状态会保存在本机。
            </p>
          </section>

          <section className="form-card">
            <h3>
              <BookOpenCheck size={14} /> 落盘规则
            </h3>
            <p className="form-sub">这三条由服务端保证，投放页只是把它们说清楚。</p>
            <div className="drop-flow-grid">
              <div className="drop-flow-step">
                <span>01</span>
                <strong>页序</strong>
                <p>磁盘上的文件没有页面坐标，按文件名自然序排序（由服务端展开）。</p>
              </div>
              <div className="drop-flow-step">
                <span>02</span>
                <strong>规范化</strong>
                <p>漫画名只在服务端规范化，提交前这里不猜名字。</p>
              </div>
              <div className="drop-flow-step">
                <span>03</span>
                <strong>重名</strong>
                <p>同名不覆盖：已存在会被拦下，补页走漫画库的「继续翻译」。</p>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
