import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronDown, EyeOff, FolderUp, RefreshCw, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { apiBytes, apiGet, apiPost, errorText, isApiError, openPath } from '@/ipc';
import { LIBRARY } from '@/theme/tokens';
import type {
  ComicEntry,
  LibraryDeleteResponse,
  LibraryResponse,
  RetranslatePlan,
  RetranslateResponse,
  TaskRow,
} from '@/types';
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

/** 缩放范围（%）：下限 100%（=原尺寸，不再缩小）、上限 200% */
const ZOOM_MIN = 100;
const ZOOM_MAX = 200;

/** 滚轮一步的"档位"：按钮点一次 / 键盘按一下都是这么多；滚轮则按此换算成比例 */
const ZOOM_STEP = 25;

/**
 * 滚轮 → 缩放比例的换算系数。
 *
 * ## 为什么必须是**指数**而不是加 ZOOM_STEP
 * 一次 `wheel` 事件的 `deltaY` 跨度极大，取决于设备：
 *   · 鼠标滚轮一格 = ±100（Windows/WebView2 实测口径）
 *   · 触控板双指滑动 = 每帧几 px 的**连续小值**，一滑几十帧
 * 若按"每事件 +25%"硬加，触控板一滑就直接顶到 200%（甚至因为惯性余波反复触顶）。
 * 指数式 `z' = z · (1 + deltaY·k)` 让**总增量只取决于滚动总距离**，与事件帧数无关 ——
 * 鼠标一格与触控板"滑同样距离"得到同样的结果。
 *
 * 系数 0.0015 的来由：鼠标一格（100px）≈ +15%，从 100% 到 200% 约需 5 格，
 * 落在"几格就够看清细节、又不至于一路点到顶"的区间。
 */
const ZOOM_WHEEL_K = 0.0015;

/** 把缩放夹进 [100, 200]，并按 1% 取整（滚轮是连续量，不再对齐到 25 的整数倍） */
function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)));
}

/**
 * 全屏看图（零依赖自绘，拍板：不为此引第三方 lightbox）。
 *
 * 为什么自己写：需求只有"铺满屏幕看一张图 + Esc/点击空白关闭 + 左右翻页"这四件，
 * 一个 `position:fixed` 遮罩就够了；引一个组件库反而要多带一层样式重置与主题覆盖，
 * 与项目"零 Context、少依赖"的既有裁定相悖（《09》§2）。
 *
 * 关键交互：**Esc 关闭全屏而不是退出对照** —— 由 `Compare` 统一裁决（见那里的说明）。
 *
 * ## 缩放（Ctrl/⌘ + 滚轮，100%–200%）
 *
 * ### 为什么是滚轮而不是 ↑/↓
 * 全局 `useMusicHotkeys` 占着裸 `↑/↓`（调音量）；虽然它对带 Ctrl/⌘ 的一律 return、
 * 不构成真冲突，但**方向键缩放与"方向键=音量"的心智模型是两套**（音量在右上、
 * 缩放在全屏浮层，撞在一起只会让人犹豫）。滚轮是看图工具的通用语言，且**天然带位置信息**。
 *
 * ### 为什么判据是 `ctrlKey || metaKey` 而不是分平台
 * Windows 用户按 Ctrl、Mac 用户按 ⌘，落到事件上分别是 `ctrlKey` 与 `metaKey`。
 * 写成同一个判据，用户不用记"我这台机器该按哪个"；反正两类修饰键都不会撞上系统手势
 * （macOS 的 Mission Control 是 **Ctrl**+↑/↓ 与双指上推，不是 ⌘+滚轮）。
 *
 * ### 为什么必须自己挂非 passive 监听器
 * React 的 `onWheel` 是**被动（passive）**监听 —— 在里面调 `preventDefault()` 无效，
 * 且控制台刷 "Unable to preventDefault inside passive event listener" 警告。
 * 本组件已在 `PlayerBar.tsx` 踩过这个坑并留了注释。缩放要吃掉滚轮（否则页面会跟着滚），
 * 只能 `addEventListener('wheel', h, { passive: false })` 自己挂 —— 见下面那个 useEffect。
 *
 * ### 为什么用指数缩放而不是固定步长
 * 鼠标一格 `deltaY ≈ 100`，触控板双指是每帧几 px 的连续小值（一滑几十帧）。
 * 固定步长会让触控板"一滑就顶到上限"。指数式让总增量只取决于**滚动总距离**，
 * 与帧数无关 ⇒ 两种设备手感一致。系数见 `ZOOM_WHEEL_K`。
 *
 * ### 为什么必须**锚点缩放**
 * 缩放要围绕**光标所在的那一点**进行，而不是图片中心。
 * 中心缩放的实际观感是"图总往中间跳"：想看右上角的字，滚一下它就滑回视野中央，
 * 得反复滚。锚点缩放才符合所有看图工具的手感。
 * 算式（把光标点的"图内坐标"在缩放前后保持不变）：
 *   旧：p = (a - o) / s        a=光标相对 stage 中心，o=旧偏移，s=旧比例
 *   新：o' = a - p · s'         ⇒ o' = a - (a - o) · s'/s
 *
 * ## 平移：拖拽（Pointer Events）+ 双指滚动（滚轮）
 * **拖拽**用 Pointer Events 而非 `mousedown/touchstart` 三件套：一次监听同时覆盖
 * 鼠标、触屏、触控板（macOS 与 Windows 的事件模型在这里是同一套）；
 * 再配 `touch-action: none` 阻止移动端浏览器的默认平移手势 —— 否则触屏上拖动会
 * 变成"整页跟着滚"，图片纹丝不动。
 *
 * **双指滚动**（放大态下不带 Ctrl 的滚轮）映射成平移：这是 macOS 用户拖完图之后
 * 调整视野的肌肉记忆（触控板上"拖"要按住不动，"滑"才是连续的），比拖拽顺手得多。
 * ⚠️ 只在**放大态**下生效 —— 100% 时图就那么大，没有可平移的余量，
 * 此时若吞掉滚轮，用户会觉得"滚轮失灵了"。
 *
 * 偏移量按**指针位移**累加，而不是换算成绝对坐标 —— 缩放变化后图片尺寸变了，
 * 绝对坐标会让"松手位置"和"指针位置"错开，出现图突然跳一下。
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
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [barHidden, setBarHidden] = useState(false);
  // 拖拽过程用 ref 记，不进 state：指针每动一动就 setState 会把组件重渲染到拖不动
  const drag = useRef<{ active: boolean; px: number; py: number; moved: boolean } | null>(null);
  // 锚点缩放要在**同一次事件**里同时算出 zoom 与 offset，而 setState 是异步的
  // （拿到的 zoom 还是旧值）。故镜像一份进 ref，滚轮这类高频输入直接读它。
  const view = useRef({ zoom: ZOOM_MIN, offset: { x: 0, y: 0 } });
  // 锚点缩放要量"光标相对 stage 中心"的距离，故得拿到 stage 元素
  const stageRef = useRef<HTMLDivElement | null>(null);

  /** 单一写入口：同时更新 ref 镜像与 state，避免两者漂移 */
  const applyView = (nextZoom: number, nextOffset: { x: number; y: number }) => {
    view.current = { zoom: nextZoom, offset: nextOffset };
    setZoom(nextZoom);
    setOffset(nextOffset);
  };

  /**
   * 围绕**光标所在点**缩放（滚轮路径专用）。
   *
   * 算式见文件头「为什么必须锚点缩放」：`o' = a - (a - o) · s'/s`，
   * 其中 `a` 是光标相对 stage 中心的偏移量。
   *
   * ⚠️ 必须拿到 **stage** 的矩形而不是图片的：图片本身被 `scale` 变换过，
   * 它的 `getBoundingClientRect()` 返回的是**变换后**的框，算出来的 `a` 是错的。
   * stage 是 `display:grid; place-items:center` 的未变换容器，中心即图片中心（100% 时）。
   */
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const stage = stageRef.current;
    const cur = view.current;
    const next = clampZoom(cur.zoom * factor);
    // 已经顶到上/下限：连偏移一起归位（回到 100% 时就该重新居中）
    if (next === cur.zoom && (cur.zoom === ZOOM_MIN || cur.zoom === ZOOM_MAX)) {
      if (cur.offset.x !== 0 || cur.offset.y !== 0) applyView(next, { x: 0, y: 0 });
      return;
    }
    if (!stage) {
      applyView(next, { x: 0, y: 0 });
      return;
    }
    const rect = stage.getBoundingClientRect();
    const ax = clientX - (rect.left + rect.width / 2);
    const ay = clientY - (rect.top + rect.height / 2);
    const k = next / cur.zoom;
    applyView(next, { x: ax - (ax - cur.offset.x) * k, y: ay - (ay - cur.offset.y) * k });
  };

  /**
   * 滚轮：**非 passive** 手动监听器（React 的 `onWheel` 是被动的，`preventDefault` 无效）。
   *
   * 三条分支：
   *   1. Ctrl/⌘ + 滚轮      → 以光标为锚点缩放
   *   2. 放大态 + 裸滚轮     → 平移（macOS 触控板双指滑动的肌肉记忆）
   *   3. 其余               → 放行不拦（100% 时的裸滚轮仍可滚页面，别让人以为失灵）
   */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // 必须拦：否则页面跟着滚，而且 Mac 上 ⌘+滚轮可能被系统/浏览器当成页面缩放
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, 1 + e.deltaY * ZOOM_WHEEL_K);
        return;
      }
      if (view.current.zoom > ZOOM_MIN) {
        // 平移也要拦：不拦的话遮罩内容不多，滚轮会连带把下层页面滚走
        e.preventDefault();
        const cur = view.current;
        applyView(cur.zoom, { x: cur.offset.x - e.deltaX, y: cur.offset.y - e.deltaY });
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
    // ⚠️ `zoomAt`/`applyView` 每次渲染都是新函数，但它们只读 ref、只调 setState，
    //    放空依赖数组即可 —— 挂了又放会丢事件（两次监听器重叠 ⇒ 一次滚轮缩放两次）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换页后缩放与偏移一并复位：新图不该继承上一张的放大倍数
  useEffect(() => {
    applyView(ZOOM_MIN, { x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, variant]);

  const onPointerDown = (e: React.PointerEvent) => {
    // 只响应主键 / 单指；右键与多指交给系统（macOS 上右键常被唤出菜单）
    if (e.button !== 0) return;
    drag.current = { active: true, px: e.clientX, py: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !d.active) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return; // 抖动阈值：区分"点击"与"拖拽"
    d.moved = true;
    d.px = e.clientX;
    d.py = e.clientY;
    const cur = view.current;
    applyView(cur.zoom, { x: cur.offset.x + dx, y: cur.offset.y + dy });
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // 纯点击（没移动过）⇒ 当成"显示/隐藏底部工具栏"；拖过就不触发，避免拖完顺手把工具栏也关了
    if (d && !d.moved) setBarHidden((v) => !v);
  };

  /**
   * 按钮用：**以图片中心**为锚点按固定步长缩放（不是光标锚点）。
   *
   * 为什么按中心：按钮点的是工具栏，此时光标在按钮上、根本不在图上，
   * "以光标为锚点"会让图朝按钮方向猛冲一段。同时回退到 100% 时偏移归零。
   */
  const stepZoom = (dir: 1 | -1) => {
    const cur = view.current;
    const next = clampZoom(dir > 0 ? cur.zoom + ZOOM_STEP : cur.zoom - ZOOM_STEP);
    applyView(next, next === ZOOM_MIN ? { x: 0, y: 0 } : cur.offset);
  };

  const zoomed = zoom > ZOOM_MIN;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="全屏查看">
      <div className="lightbox-stage" ref={stageRef} onClick={(e) => e.stopPropagation()}>
        {blob.kind === 'ready' ? (
          <img
            src={blob.url}
            alt={`第 ${seq} 页${label} 全屏`}
            draggable={false}
            className={zoomed ? 'is-zoomed' : undefined}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom / 100})` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            title={zoomed ? '拖动或双指滑动可调整显示区域 · 点一下隐藏工具栏' : 'Ctrl/⌘ + 滚轮缩放 · 点一下隐藏工具栏'}
          />
        ) : (
          <span className="lightbox-msg">{blob.kind === 'loading' ? '加载中…' : '该侧文件缺失'}</span>
        )}
      </div>

      {/* 隐藏后留一条极窄的提示带：否则用户不知道还能点回来 */}
      {barHidden ? <div className="lightbox-hint">点图显示工具栏</div> : null}

      {!barHidden ? (
        <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
          <span className="compare-seq">
            <span className="num">{seq}</span>
            <span> / </span>
            <span className="muted">· {label} · </span>
            <span className="muted">{comicName}</span>
          </span>
          {/*
            缩放控件：− / 百分比 / + 三段。
            ⚠️ 这条是**不依赖任何手势**的保底路径 —— 触控板捏合在 macOS 上被 WebKit
            自己吃掉成页面缩放，Tauri 没有任何开关能关掉它（wry 的 macOS 后端根本没接
            `zoom_hotkeys_enabled`），所以绝不能把缩放只做成手势。
          */}
          <span className="lightbox-zoom" title="Ctrl/⌘ + 滚轮缩放（100%–200%）">
            <button
              type="button"
              className="lightbox-zoom-btn"
              onClick={() => stepZoom(-1)}
              disabled={zoom <= ZOOM_MIN}
              aria-label="缩小"
            >
              <span aria-hidden="true">−</span>
            </button>
            <span className="num">{zoom}%</span>
            <button
              type="button"
              className="lightbox-zoom-btn"
              onClick={() => stepZoom(1)}
              disabled={zoom >= ZOOM_MAX}
              aria-label="放大"
            >
              <span aria-hidden="true">+</span>
            </button>
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
      ) : null}

      <button type="button" className="lightbox-x" onClick={onClose} aria-label="关闭全屏">
        <X size={18} />
      </button>
    </div>
  );
}

/**
 * 「操作」下拉按钮。
 *
 * 为什么自己写而不是用现成的 `Select`：`Select` 是**表单控件**（有当前值、选中即回调、
 * 需要受控 value），这里是**命令菜单**（点了就执行、没有"当前选中项"）。
 * 两者交互模型不同，硬套会让下拉里出现"高亮着但其实没选中"的误导态。
 *
 * 关闭时机三条（缺一条都会留下明显 bug）：
 *  · 点外部 —— `mousedown` **捕获阶段**监听（`SongMenu` 同一手法：用 mousedown 而非 click，
 *    否则触发菜单的那个 click 会顺着冒泡把刚打开的菜单又关掉）；
 *  · Esc —— 交给上层 `Compare` 的键盘监听统一裁决，避免两处都抢 Esc；
 *  · 选完一项 —— 由调用方在回调里关。
 */
function ActionMenu({
  label,
  disabled,
  badge,
  children,
}: {
  label: string;
  disabled?: boolean;
  /** 触发按钮右侧的小标记（当前用它显示「返工中」） */
  badge?: string;
  children: (close: () => void) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    /**
     * Esc 收下拉，且**只**收下拉。
     *
     * 为什么不在这里 `stopPropagation`：上层 `Compare` 也监听 Esc（用来退出对照），
     * 掐断传播会让"Esc 退出对照"整体失灵；而这里 `e.preventDefault()` 语义上不对
     * （Esc 本来没有默认行为要拦），所以**两者都做**：只 `stopPropagation`，
     * 让下拉吃掉这一次 Esc，上层收不到就不会顺带退出对照。
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="actionmenu" ref={box}>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={disabled ? '当前有该漫画的任务在跑，不能再返工' : '对这本漫画执行操作'}
      >
        {label}
        {badge ? <span className="actionmenu-badge">{badge}</span> : null}
        <ChevronDown size={13} className={open ? 'is-open' : undefined} />
      </button>
      {open ? (
        <div className="actionmenu-pop" role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
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
  retranslate,
  submitting,
  onSeq,
  onBack,
  onRetranslate,
}: {
  comic: ComicEntry;
  seq: number;
  /** 该漫画的返工计划（可能还没加载完 → null） */
  retranslate: RetranslatePlan | null;
  /** 返工请求在途（提交中禁用，防连点建出两个任务） */
  submitting: boolean;
  onSeq: (s: number) => void;
  onBack: () => void;
  onRetranslate: (seqs?: number[]) => void;
}) {
  const canPrev = seq > 1;
  const canNext = seq < comic.seqMax;
  const [zoom, setZoom] = useState<'original' | 'translated' | null>(null);
  /** 该漫画是否已有任务在跑（queued/running）—— 有就不能再返工，否则会重复跑同一本 */
  const reworking = retranslate?.reworking ?? false;
  const noOriginal = retranslate !== null && retranslate.retranslateCount === 0;
  const rtBlocked = submitting || reworking || noOriginal;

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
        <ActionMenu
          label="操作"
          disabled={rtBlocked}
          badge={reworking ? '返工中' : undefined}
        >
          {(close) => (
            <>
              <button
                type="button"
                className="actionmenu-item"
                role="menuitem"
                disabled={rtBlocked}
                onClick={() => {
                  close();
                  onRetranslate();
                }}
                title={
                  submitting
                    ? '返工请求正在提交'
                    : reworking
                      ? '该漫画已有任务在队列中，等它跑完再返工'
                      : noOriginal
                        ? '该漫画目录里没有原图，无从返工'
                        : `重新翻译全部 ${retranslate?.retranslateCount ?? 0} 张（覆盖 ${retranslate?.overwriteCount ?? 0} 张已有译文）`
                }
              >
                <RotateCcw size={13} />
                <span className="actionmenu-label">
                  重新翻译
                  <span className="actionmenu-sub">
                    {submitting
                      ? '提交中…'
                      : reworking
                        ? '返工中'
                        : noOriginal
                          ? '没有原图'
                          : `全部 ${retranslate?.retranslateCount ?? 0} 张 · 覆盖 ${retranslate?.overwriteCount ?? 0} 张`}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="actionmenu-item"
                role="menuitem"
                disabled={rtBlocked}
                onClick={() => {
                  close();
                  onRetranslate([seq]);
                }}
                title={`只重译当前这一页（第 ${seq} 页）`}
              >
                <RotateCcw size={13} />
                <span className="actionmenu-label">
                  重新翻译本页
                  <span className="actionmenu-sub">第 {seq} 页</span>
                </span>
              </button>
            </>
          )}
        </ActionMenu>
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
 * · **全屏看图**：点对照视图里任一张图；全屏内 `Ctrl/⌘ + ↑↓` 缩放 100%–200%、
 *   放大后可拖拽，点图可收起/展开底部工具栏。
 * · **返工重译**：`POST /library/{name}/retranslate`，覆盖已有译文（原图永不覆盖）。
 */
export function LibraryScreen({
  lib,
  tasks,
  onRefresh,
  onToast,
  refreshKey,
}: {
  lib: LibraryResponse | null;
  /** 队列快照，只用来判「该漫画是否已有任务在跑」（→ 显示返工中） */
  tasks: TaskRow[];
  onRefresh: () => void;
  onToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
  refreshKey: number;
}): ReactElement {
  const [active, setActive] = useState<string | null>(null);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // 返工：计划（能不能返工 / 会覆盖几张）+ 提交中
  const [rtPlan, setRtPlan] = useState<RetranslatePlan | null>(null);
  const [rtBusy, setRtBusy] = useState(false);
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

  /**
   * 该漫画是否**已有任务在队列里**（queued / running）。
   *
   * 为什么前端自己算而不是让服务端给：任务列表本来就在 `App` 手里每秒刷新，
   * 服务端再扫一遍 `this.tasks` 是重复劳动。判据用 `dirName`（归一化后的目录名）
   * 而不是 `comicName` —— 库里显示的是原始漫画名，落盘用的是归一化名，两者可能差一个
   * 空格/大小写；拿原始名去比会漏判，于是已经排队的漫画还能再点一次返工，
   * 结果是同一本被两个任务前后脚跑、译文互相覆盖。
   */
  const reworkingComics = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.status === 'queued' || t.status === 'running') set.add(t.normalizedComicName ?? t.comicName);
    }
    return set;
  }, [tasks]);

  // 选中漫画后拉一次返工计划：告诉「操作」菜单能不能点、会覆盖几张
  useEffect(() => {
    if (!current) {
      setRtPlan(null);
      return;
    }
    let alive = true;
    apiGet<RetranslatePlan>(`/library/${encodeURIComponent(current.comicName)}/retranslate`)
      .then((p) => {
        // 把「是否在队列中」一并带上：计划是静态的，任务状态是动态的，分开拿会闪
        if (alive) setRtPlan({ ...p, reworking: reworkingComics.has(p.dirName) });
      })
      .catch((e: unknown) => {
        if (alive) setRtPlan(isApiError(e) && e.status === 404 ? null : null);
      });
    return () => {
      alive = false;
    };
  }, [current, refreshKey, reworkingComics]);

  /**
   * 提交返工重译（`POST /library/{name}/retranslate`）。
   *
   * 覆盖已有译文是**不可逆**的，所以回执必须说清"覆盖了几张"，
   * 而不是笼统报"已加入队列"—— 用户需要知道自己刚覆盖了什么。
   */
  const retranslate = async (seqs?: number[]) => {
    if (!current) return;
    setRtBusy(true);
    try {
      const r = await apiPost<RetranslateResponse>(
        `/library/${encodeURIComponent(current.comicName)}/retranslate`,
        seqs ? { seqs } : {},
      );
      const scope = seqs ? `第 ${seqs.join('、')} 页` : `全部 ${r.retranslateCount} 张`;
      onToast(`已开始返工：${scope}（覆盖 ${r.overwriteCount} 张已有译文）`, 'good');
      setCompareSeq(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setRtBusy(false);
    }
  };

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
      <Compare
        comic={current}
        seq={compareSeq}
        retranslate={rtPlan}
        submitting={rtBusy}
        onSeq={setCompareSeq}
        onBack={() => setCompareSeq(null)}
        onRetranslate={(seqs) => void retranslate(seqs)}
      />
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
