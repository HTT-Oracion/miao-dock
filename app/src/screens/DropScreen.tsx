import { useCallback, useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { apiGet, apiPostMultipart, errorText, expandPaths } from '@/ipc';
import type { CreateTaskResponse, LibraryResponse } from '@/types';
import { dupKey, splitBatches, uuid } from '@tools';
import { Btn, Notice } from '@components/units';
import { Upload } from 'lucide-react';

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
  onToast,
  onGoLibrary,
}: {
  rootDir: string | null;
  onSubmitted: () => void;
  onToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
  onGoLibrary: () => void;
}) {
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

  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (Array.isArray(picked)) await ingest(picked);
  };

  const pickDir = async () => {
    const picked = await open({ multiple: false, directory: true });
    if (typeof picked === 'string') await ingest([picked]);
  };

  const batches = splitBatches(files.map((f) => f.path), BATCH_LIMIT);
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
      // B2…Bn：追加同一任务的后续批次（契约 §5.3「分批提交的唯一实现路径」）
      for (let i = 1; i < batches.length; i++) {
        await apiPostMultipart(
          `/tasks/${first.taskId}/batches`,
          { idempotencyKey: uuid() },
          batches[i],
        );
      }
      setResult(first);
      setFiles([]);
      onToast(
        batches.length > 1
          ? `已提交 ${files.length} 张（${batches.length} 批），队内第 ${first.queuePosition} 位`
          : `已提交 ${files.length} 张，队内第 ${first.queuePosition} 位`,
        'good',
      );
      onSubmitted();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drop">
      <div
        className={dragging ? 'dropzone is-over' : 'dropzone'}
        onClick={() => void pickFiles()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void pickFiles();
        }}
      >
        <Upload size={20} />
        <div className="dropzone-title">把图片或文件夹拖进这里</div>
        <div className="dropzone-sub">
          支持 png / jpg / jpeg / webp；服务端每批 {BATCH_LIMIT} 张，超出的部分会自动排队（序号连续，不需要你分批）
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <Btn kind="ghost" onClick={() => void pickFiles()}>
            选择图片
          </Btn>
          <Btn kind="ghost" onClick={() => void pickDir()}>
            选择文件夹
          </Btn>
        </div>
      </div>

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
        <span className="field-hint">
          名称由服务端统一规范化（全角转半角、非法字符剥离）；同名漫画会被拦下、不重复投放 ——
          要补页请用漫画库的「继续翻译」。
        </span>
      </div>

      {files.length > 0 ? (
        <>
          <div className="field">
            <span className="field-label">
              待投放 <span className="num">{files.length}</span> 张
              {batches.length > 1 ? (
                <>
                  {' · '}
                  分 <span className="num">{batches.length}</span> 批
                </>
              ) : null}
            </span>
            <div className="filelist">
              {files.map((f) => (
                <div key={f.path} className="filelist-row">
                  <span>{f.name}</span>
                  <span className="num">第 {f.batch} 批</span>
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">落盘路径预览</span>
            <div className="pathpreview">
              {rootDir ?? '（根目录未知）'}/{'<漫画名规范化的结果，提交后由服务端给出>'}
            </div>
            <span className="field-hint">
              规范化只在服务端执行（契约 §6），所以提交前这里不猜名字；提交后立即显示实际落盘路径。
            </span>
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? '提交中…' : `提交 ${files.length || ''}`.trim()}
        </Btn>
        {files.length > 0 ? (
          <Btn kind="ghost" onClick={() => setFiles([])} disabled={busy}>
            清空
          </Btn>
        ) : null}
      </div>

      {result ? (
        <Notice>
          <div>
            <b>已进入同一条队列。</b> 落盘到：
          </div>
          <div className="pathpreview" style={{ marginTop: 6 }}>
            {result.outputDir}
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Btn kind="ghost" size="sm" onClick={onGoLibrary}>
              去漫画库看
            </Btn>
          </div>
        </Notice>
      ) : null}

      {!nameOk && files.length > 0 ? (
        <Notice kind="bad">请先填漫画名 —— 它是落盘目录的唯一键（契约 §6.3：重名不覆盖）。</Notice>
      ) : null}
    </div>
  );
}
