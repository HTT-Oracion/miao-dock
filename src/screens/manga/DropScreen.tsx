import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { apiGet, apiPostMultipart, errorText, expandPaths } from '@/ipc';
import type { TranslateSource } from '@screens/settings/translate-api';
import { engineOptions, TIER_LABEL } from '@screens/settings/engine-api';
import type { EngineTier } from '@screens/settings/engine-api';
import { useToasts } from '@hooks';
import type { CreateTaskResponse, LibraryResponse, TaskRow } from '@/types';
import { dupKey, splitBatches, uuid } from '@tools';
import { Btn, Notice } from '@components/units';
import {
  ArrowRight,
  Book,
  Check,
  FolderPlus,
  Image,
  ImagePlus,
  Info,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';

const BATCH_LIMIT = 20; // 契约 §5.2 单次上限

/** 投放来源的中文名（本次规则那一行用；`null` = 还没读到偏好） */
const SOURCE_LABEL: Record<TranslateSource, string> = { local: '本地引擎', online: '在线 API' };

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

/** 缩略瓦片上的字形：取漫画名首字（与书架封面同一套观感，不引外部图片） */
function glyphOf(name: string): string {
  return [...name][0] ?? '书';
}

/** 瓦片的底色档位：按名字稳定散列到三个模块色之一（同一个名字永远同一色） */
function toneOf(name: string): string {
  const tones = ['var(--miao-primary)', 'var(--miao-accent)', 'var(--miao-sage)'];
  let h = 0;
  for (const ch of name) h = (h + ch.codePointAt(0)!) % 997;
  return tones[h % tones.length];
}

/** 最近一次投放 = 创建时间最新的那条任务（数据来自 `/tasks`，不是本地留痕） */
function latestTask(tasks: TaskRow[]): TaskRow | null {
  if (tasks.length === 0) return null;
  return tasks.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
}

/** 任务状态的中文说法（只覆盖投放回执会用到的那几种） */
function statusLabel(t: TaskRow): string {
  switch (t.status) {
    case 'done':
      return '已完成';
    case 'running':
      return '正在翻译';
    case 'queued':
      return '排队中';
    case 'partial_failed':
      return '部分失败';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    default:
      return t.status;
  }
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
 *
 * ## 版式按设计稿：左列叙事 / 右栏填单
 *
 * 左列从上到下是「怎么放 → 放完看到什么 → 之前放过什么 → 放完会发生什么」，
 * 右栏是「这次要填什么（漫画信息）+ 规则来自哪里（本次规则）」。
 * 「最近投放」与「本次规则」是设计稿有、旧实现没有的两块，本轮补齐：
 * 前者读真实的 `/tasks`，后者读真实的引擎选项与翻译来源 —— 都不是写死的示例。
 */
export function DropScreen({
  rootDir,
  tasks,
  source,
  onSubmitted,
  onGoLibrary,
  onGoQueue,
}: {
  rootDir: string | null;
  /** 队列行（`/tasks`）：用来渲染「最近投放」，也用来做重名预检的兜底 */
  tasks: TaskRow[];
  /** 翻译来源（本地引擎 / 在线 API）—— 「本次规则」里那一行的事实源 */
  source: TranslateSource | null;
  onSubmitted: () => void;
  onGoLibrary: () => void;
  onGoQueue: () => void;
}) {
  // 吐司单例总线：直接取用，不必由宿主透传（见 useToasts 注释）
  const { push: onToast } = useToasts();
  const [files, setFiles] = useState<Picked[]>([]);
  const [comicName, setComicName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateTaskResponse | null>(null);
  /** 本次生效的翻译档位（读引擎选项；读不到就不显示这一行的值） */
  const [tier, setTier] = useState<EngineTier | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const o = await engineOptions();
        if (alive) setTier(o.tier.effective);
      } catch {
        // 读不到档位不影响投放：这一行退化成「—」，不编一个值出来
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

  /** 重名预检（本地库 + 队列里已有的名字），只用于**提示**，最终以服务端为准 */
  const dupHint = useMemo(() => {
    const key = dupKey(comicName.trim());
    if (!key) return false;
    return tasks.some(
      (t) => dupKey(t.comicName) === key || (t.normalizedComicName ? dupKey(t.normalizedComicName) === key : false),
    );
  }, [comicName, tasks]);

  const recent = latestTask(tasks);
  /** 最近三批投放的瓦片（设计稿叠三枚）：没有那么多就少放几枚，不补占位瓦片 */
  const recentThumbs = [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 3);

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

  /** 漫画名下方那行提示：错误 > 重名 > 空态说明（设计稿三态） */
  const nameHint = !nameOk
    ? '会自动去掉文件名中的非法字符'
    : dupHint
      ? '已存在同名漫画，请换一个名字，或在漫画库中直接续做。'
      : '提交后由服务端规范化并给出落盘路径。';

  return (
    <div className="drop-scroll">
      <div className="drop-grid">
        {/* ── 左列：投放区 → 回执 → 待投放清单 → 最近投放 → 投放之后 ───── */}
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
            <p className="drop-sub">支持 JPG / PNG / WEBP。每 20 张自动分为一批，排队顺序按文件名自然排序。</p>
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
                <Check size={12} /> 自动识别页码顺序
              </span>
              <span>
                <Check size={12} /> 原图不会被修改
              </span>
              <span>
                <Check size={12} /> 每 20 张自动分批
              </span>
            </div>
          </section>

          {result ? (
            <Notice kind="ok" className="drop-notice">
              <b>已进入同一条队列。</b> 落盘到：
              <div className="pathpreview">{result.outputDir}</div>
              <div className="notice-acts">
                <Btn kind="ghost" size="sm" onClick={onGoLibrary}>
                  去漫画库看
                </Btn>
                <Btn kind="ghost" size="sm" onClick={onGoQueue}>
                  查看队列
                </Btn>
              </div>
            </Notice>
          ) : null}

          {/* 待投放清单：头行就是这张卡的动作区（清空 + 提交 N 张），与设计稿一致 */}
          {files.length > 0 ? (
            <section className="drop-queue">
              <div className="drop-queue-head">
                <h3>
                  待投放{' '}
                  <span>
                    {files.length} 张 · {batches.length} 批
                  </span>
                </h3>
              </div>
              <div className="drop-files">
                {files.map((f, i) => (
                  <div key={f.path} className="drop-file">
                    <span className="drop-file-thumb">
                      <Image size={15} />
                    </span>
                    <span className="drop-file-meta">
                      <strong title={f.path}>{f.name}</strong>
                      <small>第 {f.batch} 批</small>
                    </span>
                    <Btn
                      kind="bare"
                      className="drop-file-remove"
                      ariaLabel={`移除 ${f.name}`}
                      title="从本次投放中移除"
                      onClick={() => setFiles((prev) => decorate(prev.filter((_, j) => j !== i).map((p) => p.path)))}
                    >
                      <X size={12} />
                    </Btn>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* 最近投放：设计稿有、旧实现没有。数据来自 `/tasks`，没有记录就是空态，不摆演示图 */}
          <div className="recent-drop">
            <div className="section-head">
              <h2>最近投放</h2>
              <Btn kind="bare" className="link-btn" onClick={onGoQueue}>
                查看队列 <ArrowRight size={12} />
              </Btn>
            </div>
            {recent ? (
              <div className="recent-bar">
                <div className="recent-thumbs">
                  {recentThumbs.map((t) => (
                    <span key={t.taskId} className="recent-thumb" style={{ background: toneOf(t.comicName) }}>
                      {glyphOf(t.comicName)}
                    </span>
                  ))}
                </div>
                <span className="recent-text">
                  <strong>
                    {recent.comicName} · {recent.progress.total} 张
                  </strong>
                  <small>
                    {recent.createdAt} · {statusLabel(recent)}
                  </small>
                </span>
                <Btn kind="ghost" size="sm" onClick={() => void pickFiles()}>
                  再次投放
                </Btn>
              </div>
            ) : (
              <div className="recent-bar is-empty">
                <span className="recent-text">
                  <strong>还没有投放记录</strong>
                  <small>把图片拖进上面的投放区，或点「选择图片」。</small>
                </span>
              </div>
            )}
          </div>

          <section className="drop-flow">
            <div className="drop-flow-head">
              <h2>投放之后会发生什么</h2>
            </div>
            <div className="drop-flow-grid">
              <div className="drop-flow-step">
                <span>01</span>
                <strong>自动分组</strong>
                <p>按文件名自然排序，每 20 张一批；文字方向与命名规则都来自设置。</p>
              </div>
              <div className="drop-flow-step">
                <span>02</span>
                <strong>串行翻译</strong>
                <p>本地引擎逐页检测气泡、修复背景并翻译。同一时刻只跑一个批次。</p>
              </div>
              <div className="drop-flow-step">
                <span>03</span>
                <strong>落盘到库</strong>
                <p>译文写回原目录，作品按「本 → 话 → 页」出现在漫画库，随时可以对照。</p>
              </div>
            </div>
          </section>
        </div>

        {/* ── 右栏：漫画信息 + 本次规则 ───────────────────────────── */}
        <aside className="drop-form">
          <section className="form-card">
            <h3>
              <Book size={14} /> 漫画信息
            </h3>
            <p className="form-sub">译文会落在根目录下以漫画名命名的文件夹里；重名会被拦截。</p>

            <div className="field">
              <label className="field-label" htmlFor="comicName">
                漫画名 <span className="field-req">*</span>
              </label>
              <input
                id="comicName"
                className="input"
                maxLength={60}
                placeholder="例如：星轨邮差"
                value={comicName}
                autoComplete="off"
                onChange={(e) => setComicName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
              />
              <span className={dupHint && nameOk ? 'field-hint is-error' : 'field-hint'}>{nameHint}</span>
            </div>

            <div className="drop-meta">
              <div className="drop-meta-row">
                <span>来源</span>
                <b>本机投放</b>
              </div>
              <div className="drop-meta-row">
                <span>批次</span>
                <b>{files.length ? `${batches.length} 批 · 每批最多 ${BATCH_LIMIT} 张` : '尚未选择图片'}</b>
              </div>
              <div className="drop-meta-row">
                <span>落盘根目录</span>
                <b className="pathinline" title={rootDir ?? undefined}>
                  {rootDir ?? '（根目录未知）'}
                </b>
              </div>
              <div className="drop-meta-row">
                <span>预计输出</span>
                {/* 规范化只在服务端执行（契约 §6）：没有回执之前不编一个路径出来 */}
                <b className="pathinline">{result?.outputDir ?? '—'}</b>
              </div>
            </div>

            <div className="drop-submit">
              <Btn kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
                <Upload size={14} /> {busy ? '提交中…' : `提交 ${files.length} 张`}
              </Btn>
              <Btn kind="ghost" disabled={files.length === 0 || busy} onClick={() => setFiles([])}>
                清空
              </Btn>
            </div>

            <p className="batch-note">
              <Info size={12} />
              同一时刻只翻译 1 个批次，其余会自动排队。翻译过程中可以关闭喵坞，任务状态会保存在本机。
            </p>
          </section>

          {/* 本次规则：读真实设置，不在投放页临时改（设计稿右侧第二张卡） */}
          <section className="form-card">
            <h3>
              <SlidersHorizontal size={14} /> 本次规则
            </h3>
            <p className="form-sub">规则来自当前设置，不在投放页临时改动。</p>
            <div className="drop-meta">
              <div className="drop-meta-row">
                <span>翻译方向</span>
                {/* 方向逐任务下发（设置页「翻译方向」一行同样是这个口径），投放页不猜 */}
                <b>按任务方向</b>
              </div>
              <div className="drop-meta-row">
                <span>翻译档位</span>
                <b>{tier ? TIER_LABEL[tier] : '—'}</b>
              </div>
              <div className="drop-meta-row">
                <span>翻译来源</span>
                <b>{source ? SOURCE_LABEL[source] : '—'}</b>
              </div>
              <div className="drop-meta-row">
                <span>批大小</span>
                <b>{BATCH_LIMIT} 张</b>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
