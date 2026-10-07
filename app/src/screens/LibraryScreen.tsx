import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { EyeOff, FolderUp, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { apiBytes, apiGet, apiPost, errorText, isApiError, openPath } from '@/ipc';
import { LIBRARY } from '@/theme/tokens';
import type { ComicEntry, LibraryDeleteResponse, LibraryResponse } from '@/types';
import { formatBytes, fuzzyMatch, pageCount, pageSlice, sniffMime } from '@/util';
import { Btn } from '@components/units';

/** 左栏每页漫画数（窄栏 + 每项约 48px 高，12 项差不多一屏） */
const LIB_PAGE_SIZE = 12;
/** 网格每页张数（110×165 卡 + 12 间距；24 张约两行多，翻页不至于太空） */
const GRID_PAGE_SIZE = 24;

/** 库内文件路径（`GET /library/{comicName}/files/{seq}?variant=…`） */
function filePath(comicName: string, seq: number, variant: 'original' | 'translated'): string {
  return `/library/${encodeURIComponent(comicName)}/files/${seq}?variant=${variant}`;
}

/**
 * 取图结果的 blob URL 缓存（**跨组件、跨卸载**）。
 *
 * ## 为什么必须有它
 * 从对照视图点「返回」回到网格时，网格里每一张缩略图都会被**重新挂载**，
 * 于是每个 `useBlobUrl` 都会重新走一次 IPC 取字节 —— 表现就是"返回后整片网格刷一下、
 * 先闪一片『加载中…』再逐张出图"。缓存把已经取到的 blob URL 留下来，
 * 重新挂载时**同步命中**（useState 惰性初始化里就能拿到），于是不再有那一下闪烁。
 *
 * ## 所有权：缓存持有 URL，组件不再 revoke
 * 旧实现是"组件挂载时建 URL、卸载时 revoke"。一旦引入缓存，这条所有权就不成立了 ——
 * 组件卸载后 revoke 掉，缓存里就成了死链。所以改为：**由缓存统一持有并管理 revoke**，
 * 组件只借用。淘汰（LRU）时才 revoke 掉最旧的一条。
 *
 * ## 为什么在途请求也要去重
 * 同一页可能被网格卡与对照视图**同时**请求（返回时更是如此）。不去重就会为同一条路径
 * 建出两个 object URL，其中一个永远不会被引用、也永远不会被 revoke —— 纯泄漏。
 */
const URL_CACHE = new Map<string, string>(); // path → objectURL；Map 的插入序即 LRU 序
const URL_CACHE_MAX = 160;
const INFLIGHT = new Map<string, Promise<string>>();

/** 命中缓存（并把该条移到 LRU 末尾）；未命中返回 null */
function cachePeek(path: string): string | null {
  const url = URL_CACHE.get(path);
  if (url === undefined) return null;
  URL_CACHE.delete(path);
  URL_CACHE.set(path, url);
  return url;
}

/** 存入缓存并在超限时淘汰最旧的一条（连同 revoke） */
function cachePut(path: string, url: string): void {
  URL_CACHE.set(path, url);
  while (URL_CACHE.size > URL_CACHE_MAX) {
    const oldest = URL_CACHE.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const dead = URL_CACHE.get(oldest);
    URL_CACHE.delete(oldest);
    if (dead) URL.revokeObjectURL(dead);
  }
}

/** 取一条路径的 blob URL：先查缓存，再查在途，最后才真发一次请求 */
function fetchBlobUrl(path: string): Promise<string> {
  const hit = cachePeek(path);
  if (hit) return Promise.resolve(hit);
  const inflight = INFLIGHT.get(path);
  if (inflight) return inflight;
  const p = apiBytes(path)
    .then((buf) => {
      const url = URL.createObjectURL(new Blob([buf], { type: sniffMime(buf) }));
      cachePut(path, url);
      return url;
    })
    .finally(() => {
      INFLIGHT.delete(path);
    });
  INFLIGHT.set(path, p);
  return p;
}

/** blob 取图的结果：`missing` = 文件不存在（含未发起请求），与 `loading` 必须分开 */
type BlobState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'missing' };

/**
 * 取库内图片并转成 blob URL（经上面的缓存）。
 *
 * 返回**三态**而不是 `string | null`：`null` 同时表达了「还在取」和「取不到」，
 * 调用方无从区分，于是只能一律显示「加载中…」—— 文件根本不存在时就会**永远**停在加载中。
 */
function useBlobUrl(path: string | null): BlobState {
  // 惰性初始化：**重新挂载时若缓存已命中，首帧就是 ready**，不经过 loading —— 这就是"不闪"的来源
  const [state, setState] = useState<BlobState>(() => {
    if (!path) return { kind: 'missing' };
    const hit = cachePeek(path);
    return hit ? { kind: 'ready', url: hit } : { kind: 'loading' };
  });

  useEffect(() => {
    if (!path) {
      setState({ kind: 'missing' });
      return;
    }
    const hit = cachePeek(path);
    if (hit) {
      setState({ kind: 'ready', url: hit });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    fetchBlobUrl(path)
      .then((url) => {
        if (alive) setState({ kind: 'ready', url });
      })
      .catch(() => {
        if (alive) setState({ kind: 'missing' });
      });
    // ⚠️ 故意**不 revoke** —— URL 归缓存所有（见上面 URL_CACHE 的说明）
    return () => {
      alive = false;
    };
  }, [path]);

  return state;
}

/**
 * 网格卡三态 —— 判定依据是 `/library` 给出的**逐页**集合（`translatedSeqs` / `missingSeqs`），
 * 不是张数。张数只能回答「译了几页」，回答不了「译了哪几页」；缺页落在中间时，
 * 用张数推出来的结论会把后面每一页整体前移一位，见 spec-notes G-10。
 */
type GridState = 'done' | 'pending' | 'missing';

const GRID_LABEL: Record<GridState, string> = { done: '已译', pending: '待译', missing: '缺页' };

/**
 * 左栏每部漫画的状态短语。
 *
 * 原先这里只写 `缺 ${imageCount - translatedCount}`，而那个数其实是**没有译文的**页数
 * —— 于是同一屏上冒出两个含义相反的「缺」：左栏说「缺 1」（那一页其实有原图，只是待译），
 * 网格卡说「缺页」（专指**没有原图**）。字面同源、意思不同，正是 G-11 里
 * 「同一张图、两屏两个故事」的翻版。逐页集合（G-10）已经能分开算，就没理由继续含糊。
 */
function progressLabel(c: ComicEntry): string {
  if (c.imageCount === 0) return '空目录';
  const missing = c.missingSeqs.length;
  const pending = c.imageCount - c.translatedCount - missing;
  if (pending <= 0 && missing <= 0) return '已译完';
  const parts: string[] = [];
  if (pending > 0) parts.push(`待译 ${pending}`);
  if (missing > 0) parts.push(`缺页 ${missing}`);
  return parts.join(' · ');
}

/**
 * 网格缩略图。三态必须分开，且**只在确实有译文时才发请求** ——
 * 对已知没有译文的页仍去取一次、失败后显示「加载中…」，是把「不存在」伪装成「还没到」。
 */
function Thumb({ comicName, seq, state }: { comicName: string; seq: number; state: GridState }) {
  // hooks 不能条件调用，故把「要不要取」编码进 path（null = 不取）
  const blob = useBlobUrl(state === 'done' ? filePath(comicName, seq, 'translated') : null);
  if (state === 'done') {
    if (blob.kind === 'loading') return <div className="grid-placeholder">加载中…</div>;
    if (blob.kind === 'ready') {
      return <img className="grid-thumb" src={blob.url} alt={`第 ${seq} 页译文`} draggable={false} />;
    }
    // 库扫描说这页有译文、文件却取不到 —— 不装作没事
    return (
      <div className="grid-placeholder is-bad" title="库里有这一页的译文记录，但文件读不出来">
        读取失败
      </div>
    );
  }
  if (state === 'missing') return <div className="grid-placeholder">缺页</div>;
  return <div className="grid-placeholder">待译</div>;
}

function Pane({
  comicName,
  seq,
  variant,
  onZoom,
}: {
  comicName: string;
  seq: number;
  variant: 'original' | 'translated';
  onZoom: () => void;
}) {
  const blob = useBlobUrl(filePath(comicName, seq, variant));
  const label = variant === 'original' ? '原图' : '译文';
  const file = `${String(seq).padStart(3, '0')}${variant === 'translated' ? '_translated' : ''}.png`;
  return (
    <div className="pane">
      <div className="pane-title">
        <span>{label}</span>
        <span className="muted num" style={{ fontSize: 10.5 }}>
          {file}
        </span>
        {blob.kind === 'ready' ? (
          <span className="pane-zoom" title="点击图片可全屏查看">
            <Search size={11} /> 点击全屏
          </span>
        ) : null}
      </div>
      <div className="pane-body">
        {blob.kind === 'ready' ? (
          // 图片本身可点 → 全屏。别再套一层按钮：全屏是"放大看同一张图"，不是另一个动作。
          <img
            className="zoomable"
            src={blob.url}
            alt={`第 ${seq} 页${label}`}
            draggable={false}
            onClick={onZoom}
            title="点击全屏查看"
          />
        ) : (
          // 取图中 / 确实没有，是两件事：前者会换成图，后者不会
          <span className="muted" style={{ fontSize: 11 }}>
            {blob.kind === 'loading' ? '加载中…' : '该侧文件缺失'}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 全屏看图（零依赖自绘，拍板：不为此引第三方 lightbox）。
 *
 * 为什么自己写：需求只有"铺满屏幕看一张图 + Esc/点击空白关闭 + 左右翻页"这四件，
 * 一个 `position:fixed` 遮罩就够了；引一个组件库反而要多带一层样式重置与主题覆盖，
 * 与项目"零 Context、少依赖"的既有裁定相悖（《09》§2）。
 *
 * 关键交互：**Esc 关闭全屏而不是退出对照** —— 由 `Compare` 统一裁决（见那里的说明）。
 */
function Lightbox({
  comicName,
  seq,
  variant,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onClose,
}: {
  comicName: string;
  seq: number;
  variant: 'original' | 'translated';
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const blob = useBlobUrl(filePath(comicName, seq, variant));
  const label = variant === 'original' ? '原图' : '译文';
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="全屏查看">
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {blob.kind === 'ready' ? (
          <img src={blob.url} alt={`第 ${seq} 页${label} 全屏`} draggable={false} />
        ) : (
          <span className="lightbox-msg">{blob.kind === 'loading' ? '加载中…' : '该侧文件缺失'}</span>
        )}
      </div>

      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="compare-seq">
          <span className="num">{seq}</span>
          <span> / </span>
          <span className="muted">· {label} · </span>
          <span className="muted">{comicName}</span>
        </span>
        <Btn kind="ghost" size="sm" disabled={!canPrev} onClick={onPrev}>
          ← 上一张
        </Btn>
        <Btn kind="ghost" size="sm" disabled={!canNext} onClick={onNext}>
          下一张 →
        </Btn>
        <Btn kind="primary" size="sm" onClick={onClose}>
          关闭
        </Btn>
      </div>

      <button type="button" className="lightbox-x" onClick={onClose} aria-label="关闭全屏">
        <X size={18} />
      </button>
    </div>
  );
}

/**
 * 画面 X-D2 · 原文 / 译文对照（《02》§5.6）。
 *
 * 双图对照 + 左右翻页 + 序号显示。序号按 §5.8「N / M 计数拆两个文本节点」实现为 `N / M`，
 * 与队列页计数一致（G-03）。左右方向键可翻页，Esc 返回；点图可全屏。
 *
 * ⚠️ Esc 的归属由这里统一裁决：**全屏开着时 Esc 只关全屏**（否则一次 Esc 会连关两层，
 * 用户以为只是退出全屏、结果直接被踢回网格）。因此这里独占键盘监听，全屏自身不再监听。
 */
function Compare({
  comic,
  seq,
  onSeq,
  onBack,
}: {
  comic: ComicEntry;
  seq: number;
  onSeq: (s: number) => void;
  onBack: () => void;
}) {
  const canPrev = seq > 1;
  const canNext = seq < comic.seqMax;
  const [zoom, setZoom] = useState<'original' | 'translated' | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (zoom) {
        // 全屏态：Esc 只退全屏；左右仍可翻页（全屏的图会跟着换）
        if (e.key === 'Escape') setZoom(null);
        else if (e.key === 'ArrowLeft' && canPrev) onSeq(seq - 1);
        else if (e.key === 'ArrowRight' && canNext) onSeq(seq + 1);
        return;
      }
      if (e.key === 'ArrowLeft' && canPrev) onSeq(seq - 1);
      if (e.key === 'ArrowRight' && canNext) onSeq(seq + 1);
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seq, canPrev, canNext, onSeq, onBack, zoom]);

  // 翻页时若全屏开着，保持全屏（只是换图）—— 除非该页那一侧没了
  useEffect(() => {
    if (zoom === 'translated' && !comic.translatedSeqs.includes(seq)) setZoom(null);
  }, [zoom, seq, comic.translatedSeqs]);

  return (
    <div className="compare">
      <div className="compare-head card">
        <Btn kind="ghost" onClick={onBack}>
          返回
        </Btn>
        <span className="compare-seq">
          <span className="num">{seq}</span>
          <span> / </span>
          <span className="num">{comic.seqMax}</span>
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {comic.comicName}
        </span>
        <div style={{ flex: 1 }} />
        <Btn kind="ghost" disabled={!canPrev} onClick={() => canPrev && onSeq(seq - 1)}>
          ← 上一张
        </Btn>
        <Btn kind="ghost" disabled={!canNext} onClick={() => canNext && onSeq(seq + 1)}>
          下一张 →
        </Btn>
      </div>
      <div className="compare-panes">
        <Pane comicName={comic.comicName} seq={seq} variant="original" onZoom={() => setZoom('original')} />
        <Pane comicName={comic.comicName} seq={seq} variant="translated" onZoom={() => setZoom('translated')} />
      </div>

      {zoom ? (
        <Lightbox
          comicName={comic.comicName}
          seq={seq}
          variant={zoom}
          canPrev={canPrev}
          canNext={canNext}
          onPrev={() => canPrev && onSeq(seq - 1)}
          onNext={() => canNext && onSeq(seq + 1)}
          onClose={() => setZoom(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 删除确认弹窗。
 *
 * 勾选框默认**不勾**：不勾 = 只从漫画库移除（目录原样保留，之后可在「已隐藏」里恢复）；
 * 勾上才连本地目录一起删。默认落在"破坏性更小"的那一侧。
 */
function DeleteComicModal({
  comic,
  busy,
  onCancel,
  onConfirm,
}: {
  comic: ComicEntry;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (deleteFiles: boolean) => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  return (
    <div className="modal-mask" onClick={busy ? undefined : onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">删除「{comic.comicName}」</div>
        <div className="modal-body">
          这会把该漫画从漫画库里移除。目录位置：
          <div className="pathpreview" style={{ margin: '6px 0 10px' }}>
            {comic.outputDir}
          </div>
          <label className="ckrow">
            <input
              type="checkbox"
              className="ck"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
            />
            <span>同时删除本地文件（连漫画目录一起删除）</span>
          </label>
          {deleteFiles ? (
            <div className="modal-warn">⚠️ 本地文件会被永久删除，无法恢复。</div>
          ) : (
            <div className="modal-hint">不勾选则只从库里隐藏，本地文件原样保留，之后可恢复。</div>
          )}
        </div>
        <div className="modal-actions">
          <Btn kind="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Btn>
          <Btn kind="danger" onClick={() => onConfirm(deleteFiles)} disabled={busy}>
            确认删除
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * 「已隐藏」管理弹窗。
 *
 * 为什么必须有：删除时若不勾"删本地文件"，目录还在、扫描就会再扫到它，
 * 所以只能另存一份忽略名单（`state/hidden-comics.json`）。**没有这个入口，
 * 被隐藏的漫画就等于凭空消失且无法找回** —— 只做隐藏不给恢复，是个死胡同。
 */
function HiddenComicsModal({
  hidden,
  busy,
  onClose,
  onUnhide,
}: {
  hidden: string[];
  busy: boolean;
  onClose: () => void;
  onUnhide: (name: string) => void;
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">已隐藏的漫画</div>
        <div className="modal-body">
          这些漫画的**目录还在磁盘上**，只是被「删除（未勾选删除本地文件）」从库里隐藏了。
          点「恢复」即可让它们重新出现。
          <div className="hidden-list">
            {hidden.map((name) => (
              <div key={name} className="hidden-row">
                <span className="hidden-name" title={name}>
                  {name}
                </span>
                <Btn kind="ghost" size="sm" disabled={busy} onClick={() => onUnhide(name)}>
                  恢复
                </Btn>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <Btn kind="primary" onClick={onClose}>
            完成
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * 画面 X-D1 · 本地漫画库（《02》§5.5）。
 *
 * 左栏 260 以漫画名为索引（目录即索引，不维护第二份），右栏为头行 + 110×165 网格卡。
 * 「继续翻译」走契约外增量的 `POST /library/{name}/resume`（spec-notes G-07）：
 * 它只补「有原图、缺译文」的页，且**不新增编号、不覆盖原图**。
 *
 * ## 本屏较原型的增量（保真度之外的可用性补充）
 * · **搜索**：左栏按漫画名模糊匹配（子序列、不区分大小写，见 util `fuzzyMatch`）。
 * · **分页**：左栏 + 网格各一套分页 —— 漫画可能上百部，单部漫画也可能上千页。
 * · **删除**：`POST /library/{name}/delete`，带勾选框决定是否连本地目录一起删。
 * · **刷新**：手动刷新按钮（翻译完成后的自动刷新由 App 的"任务收尾"信号负责）。
 * · **全屏看图**：点对照视图里任一张图。
 */
export function LibraryScreen({
  lib,
  onRefresh,
  onToast,
  refreshKey,
}: {
  lib: LibraryResponse | null;
  onRefresh: () => void;
  onToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
  refreshKey: number;
}): ReactElement {
  const [active, setActive] = useState<string | null>(null);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // 搜索 / 分页 / 删除 / 隐藏管理
  const [query, setQuery] = useState('');
  const [libPage, setLibPage] = useState(1);
  const [gridPage, setGridPage] = useState(1);
  const [toDelete, setToDelete] = useState<ComicEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [unhiding, setUnhiding] = useState(false);

  const comics = lib?.comics ?? [];
  const hidden = lib?.hidden ?? [];

  const filtered = useMemo(() => comics.filter((c) => fuzzyMatch(c.comicName, query)), [comics, query]);
  const libPages = pageCount(filtered.length, LIB_PAGE_SIZE);
  // 行数变少（搜索结果变窄 / 删完一部）→ 把页码夹回合法区间，否则停在空白页
  useEffect(() => {
    setLibPage((p) => (p > libPages ? libPages : p));
  }, [libPages]);
  // 换搜索词从头看
  useEffect(() => {
    setLibPage(1);
  }, [query]);
  const libRows = useMemo(() => pageSlice(filtered, libPage, LIB_PAGE_SIZE), [filtered, libPage]);

  // 当前选中：优先沿用 active；它被搜索滤掉时落到第一项。搜索结果为空则无选中。
  const current = useMemo(() => {
    if (filtered.length === 0) return null;
    return filtered.find((c) => c.comicName === active) ?? libRows[0] ?? filtered[0] ?? null;
  }, [filtered, active, libRows]);

  // 切库或刷新后，若当前选中的漫画没了就回到第一本
  useEffect(() => {
    if (current && current.comicName !== active) setActive(current.comicName);
  }, [current, active]);

  // 换一部漫画 → 网格回到第一页
  useEffect(() => {
    setGridPage(1);
  }, [current?.comicName]);

  const seqMax = current?.seqMax ?? 0;
  const gridPages = pageCount(seqMax, GRID_PAGE_SIZE);
  useEffect(() => {
    setGridPage((p) => (p > gridPages ? gridPages : p));
  }, [gridPages]);
  const gridSeqs = useMemo(
    () => pageSlice(Array.from({ length: seqMax }, (_, i) => i + 1), gridPage, GRID_PAGE_SIZE),
    [seqMax, gridPage],
  );

  // 逐页判定用集合，不用张数（G-10）。`?? []` 只是防御：服务由本应用自己拉起，
  // 正常情况下这两个字段一定在；真缺了也只是退化成「全部待译」，不会白屏。
  const translatedSeqs = useMemo(() => new Set(current?.translatedSeqs ?? []), [current]);
  const missingSeqs = useMemo(() => new Set(current?.missingSeqs ?? []), [current]);

  // 选中漫画后拉一次「缺页清单」，用于给「继续翻译」置灰 / 显示待续做张数
  useEffect(() => {
    if (!current) {
      setPending(null);
      return;
    }
    let alive = true;
    apiGet<{ pendingCount: number }>(`/library/${encodeURIComponent(current.comicName)}/resume`)
      .then((p) => {
        if (alive) setPending(p.pendingCount);
      })
      .catch((e: unknown) => {
        // 目录不存在（404）等价于「没有待续做的页」
        if (alive) setPending(isApiError(e) && e.status === 404 ? 0 : null);
      });
    return () => {
      alive = false;
    };
  }, [current, refreshKey]);

  const resume = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const res = await apiPost<{ comicName: string; queuePosition: number }>(
        `/library/${encodeURIComponent(current.comicName)}/resume`,
        {},
      );
      onToast(`已加入队列：${res.comicName}（第 ${res.queuePosition} 位）`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (deleteFiles: boolean) => {
    const target = toDelete;
    if (!target) return;
    setDeleting(true);
    try {
      const r = await apiPost<LibraryDeleteResponse>(
        `/library/${encodeURIComponent(target.comicName)}/delete`,
        { deleteFiles },
      );
      if (r.deletedFiles) onToast(`已删除「${r.comicName}」及其本地目录`, 'good');
      else onToast(`已从库里移除「${r.comicName}」（本地文件保留，可在「已隐藏」里恢复）`, 'good');
      if (target.comicName === active) setActive(null);
      setCompareSeq(null);
      setToDelete(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setDeleting(false);
    }
  };

  const doUnhide = async (name: string) => {
    setUnhiding(true);
    try {
      await apiPost(`/library/${encodeURIComponent(name)}/unhide`, {});
      onToast(`已恢复「${name}」`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setUnhiding(false);
    }
  };

  if (comics.length === 0 && hidden.length === 0) {
    return (
      <div className="notice">漫画库还是空的。翻译完成后，成品会出现在这里的根目录下。</div>
    );
  }

  if (compareSeq !== null && current) {
    return (
      <Compare comic={current} seq={compareSeq} onSeq={setCompareSeq} onBack={() => setCompareSeq(null)} />
    );
  }

  return (
    <div className="lib">
      <aside
        className="lib-left"
        style={{ width: LIBRARY.leftColumnWidth, flexBasis: LIBRARY.leftColumnWidth }}
      >
        <div className="lib-search">
          <Search size={13} className="lib-search-ico" />
          <input
            className="input lib-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索漫画名…"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="lib-search-clear"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        <div className="lib-left-list">
          {libRows.map((c) => (
            <button
              key={c.comicName}
              type="button"
              className={c.comicName === current?.comicName ? 'lib-item is-active' : 'lib-item'}
              onClick={() => setActive(c.comicName)}
            >
              <span className="lib-item-name" title={c.comicName}>
                {c.comicName}
              </span>
              <span className="lib-item-meta">
                <span className="num">{c.imageCount}</span> 张 · {progressLabel(c)}
              </span>
            </button>
          ))}
          {libRows.length === 0 ? (
            <div className="lib-empty">没有匹配「{query}」的漫画</div>
          ) : null}
        </div>

        <div className="lib-left-foot">
          <span>
            已用容量 <span className="num">{formatBytes(lib?.totalBytes ?? 0)}</span>
          </span>
          {hidden.length > 0 ? (
            <button type="button" className="lib-hidden-link" onClick={() => setShowHidden(true)}>
              <EyeOff size={12} /> 已隐藏 {hidden.length}
            </button>
          ) : null}
        </div>

        {libPages > 1 ? (
          <div className="lib-pager">
            <Btn kind="ghost" size="sm" disabled={libPage <= 1} onClick={() => setLibPage(libPage - 1)}>
              上一页
            </Btn>
            <span className="muted">
              <span className="num">{libPage}</span> / <span className="num">{libPages}</span>
            </span>
            <Btn
              kind="ghost"
              size="sm"
              disabled={libPage >= libPages}
              onClick={() => setLibPage(libPage + 1)}
            >
              下一页
            </Btn>
          </div>
        ) : null}
      </aside>

      <section className="lib-right">
        {current ? (
          <>
            <div className="lib-head card">
              <div className="lib-head-titles">
                <div className="lib-head-name" title={current.comicName}>
                  {current.comicName}
                </div>
                <div className="lib-head-path" title={current.outputDir}>
                  {current.outputDir}
                </div>
              </div>
              <Btn
                kind="ghost"
                onClick={() => openPath(current.outputDir).catch((e: unknown) => onToast(errorText(e), 'bad'))}
              >
                <FolderUp size={14} />
                打开目录
              </Btn>
              <Btn kind="ghost" onClick={onRefresh} title="重新扫描漫画库">
                <RefreshCw size={14} />
                刷新
              </Btn>
              <Btn kind="ghost" onClick={() => setToDelete(current)} title="从漫画库删除（可选择是否连本地文件一起删）">
                <Trash2 size={14} />
                删除
              </Btn>
              <Btn
                kind="primary"
                disabled={busy || pending === 0}
                title={pending === 0 ? '该漫画没有待续做的页' : `待续做 ${pending ?? '…'} 张`}
                onClick={resume}
              >
                继续翻译{pending ? `（${pending}）` : ''}
              </Btn>
            </div>

            <div className="card lib-grid-wrap">
              <div className="lib-grid">
                {gridSeqs.map((seq) => {
                  const state: GridState = missingSeqs.has(seq)
                    ? 'missing'
                    : translatedSeqs.has(seq)
                      ? 'done'
                      : 'pending';
                  return (
                    <button
                      key={seq}
                      type="button"
                      className="grid-card"
                      style={{
                        width: LIBRARY.card.w,
                        height: LIBRARY.card.h,
                        borderRadius: LIBRARY.card.radius,
                      }}
                      disabled={state === 'missing'}
                      onClick={() => setCompareSeq(seq)}
                      title={
                        state === 'missing'
                          ? `第 ${seq} 页在本机没有原图，无法对照`
                          : `第 ${seq} 页 · 点开看原文 / 译文对照`
                      }
                    >
                      <Thumb comicName={current.comicName} seq={seq} state={state} />
                      <span className="grid-foot">
                        <span className="num">{String(seq).padStart(3, '0')}</span>
                        <span
                          className={state === 'missing' ? 'is-bad' : undefined}
                          title={
                            state === 'done'
                              ? `第 ${seq} 页：本地已有译文`
                              : state === 'pending'
                                ? `第 ${seq} 页：有原图、缺译文 —— 点「继续翻译」可以补`
                                : `第 ${seq} 页：本机没有这一页`
                          }
                        >
                          {GRID_LABEL[state]}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="lib-foot-note">
              <span>
                共 <span className="num">{seqMax}</span> 组
                {gridPages > 1 ? (
                  <>
                    {' · 第 '}
                    <span className="num">{gridPage}</span> / <span className="num">{gridPages}</span> 页
                  </>
                ) : null}
              </span>
              {gridPages > 1 ? (
                <span className="lib-grid-pager">
                  <Btn kind="ghost" size="sm" disabled={gridPage <= 1} onClick={() => setGridPage(gridPage - 1)}>
                    上一页
                  </Btn>
                  <Btn
                    kind="ghost"
                    size="sm"
                    disabled={gridPage >= gridPages}
                    onClick={() => setGridPage(gridPage + 1)}
                  >
                    下一页
                  </Btn>
                </span>
              ) : (
                <span>点任意一格看原文 / 译文对照</span>
              )}
            </div>
          </>
        ) : (
          <div className="notice">没有匹配「{query}」的漫画。换个关键词，或清空搜索。</div>
        )}
      </section>

      {toDelete ? (
        <DeleteComicModal
          comic={toDelete}
          busy={deleting}
          onCancel={() => setToDelete(null)}
          onConfirm={(deleteFiles) => void confirmDelete(deleteFiles)}
        />
      ) : null}

      {showHidden ? (
        <HiddenComicsModal
          hidden={hidden}
          busy={unhiding}
          onClose={() => setShowHidden(false)}
          onUnhide={(name) => void doUnhide(name)}
        />
      ) : null}
    </div>
  );
}
