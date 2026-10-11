import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  EyeOff,
  FolderUp,
  GitMerge,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPostMultipart, errorText, isApiError, openPath } from '@/ipc';
import { useToasts } from '@hooks';
import { LIBRARY } from '@/theme/tokens';
import type {
  BookEntry,
  ChapterEntry,
  ComicEntry,
  LibraryDeleteResponse,
  LibraryResponse,
  RetranslatePlan,
  RetranslateResponse,
  TaskRow,
} from '@/types';
import {
  chapterNoOf,
  formatBytes,
  fuzzyMatch,
  groupSearchResults,
  matchIndices,
  pageCount,
  pageSlice,
} from '@tools';
import { useDebouncedValue } from '@hooks/useDebouncedValue';
import { Btn, ContextMenu, IconButton, MenuButton, MenuItem, MenuSeparator, Modal, Notice, Tooltip } from '@components/units';
import {
  bookFirstImagePath,
  chapterFilePath,
  coverPath,
  filePath,
  topLevelFirstImagePath,
  useBlobUrl,
} from '@screens/library/blob';
import type { Variant } from '@screens/library/blob';
import { ChapterCard } from '@screens/library/chapters';
import type { BookMetaIntent } from '@screens/library/modals';
import { EditBookModal, EditChapterNoModal, MergeModal, NewBookModal } from '@screens/library/modals';

/** 左栏每页漫画数（窄栏 + 每项约 48px 高，12 项差不多一屏） */
const LIB_PAGE_SIZE = 12;
/** 网格每页张数（110×165 卡 + 12 间距；24 张约两行多，翻页不至于太空） */
const GRID_PAGE_SIZE = 24;
/**
 * 屏 B 话列表每页话数（设计稿 §7.3 明写 `CHAPTER_PAGE_SIZE = 24`，与 `GRID_PAGE_SIZE` 同值）。
 *
 * 与网格分页同值不是巧合：话卡与页卡是**同一个 110×165 的格子**（设计稿 §7.3「沿用
 * `LIBRARY.card` 令牌，不新增几何」），所以每屏装得下的个数天然相同。两处各写一个数，
 * 迟早出现"话列表 24/页、页网格 30/页"这种没理由的不一致。
 */
const CHAPTER_PAGE_SIZE = 24;

/** 作者为空时的占位文案（设计稿 §7.1 中下 / §7.3 头部卡**同一口径**，故只写一份常量） */
const AUTHOR_FALLBACK = '未署名';

/**
 * 网格卡三态 —— 判定依据是 `/library` 给出的**逐页**集合（`translatedSeqs` / `missingSeqs`），
 * 不是张数。张数只能回答「译了几页」，回答不了「译了哪几页」；缺页落在中间时，
 * 用张数推出来的结论会把后面每一页整体前移一位，见 spec-notes G-10。
 */
type GridState = 'done' | 'pending' | 'missing';

const GRID_LABEL: Record<GridState, string> = { done: '已译', pending: '待译', missing: '缺页' };

/**
 * 一「部」的状态短语。
 *
 * 原先这里只写 `缺 ${imageCount - translatedCount}`，而那个数其实是**没有译文的**页数
 * —— 于是同一屏上冒出两个含义相反的「缺」：左栏说「缺 1」（那一页其实有原图，只是待译），
 * 网格卡说「缺页」（专指**没有原图**）。字面同源、意思不同，正是 G-11 里
 * 「同一张图、两屏两个故事」的翻版。逐页集合（G-10）已经能分开算，就没理由继续含糊。
 *
 * 收参按**结构**而不是 `ComicEntry`：大类、话、未归并单话三者的页级计数同名同义，
 * 逐页判定的口径也只有一个（G-10），没必要为每种来源各写一份。
 */
interface PageCounts {
  imageCount: number;
  translatedCount: number;
  missingSeqs: number[];
}

function progressLabel(c: PageCounts): string {
  if (c.imageCount === 0) return '空目录';
  const missing = c.missingSeqs.length;
  const pending = c.imageCount - c.translatedCount - missing;
  if (pending <= 0 && missing <= 0) return '已译完';
  const parts: string[] = [];
  if (pending > 0) parts.push(`待译 ${pending}`);
  if (missing > 0) parts.push(`缺页 ${missing}`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ 左栏视图件

/**
 * 左栏一项的**展示视图**：大类与未归并单话归一成同一形状，左栏与搜索分组共用。
 *
 * 为什么不直接用 `BookEntry`/`ChapterEntry`：左栏要显示的是「漫画」这一个概念
 * （「N 话 · M 页」），其中大类有作者有封面、未归并单话没有 —— 两个类型各写一条渲染分支
 * 就会长出两套几乎一样的 DOM。归一到 `LibItem` 后只有"取哪些字段"的差别，
 * 而那个差别已经由 `buildItems()` 一次性吸收掉了。
 */
interface LibItem {
  /** 选中态键 = 点击后要选中的 `comicName`（= `comics` 的键，故与既有选中逻辑天然对齐） */
  key: string;
  name: string;
  /** 空串 = 未署名 */
  author: string;
  chapterCount: number;
  pageCount: number;
  /** 缩略图字节路径；`null` = 无图（显示占位） */
  thumbPath: string | null;
  /** 是否大类（决定该项是否参与「编辑信息 / 删除」那套动作） */
  merged: boolean;
}

/**
 * 页网格（屏 A / 屏 C）与对照视图（屏 D）共用的**页集合投影**。
 *
 * 三种来源在此归一：旧口径的整本（`ComicEntry`，顶层取图）、大类里的一话
 * （`ChapterEntry`，话内取图）。没有这条投影，网格就得在自己体内判一遍
 * "我这一格是整本还是话" —— 那个判断只该有一处，就是这里的 `imagePath()` 闭包。
 *
 * 🔴 `imagePath` 返回的路径**必须含「书 + 话 + 页」三段**：路径同时是 `URL_CACHE`
 * 的键（D-117），只按页号做键会让《A》第 1 话第 1 页与《B》第 1 话第 1 页命中
 * 同一条缓存 —— 跨书串图，且是"看起来正常、内容错了"的最难发现的那类缺陷。
 */
interface PageView {
  /** 操作端点基址：`/library/{名}` 或 `/library/{书}/chapters/{话}`（续做 / 返工都挂在它下面） */
  base: string;
  /** 归因显示名（对照头部 / 全屏回显 / Toast）：编码过的目录名不能直接给人看 */
  comicName: string;
  seqMax: number;
  translatedSeqs: number[];
  missingSeqs: number[];
  /** 第 `seq` 页 `variant` 侧的字节路径 */
  imagePath(seq: number, variant: Variant): string;
}

/** 整本 / 未归并单话的投影：取图走**顶层**端点（与旧口径一致） */
function flatViewOf(c: ComicEntry): PageView {
  return {
    base: `/library/${encodeURIComponent(c.comicName)}`,
    comicName: c.comicName,
    seqMax: c.seqMax,
    translatedSeqs: c.translatedSeqs,
    missingSeqs: c.missingSeqs,
    imagePath: (seq, variant) => filePath(c.comicName, seq, variant),
  };
}

/** 大类里一话的投影：取图走**话级**端点（`GET /library/{书}/chapters/{话}/files/{seq}`） */
function chapterViewOf(b: BookEntry, ch: ChapterEntry): PageView {
  // 屏 C 的入口（话卡）对 `no === null` 是禁用的，走到这里话号必在；`?? 0` 只是让类型闭合
  const no = ch.no ?? 0;
  return {
    base: `/library/${encodeURIComponent(b.bookName)}/chapters/${no}`,
    comicName: `${b.bookName} · 第 ${no} 话`,
    seqMax: ch.seqMax,
    translatedSeqs: ch.translatedSeqs,
    missingSeqs: ch.missingSeqs,
    imagePath: (seq, variant) => chapterFilePath(b.bookName, no, seq, variant),
  };
}

/**
 * 封面缩略。
 *
 * `loading` 与 `missing` 都落到占位（`line-soft` 底 + 书名首字，设计稿 §7.1）：
 * 32×44 的小格子里塞「加载中…」比直接显示首字更难看，且缩略图取回来只要几十毫秒。
 * 但 `ready` 与"取不到"必须分开 —— 取不到时**不能**装作还在加载。
 *
 * 尺寸与圆角由调用方从 `LIBRARY.cover` 传进来（左栏缩略 32×44、详情头 56×76）：
 * 这两个值只差尺寸，各写一份 CSS 规则就会出现"改了一处、另一处还是旧的"。
 */
function CoverThumb({
  path,
  name,
  className,
  w,
  h,
  radius,
}: {
  path: string | null;
  name: string;
  className: string;
  w: number;
  h: number;
  radius: number;
}) {
  const blob = useBlobUrl(path);
  const style = { width: w, height: h, borderRadius: radius };
  if (blob.kind === 'ready') {
    return <img className={className} style={style} src={blob.url} alt="" draggable={false} />;
  }
  return (
    <div className={`${className} is-ph`} style={style} aria-hidden="true">
      {name.slice(0, 1)}
    </div>
  );
}

/**
 * 把 `text` 按命中下标切成「命中 / 未命中」两色片段（命中片段加 `grp-hit`，设计稿 §7.2）。
 *
 * 下标来自 `matchIndices()` —— 与 `fuzzyMatch()` **同一判定**，所以不可能出现
 * "行判为命中却一个字都没高亮"。相连的下标合并成一段，避免一个字一个 `<span>`。
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const idx = matchIndices(text, query);
  if (!idx || idx.length === 0) return <>{text}</>;
  const set = new Set(idx);
  const runs: { hit: boolean; text: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i]!;
    else runs.push({ hit, text: text[i]! });
  }
  return (
    <>
      {runs.map((r, i) =>
        r.hit ? (
          <span key={i} className="grp-hit">
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/**
 * 网格缩略图。三态必须分开，且**只在确实有译文时才发请求** ——
 * 对已知没有译文的页仍去取一次、失败后显示「加载中…」，是把「不存在」伪装成「还没到」。
 *
 * 收 `path`（而不是 `comicName + seq` 自己去拼）：屏 C 的页源可能是大类里的一话
 * （`/library/{书}/chapters/{话}/files/…`），也可能是「其它」里的单话或旧口径的整本
 * （`/library/{名}/files/…`）。让缩略图自己拼路径，就得在这里再判一次"我这一层是话还是整本"
 * —— 那个判断只该有一处（`PageView`）。
 */
function Thumb({ path, seq, state }: { path: string; seq: number; state: GridState }) {
  // hooks 不能条件调用，故把「要不要取」编码进 path（null = 不取）
  const blob = useBlobUrl(state === 'done' ? path : null);
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
  path,
  seq,
  variant,
  onZoom,
}: {
  /** 该页该变体的**字节路径**（由 `PageView.image()` 给出） */
  path: string;
  seq: number;
  variant: Variant;
  onZoom: () => void;
}) {
  const blob = useBlobUrl(path);
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

/** 缩放范围（%）：下限 50%（可以缩得更小看全局）、上限 200% */
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;

/**
 * 「恰好铺满可视区」档 = 100%，也是**打开全屏时的基准档**。
 *
 * 图像在 100% 时由 CSS 收进可视区（`max-width/height:100%` + 容器 flex 居中，
 * 见 `manga.scss` 的 `.lightbox-stage`）⇒ 打开全屏就是**整张可见、不需要滚动**。
 * 由此得到本组比例的语义：< 100% = 比铺满还小；> 100% 才开始溢出，
 * **也只有 > 100% 时才允许平移**（≤ 100% 没有可平移的余量）。
 *
 * ⚠️ 别把它读成"原始像素尺寸"：这里的 100% 是相对**可视区**的，不是 1:1 像素。
 */
const ZOOM_FIT = 100;

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
 * 指数式让**总增量只取决于滚动总距离**，与事件帧数无关 ——
 * 鼠标一格与触控板"滑同样距离"得到同样的结果。
 *
 * 系数 0.0015 的来由：鼠标一格（100px）≈ +15%，从 100% 到 200% 约需 5 格，
 * 落在"几格就够看清细节、又不至于一路点到顶"的区间。
 *
 * ## 方向
 * 取 `z' = z · (1 - deltaY·k)`，是**减号**：滚轮**向上**（deltaY < 0）为**放大**，
 * 与浏览器及所有看图工具一致。写成加号方向就反了 —— 用户看到的是"往上滚反而变小"。
 */
const ZOOM_WHEEL_K = 0.0015;

/** 把缩放夹进 [50, 200]，并按 1% 取整（滚轮是连续量，不再对齐到 25 的整数倍） */
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
 * ## 缩放（Ctrl/⌘ + 滚轮：**向上放大**、向下缩小；50%–200%）
 *
 * ### 100% 是「恰好铺满」档 —— 打开全屏就能看到整张图
 * 图像在 100% 时由 CSS 收进可视区（`max-width/height:100%` + 容器 flex 居中），
 * 所以**默认档就是"整张可见"**，不需要滚动。缩到 50% 能看更全局，放大到 200% 才溢出
 * —— 也只有溢出（> 100%）时才启用平移，见下面「平移」一节。
 * ⚠️ 这里的 100% 是相对**可视区**的，不是原始像素 1:1。
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
 * ⚠️ 只在**放大态**（> 100%）下生效 —— ≤100% 时图已被 CSS 收进可视区，没有平移余量，
 * 此时若吞掉滚轮，用户会觉得"滚轮失灵了"。
 *
 * 偏移量按**指针位移**累加，而不是换算成绝对坐标 —— 缩放变化后图片尺寸变了，
 * 绝对坐标会让"松手位置"和"指针位置"错开，出现图突然跳一下。
 */
function Lightbox({
  path,
  title,
  seq,
  variant,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onClose,
}: {
  /** 该页该变体的**字节路径**（由 `PageView.imagePath()` 给出；路径同时是缓存键，天然含书 + 话） */
  path: string;
  /** 顶部文本回显的**归因名**（`《书》第 N 话` / 漫画名）——路径里是编码后的目录名，不能直接给人看 */
  title: string;
  seq: number;
  variant: Variant;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const blob = useBlobUrl(path);
  const label = variant === 'original' ? '原图' : '译文';
  const [zoom, setZoom] = useState(ZOOM_FIT);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [barHidden, setBarHidden] = useState(false);
  // 拖拽过程用 ref 记，不进 state：指针每动一动就 setState 会把组件重渲染到拖不动
  const drag = useRef<{ active: boolean; px: number; py: number; moved: boolean } | null>(null);
  // 锚点缩放要在**同一次事件**里同时算出 zoom 与 offset，而 setState 是异步的
  // （拿到的 zoom 还是旧值）。故镜像一份进 ref，滚轮这类高频输入直接读它。
  const view = useRef({ zoom: ZOOM_FIT, offset: { x: 0, y: 0 } });
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
   * stage 是 flex 居中（自身未做变换）的容器，中心即图片中心（100% 时）。
   */
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const cur = view.current;
    const next = clampZoom(cur.zoom * factor);
    // 缩回「恰好铺满」及以内（≤100%）：图已被 CSS 收进可视区，没有可平移的余量
    // ⇒ 一律归位居中。留着旧偏移反而会把图推出画面（此时偏移不再是"视口内的相对位移"）。
    if (next <= ZOOM_FIT) {
      if (cur.zoom !== next || cur.offset.x !== 0 || cur.offset.y !== 0) applyView(next, { x: 0, y: 0 });
      return;
    }
    const stage = stageRef.current;
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
        // ⚠️ 减号：滚轮**向上**（deltaY < 0）是**放大**，与浏览器/看图工具一致
        zoomAt(e.clientX, e.clientY, 1 - e.deltaY * ZOOM_WHEEL_K);
        return;
      }
      if (view.current.zoom > ZOOM_FIT) {
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
    applyView(ZOOM_FIT, { x: 0, y: 0 });
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
    applyView(next, next <= ZOOM_FIT ? { x: 0, y: 0 } : cur.offset);
  };

  const zoomed = zoom > ZOOM_FIT;

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
            title={zoomed ? '拖动或双指滑动可调整显示区域 · 点一下隐藏工具栏' : 'Ctrl/⌘ + 滚轮（向上放大）· 点一下隐藏工具栏'}
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
            <span className="muted">{title}</span>
          </span>
          {/*
            缩放控件：− / 百分比 / + 三段。
            ⚠️ 这条是**不依赖任何手势**的保底路径 —— 触控板捏合在 macOS 上被 WebKit
            自己吃掉成页面缩放，Tauri 没有任何开关能关掉它（wry 的 macOS 后端根本没接
            `zoom_hotkeys_enabled`），所以绝不能把缩放只做成手势。
          */}
          <span className="lightbox-zoom" title="Ctrl/⌘ + 滚轮：向上放大、向下缩小（也可点 −/+，50%–200%）">
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

/** 返工菜单项文案：按 提交中 / 返工中 / 无原图 / 计划未就绪 / 正常 取值（避免内联多级三元）。 */
function retranslateMeta(
  plan: RetranslatePlan | null,
  submitting: boolean,
  reworking: boolean,
  noOriginal: boolean,
): { title: string; sub: string; blocked: boolean } {
  if (submitting) return { title: '返工请求正在提交', sub: '提交中…', blocked: true };
  if (reworking) return { title: '该漫画已有任务在队列中，等它跑完再返工', sub: '返工中', blocked: true };
  if (noOriginal) return { title: '该漫画目录里没有原图，无从返工', sub: '没有原图', blocked: true };
  if (!plan) return { title: '正在读取返工计划…', sub: '读取中…', blocked: true };
  return {
    title: `重新翻译全部 ${plan.retranslateCount} 张（覆盖 ${plan.overwriteCount} 张已有译文）`,
    sub: `全部 ${plan.retranslateCount} 张 · 覆盖 ${plan.overwriteCount} 张`,
    blocked: false,
  };
}

/** 继续翻译菜单项文案。 */
function resumeMeta(
  pending: number | null,
  busy: boolean,
): { title: string; sub: string; disabled: boolean } {
  if (busy) return { title: '正在提交…', sub: '提交中…', disabled: true };
  if (pending === 0) return { title: '该漫画没有待续做的页', sub: '没有待续做的页', disabled: true };
  const n = pending ?? '…';
  return { title: `把待译的页加入队列（待续做 ${n} 张）`, sub: `待续做 ${n} 张`, disabled: false };
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
  view,
  seq,
  retranslate,
  submitting,
  onSeq,
  onBack,
  onRetranslate,
}: {
  /** 当前对照的页集合投影（整本或一话 —— 对本组件两者无差别，取图与翻页都走投影） */
  view: PageView;
  seq: number;
  /** 返工计划（可能还没加载完 → null） */
  retranslate: RetranslatePlan | null;
  /** 返工请求在途（提交中禁用，防连点建出两个任务） */
  submitting: boolean;
  onSeq: (s: number) => void;
  onBack: () => void;
  onRetranslate: (seqs?: number[]) => void;
}) {
  const canPrev = seq > 1;
  const canNext = seq < view.seqMax;
  const [zoom, setZoom] = useState<'original' | 'translated' | null>(null);
  /** 该漫画是否已有任务在跑（queued/running）—— 有就不能再返工，否则会重复跑同一本 */
  const reworking = retranslate?.reworking ?? false;
  const noOriginal = retranslate !== null && retranslate.retranslateCount === 0;
  const rt = retranslateMeta(retranslate, submitting, reworking, noOriginal);

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
    if (zoom === 'translated' && !view.translatedSeqs.includes(seq)) setZoom(null);
  }, [zoom, seq, view]);

  return (
    <div className="compare">
      <div className="compare-head card">
        <IconButton title="返回" onClick={onBack}>
          <ArrowLeft size={20} />
        </IconButton>
        <span className="compare-seq">
          <span className="num">{seq}</span>
          <span> / </span>
          <span className="num">{view.seqMax}</span>
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {view.comicName}
        </span>
        <div style={{ flex: 1 }} />
        <Btn kind="ghost" disabled={!canPrev} onClick={() => canPrev && onSeq(seq - 1)}>
          ← 上一张
        </Btn>
        <Btn kind="ghost" disabled={!canNext} onClick={() => canNext && onSeq(seq + 1)}>
          下一张 →
        </Btn>
        <MenuButton
          label="操作"
          disabled={rt.blocked}
          badge={reworking ? '返工中' : undefined}
          title="对这本漫画执行操作"
        >
          {(close) => (
            <>
              <MenuItem
                icon={<RotateCcw size={13} />}
                label="重新翻译"
                sub={rt.sub}
                disabled={rt.blocked}
                title={rt.title}
                onClick={() => {
                  close();
                  onRetranslate();
                }}
              />
              <MenuItem
                icon={<RotateCcw size={13} />}
                label="重新翻译本页"
                sub={`第 ${seq} 页`}
                disabled={rt.blocked}
                title={`只重译当前这一页（第 ${seq} 页）`}
                onClick={() => {
                  close();
                  onRetranslate([seq]);
                }}
              />
            </>
          )}
        </MenuButton>
      </div>
      <div className="compare-panes">
        <Pane path={view.imagePath(seq, 'original')} seq={seq} variant="original" onZoom={() => setZoom('original')} />
        <Pane path={view.imagePath(seq, 'translated')} seq={seq} variant="translated" onZoom={() => setZoom('translated')} />
      </div>

      {zoom ? (
        <Lightbox
          path={view.imagePath(seq, zoom)}
          title={view.comicName}
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
  kind,
  busy,
  onCancel,
  onConfirm,
}: {
  comic: ComicEntry;
  /** 删除口径：大类 = 整本；未归并单话 = 本话（只影响说法，端点是同一个） */
  kind: '整本' | '本话';
  busy: boolean;
  onCancel: () => void;
  onConfirm: (deleteFiles: boolean) => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  return (
    <Modal
      title={<>删除{kind}「{comic.comicName}」</>}
      busy={busy}
      onClose={onCancel}
      actions={
        <>
          <Btn kind="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Btn>
          <Btn kind="danger" onClick={() => onConfirm(deleteFiles)} disabled={busy}>
            确认删除
          </Btn>
        </>
      }
    >
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
    </Modal>
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
    <Modal
      title="已隐藏的漫画"
      onClose={onClose}
      actions={
        <Btn kind="primary" onClick={onClose}>
          完成
        </Btn>
      }
    >
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
    </Modal>
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
 * · **全屏看图**：点对照视图里任一张图。开图即「整张可见」（100% = 恰好铺满，不需滚动）；
 *   全屏内用 `Ctrl/⌘ + 滚轮`（向上放大、向下缩小）或工具栏 −/+ 缩放 50%–200%、
 *   放大后可拖拽或双指滑动平移，点图可收起/展开底部工具栏。
 * · **返工重译**：`POST /library/{name}/retranslate`，覆盖已有译文（原图永不覆盖）。
 */
export function LibraryScreen({
  lib,
  tasks,
  focus,
  onFocusHandled,
  newBookSignal,
  onNewBookHandled,
  onRefresh,
  refreshKey,
}: {
  lib: LibraryResponse | null;
  /** 队列快照，只用来判「该漫画是否已有任务在跑」（→ 显示返工中） */
  tasks: TaskRow[];
  /** 队列行「查看」带过来的漫画名：进入本屏后选中并翻到它那一页（消费一次即回调清空） */
  focus?: string | null;
  onFocusHandled?: () => void;
  /**
   * 工具条「新建漫画」按下的一次性信号。
   *
   * 为什么用信号而不是把弹窗 state 抬到 App：按钮长在 App 的工具条里，而弹窗的提交
   * 要 `onRefresh()`、要 `setActive()` —— 那些都在本屏。抬 state 上去等于把"漫画库的
   * 三个弹窗"劈成两半；信号只传"按过了"这一个事实，消费一次即清（与 `focus` 同构）。
   */
  newBookSignal?: boolean;
  onNewBookHandled?: () => void;
  onRefresh: () => void;
  refreshKey: number;
}): ReactElement {
  // 吐司单例总线：直接取用，不必由宿主透传（见 useToasts 注释）
  const { push: onToast } = useToasts();
  const [active, setActive] = useState<string | null>(null);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // 返工：计划（能不能返工 / 会覆盖几张）+ 提交中
  const [rtPlan, setRtPlan] = useState<RetranslatePlan | null>(null);
  const [rtBusy, setRtBusy] = useState(false);
  // 搜索 / 分页 / 删除 / 隐藏管理
  // 输入框受控值是原始态（保证按键即时回显），过滤用防抖后的值 —— 见 filtered 下方注释
  const [queryInput, setQueryInput] = useState('');
  const query = useDebouncedValue(queryInput, 200);
  const [libPage, setLibPage] = useState(1);
  const [gridPage, setGridPage] = useState(1);
  /**
   * 屏 C 正在看的**话号**（`null` = 不在话内）。仅当当前选中是大类时才有意义：
   * 未归并单话没有话，右栏直接是页网格（屏 A）。
   */
  const [chapterNo, setChapterNo] = useState<number | null>(null);
  /** 屏 B（话列表）的分页；与页网格分页各自独立 —— 两屏来回翻页互不干扰 */
  const [chPage, setChPage] = useState(1);
  /**
   * 待删除的目标 + **删除口径**（大类 = 删除整本；未归并单话 = 删除本话）。
   *
   * 两种口径走的是同一个端点（`POST /library/{name}/delete`，主语都是顶层目录），
   * 分开的只是**说法** —— 单话没有"整本"可言，话都删了当然就是删这一话；
   * 弹窗标题跟着口径走，否则用户在删单话时看到「删除整本」会以为自己删多了。
   */
  const [toDelete, setToDelete] = useState<{ comic: ComicEntry; kind: '整本' | '本话' } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [unhiding, setUnhiding] = useState(false);
  // 三个新增弹窗：新建 / 编辑信息 / 归并（各自一个"是否打开"+ 一个提交中标记）
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [editBook, setEditBook] = useState<BookEntry | null>(null);
  /** 归并弹窗的**源目录名**（左栏单话 / 右键菜单「归并到」共用这一个入口） */
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  /** 编辑话数弹窗：改某本已归并话的话号（话卡菜单入口） */
  const [editNoChapter, setEditNoChapter] = useState<{ bookName: string; chapter: ChapterEntry } | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [merging, setMerging] = useState(false);
  const [renumbering, setRenumbering] = useState(false);
  /**
   * 右键菜单（漫画操作的家）：记录**被右键的那一项**与弹出坐标。
   *
   * 头部按钮只留「刷新」之后，打开目录 / 续做 / 返工 / 编辑信息 / 删除这些动作全部
   * 迁到这里 —— 右键的是**哪一项就操作哪一项**，与"当前选中"无关（右键不改选中，
   * 这是文件管理器的通用惯例；混在一起会出现"右键 A 却删了 B"的事故）。
   */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: LibItem } | null>(null);
  /** 搜索态里被收起的**分组键**集合（设计稿 §7.2：折叠不跨搜索保留，见下方 effect） */
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => new Set());

  const comics = lib?.comics ?? [];
  const hidden = lib?.hidden ?? [];
  const books = lib?.books ?? [];
  const others = lib?.others ?? [];

  /**
   * 服务端是否给了分层数据（`books` / `others`）。
   *
   * 旧服务端只回 `comics`。没有这条兜底，升级到新版面前端的用户会看到**空左栏**
   * —— 那看起来像"漫画全丢了"，而实际只是少了一个字段。
   */
  const hasLayers = books.length > 0 || others.length > 0;

  /**
   * 左栏（浏览态）的行数据。
   *
   * 排序按 `key`（= 目录名，`zh-Hans-CN`）—— 与服务端对 `comics` 的排序**同一口径**，
   * 于是左栏顺序与前端的"上一页 / 下一页"、`focus` 定位的行号计算仍然一致。
   */
  const items = useMemo<LibItem[]>(() => {
    const build: LibItem[] = hasLayers
      ? [
          ...books.map<LibItem>((b) => ({
            key: b.bookName,
            name: b.bookName,
            author: b.author,
            chapterCount: b.chapterCount,
            pageCount: b.totalPages,
            // 有封面用封面，没有就退回首话首图（设计稿 §7.1 左）
            thumbPath: b.coverPath
              ? coverPath(b.bookName, b.modifiedAt)
              : bookFirstImagePath(b.bookName, b.chapters),
            merged: true,
          })),
          ...others.map<LibItem>((o) => ({
            key: o.dirName,
            name: o.dirName,
            // 未归并单话没有 manifest ⇒ 没有作者（显示「未署名」）
            author: '',
            chapterCount: 1,
            pageCount: o.imageCount,
            thumbPath: topLevelFirstImagePath(o.dirName, o),
            merged: false,
          })),
        ]
      : comics.map<LibItem>((c) => ({
          key: c.comicName,
          name: c.comicName,
          author: '',
          chapterCount: 1,
          pageCount: c.imageCount,
          thumbPath: topLevelFirstImagePath(c.comicName, c),
          merged: false,
        }));
    return build.sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'));
  }, [hasLayers, books, others, comics]);

  const searching = query.trim().length > 0;

  /**
   * 搜索态（屏 A′）的分组结果。
   *
   * 只在有分层数据时按「本 → 话」分组；否则退回按 `comics` 平铺过滤 ——
   * 分组的前提是有「话」，旧服务端给不出话，硬分组只会得到一堆空组。
   */
  const searchGroups = useMemo(
    () => (searching && hasLayers ? groupSearchResults(books, others, query) : []),
    [searching, hasLayers, books, others, query],
  );
  /** 无分层的旧服务端：搜索态仍是平铺过滤（与改造前的行为一致） */
  const flatHits = useMemo(
    () => (searching && !hasLayers ? items.filter((it) => fuzzyMatch(it.name, query)) : []),
    [searching, hasLayers, items, query],
  );

  // 逐键过滤很便宜，但过滤会改 `current`，进而重挂载右栏网格、重拉整页缩略图。
  // 故喂给过滤的是**防抖后的 query**：连续输入期间只回显、不级联，停手 200ms 才过滤一次。
  const filtered = useMemo(() => comics.filter((c) => fuzzyMatch(c.comicName, query)), [comics, query]);
  const libPages = pageCount(filtered.length, LIB_PAGE_SIZE);
  // 行数变少（搜索结果变窄 / 删完一部）→ 把页码夹回合法区间，否则停在空白页
  useEffect(() => {
    setLibPage((p) => (p > libPages ? libPages : p));
  }, [libPages]);
  // 换搜索词从头看（分组折叠也一并复位：设计稿 §7.2 要求「折叠状态不跨搜索保留」）
  useEffect(() => {
    setLibPage(1);
    setFoldedGroups(new Set());
  }, [query]);
  const libRows = useMemo(() => pageSlice(filtered, libPage, LIB_PAGE_SIZE), [filtered, libPage]);

  /**
   * 外部定位（队列行「查看」带来的 `focus`）。
   *
   * 三步缺一不可：① 选中该漫画；② 清掉搜索词（否则它可能被当前过滤条件滤掉，选中即失效）；
   * ③ 把左栏翻到它所在的那一页（否则高亮落在一页之外的列表上，看着像"没定位"）。
   * 消费一次即 `onFocusHandled()`，上层据此清空 focus —— 否则之后每次手动浏览都会被拉回来。
   *
   * 依赖只写 `focus`：这是"一次性的定位指令"，取挂载/变更当帧的 `filtered` 快照即可。
   */
  useEffect(() => {
    if (!focus) return;
    const idx = filtered.findIndex((c) => c.comicName === focus || c.dirName === focus);
    if (idx >= 0) {
      setActive(filtered[idx]!.comicName);
      setQueryInput('');
      setLibPage(Math.floor(idx / LIB_PAGE_SIZE) + 1);
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /**
   * 工具条「新建漫画」→ 开弹窗。
   *
   * 与 `focus` 同构的一次性信号：消费一次即回调清空，否则之后每次重挂载都会自动弹出来。
   * 这里**不**清搜索词也不改选中态 —— 新建成功后由 `createBook()` 自己去选中新项。
   */
  useEffect(() => {
    if (!newBookSignal) return;
    setNewBookOpen(true);
    onNewBookHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newBookSignal]);

  // 当前选中：优先沿用 active；它被搜索滤掉时落到第一项。搜索结果为空则无选中。
  const current = useMemo(() => {
    if (filtered.length === 0) return null;
    return filtered.find((c) => c.comicName === active) ?? libRows[0] ?? filtered[0] ?? null;
  }, [filtered, active, libRows]);

  // 切库或刷新后，若当前选中的漫画没了就回到第一本
  useEffect(() => {
    if (current && current.comicName !== active) setActive(current.comicName);
  }, [current, active]);

  /**
   * 当前选中的**大类**；选中的是未归并单话时为 `null`。
   *
   * 「编辑信息」只对大类成立 —— 未归并单话在磁盘上没有 `manifest.json`，
   * 拿它去调 `POST /meta` 会被 `resolveBookDir` 以 404 拒绝。置灰比"点了才被拒"好。
   */
  const currentBook = useMemo(
    () => books.find((b) => b.bookName === (current?.comicName ?? '')) ?? null,
    [books, current],
  );

  // 换一部漫画 → 话内定位与两套分页一并归零（话号留着会指向另一部的话，必清）
  useEffect(() => {
    setChapterNo(null);
    setGridPage(1);
    setChPage(1);
  }, [current?.comicName]);
  // 换一话 → 页网格回第一页
  useEffect(() => {
    setGridPage(1);
  }, [chapterNo]);

  /**
   * 当前选中的**话**（屏 C 的数据源）。话号在但话没了（刷新后目录被动过）⇒ `null`，
   * 调用方按「不在话内」处理、退回屏 B —— 而不是白屏。
   */
  const currentChapter = useMemo(
    () =>
      currentBook && chapterNo !== null
        ? currentBook.chapters.find((c) => c.no === chapterNo) ?? null
        : null,
    [currentBook, chapterNo],
  );
  /** 是否在话内（屏 C）。`currentChapter` 非空 ⇒ `currentBook` 也非空，二者同涨同落 */
  const inChapter = currentBook !== null && currentChapter !== null;

  /**
   * 页网格（屏 A / 屏 C）与对照视图（屏 D）的投影。
   *
   * 只有两处有"逐页"这回事：整本 / 未归并单话（屏 A，顶层取图）与话内（屏 C，话内取图）。
   * 大类本身（屏 B）没有页 —— 页的宿主是它的话，故这里返回 `null`，右栏改渲染话卡。
   */
  const gridView = useMemo<PageView | null>(() => {
    if (currentBook) return currentChapter ? chapterViewOf(currentBook, currentChapter) : null;
    return current ? flatViewOf(current) : null;
  }, [currentBook, currentChapter, current]);

  const seqMax = gridView?.seqMax ?? 0;
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
  const translatedSeqs = useMemo(() => new Set(gridView?.translatedSeqs ?? []), [gridView]);
  const missingSeqs = useMemo(() => new Set(gridView?.missingSeqs ?? []), [gridView]);

  // 屏 B 话列表的分页（与左栏同一手法：行数变少时夹回合法区间）
  const chPages = pageCount(currentBook?.chapters.length ?? 0, CHAPTER_PAGE_SIZE);
  useEffect(() => {
    setChPage((p) => (p > chPages ? chPages : p));
  }, [chPages]);
  const chapterRows = useMemo(
    () => pageSlice(currentBook?.chapters ?? [], chPage, CHAPTER_PAGE_SIZE),
    [currentBook, chPage],
  );

  /**
   * 当前生效的**操作目标**：头部菜单「继续翻译 / 重新翻译」与两条计划端点打向哪里。
   *
   * 屏 C（话内）→ 该话；其余（屏 A / 屏 B）→ 选中的顶层目录。三者的端点形态完全相同
   * （`{base}/resume`、`{base}/retranslate`）—— 服务端内部才区分"目录怎么来的"
   * （顶层名 vs `书/NN_第N话` 相对路径），前端只换基址，不换逻辑。
   */
  const actionBase = inChapter
    ? `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${chapterNo}`
    : `/library/${encodeURIComponent(current?.comicName ?? '')}`;
  /** 头部卡的标题与路径：话内显示话号 + 该话目录，否则显示目录名 + 顶层目录 */
  const headName = inChapter ? `第 ${chapterNo} 话` : (current?.comicName ?? '');
  const headPath = inChapter ? (currentChapter?.absDir ?? '') : (current?.outputDir ?? '');

  // 选中目标后拉一次「缺页清单」，用于给「继续翻译」置灰 / 显示待续做张数（话内即该话的）
  useEffect(() => {
    if (!current) {
      setPending(null);
      return;
    }
    let alive = true;
    apiGet<{ pendingCount: number }>(`${actionBase}/resume`)
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
  }, [current, actionBase, refreshKey]);

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

  // 选中目标后拉一次返工计划：告诉「操作」菜单能不能点、会覆盖几张（话内即该话的计划）
  useEffect(() => {
    if (!current) {
      setRtPlan(null);
      return;
    }
    let alive = true;
    apiGet<RetranslatePlan>(`${actionBase}/retranslate`)
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
  }, [current, actionBase, refreshKey, reworkingComics]);

  /**
   * 提交返工重译（`POST {base}/retranslate`；`base` 由调用方给 —— 整本、话两个层级同一形态）。
   *
   * 覆盖已有译文是**不可逆**的，所以回执必须说清"覆盖了几张"、覆盖的是**哪一本/哪一话**，
   * 而不是笼统报"已加入队列"—— 用户需要知道自己刚覆盖了什么。
   */
  const retranslate = async (base: string, name: string, seqs?: number[]) => {
    setRtBusy(true);
    try {
      const r = await apiPost<RetranslateResponse>(`${base}/retranslate`, seqs ? { seqs } : {});
      const scope = seqs ? `第 ${seqs.join('、')} 页` : `全部 ${r.retranslateCount} 张`;
      onToast(`已开始返工：${name} ${scope}（覆盖 ${r.overwriteCount} 张已有译文）`, 'good');
      setCompareSeq(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setRtBusy(false);
    }
  };

  const resume = async (base: string, name: string) => {
    setBusy(true);
    try {
      const res = await apiPost<{ comicName: string; queuePosition: number }>(`${base}/resume`, {});
      onToast(`已加入队列：${name}（第 ${res.queuePosition} 位）`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (deleteFiles: boolean) => {
    const target = toDelete?.comic;
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

  /** `LibItem.key` → 顶层目录条目（comics 含**所有**顶层目录，大类也在内） */
  const comicOf = (key: string): ComicEntry | null =>
    comics.find((c) => c.comicName === key) ?? null;

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

  /**
   * 新建漫画（`POST /library/create`）。
   *
   * 成功后的三步**缺一不可**：① 关弹窗；② 清搜索词；③ 选中新项。
   * ② 是必需的 —— 若搜索框里还留着"夏"，新建出来的《夏日》虽然已在库里，
   * 却可能被当前过滤条件挡在左栏之外，于是 `setActive` 选中了一个**看不见的项**，
   * 用户看到的仍是旧的那本（"点了创建什么都没发生"）。
   */
  const createBook = async (name: string, author: string) => {
    setCreating(true);
    try {
      const r = await apiPost<{ bookName: string }>('/library/create', { name, author });
      const created = r.bookName || name;
      onToast(`已创建《${created}》`, 'good');
      setNewBookOpen(false);
      setQueryInput('');
      setActive(created);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setCreating(false);
    }
  };

  /**
   * 保存漫画信息（封面 + 作者）。
   *
   * 四种意图落到**三条**不同的端点上（契约如此，不是可以随便合并的）：
   * · `meta` / `cover-first` → `POST /meta`（后者带 `coverFromFirstChapter:true`）；
   * · `cover-local` → `POST /cover`（multipart 单文件，字段名 `cover`；作者随 `payload` 同一次写入）；
   * · `cover-remove` → `DELETE /cover`（**只有这一个动词**）—— 它按契约保留 `author`，
   *   所以"移除封面同时改作者"要再补一次 `POST /meta`。顺序不能颠倒：
   *   先删封面（失败就整个失败，作者不动），再写作者。
   */
  const saveMeta = async (intent: BookMetaIntent, author: string) => {
    const book = editBook;
    if (!book) return;
    const base = `/library/${encodeURIComponent(book.bookName)}`;
    setSavingMeta(true);
    try {
      if (intent.kind === 'cover-local') {
        await apiPostMultipart(`${base}/cover`, { author }, [intent.srcPath], 'cover');
      } else if (intent.kind === 'cover-remove') {
        await apiDelete(`${base}/cover`);
        await apiPost(`${base}/meta`, { author });
      } else if (intent.kind === 'cover-first') {
        await apiPost(`${base}/meta`, { author, coverFromFirstChapter: true });
      } else {
        await apiPost(`${base}/meta`, { author });
      }
      onToast(`已更新《${book.bookName}》的信息`, 'good');
      setEditBook(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setSavingMeta(false);
    }
  };

  /**
   * 归并（`POST /library/{name}/merge`）。
   *
   * 目标已经占号时服务端回 409 `CHAPTER_NO_TAKEN`，弹窗会在**提交前**就把它拦成
   * 「改话号 / 顺延 / 取消」三选一，所以走到这里还撞上 409 只可能是库在这一瞬变了
   * —— 如实把服务端的话转给用户，别自己编一个。
   */
  const mergeInto = async (target: string, no: number) => {
    const src = mergeTarget;
    if (!src) return;
    setMerging(true);
    try {
      await apiPost(`/library/${encodeURIComponent(src)}/merge`, { target, no });
      onToast(`已归并为《${target}》第 ${no} 话`, 'good');
      setMergeTarget(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setMerging(false);
    }
  };

  /**
   * 编辑话数（`POST /library/{book}/chapters/{no}/renumber`，2026-10-11 用户需求）。
   * 改号 = 服务端把话目录改名 + episodes 重建（页文件原地不动）；成功后刷新库 ——
   * 左栏计数、话卡角标、URL 缓存键（含话号）都会跟着新目录走。
   */
  const renumberChapter = async (bookName: string, chapter: ChapterEntry, no: number) => {
    if (chapter.no === null) return; // 无话号的目录拼不出话级端点，弹窗也不会为它打开
    setRenumbering(true);
    try {
      await apiPost(`/library/${encodeURIComponent(bookName)}/chapters/${chapter.no}/renumber`, { no });
      onToast(`已改为《${bookName}》第 ${no} 话`, 'good');
      setEditNoChapter(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setRenumbering(false);
    }
  };

  if (comics.length === 0 && hidden.length === 0) {
    return (
      <>
        <Notice>
          漫画库还是空的。点工具条的「新建漫画」创建一个，或从「本机投放」送翻译成品进来。
        </Notice>
        {/* ⚠️ 空库也要渲染「新建漫画」弹窗：工具条上的按钮在 App 里、永远可点，
            若这里直接 return 掉弹窗，用户点「新建漫画」会看到**什么都没发生** */}
        {newBookOpen ? (
          <NewBookModal
            root={lib?.root ?? ''}
            existing={[]}
            busy={creating}
            onCancel={() => setNewBookOpen(false)}
            onConfirm={(name, author) => void createBook(name, author)}
            onViewExisting={() => setNewBookOpen(false)}
          />
        ) : null}
      </>
    );
  }

  if (compareSeq !== null && gridView) {
    return (
      <Compare
        view={gridView}
        seq={compareSeq}
        retranslate={rtPlan}
        submitting={rtBusy}
        onSeq={setCompareSeq}
        onBack={() => setCompareSeq(null)}
        onRetranslate={(seqs) => void retranslate(gridView.base, gridView.comicName, seqs)}
      />
    );
  }

  // 「更多操作」菜单的两组文案：与 Compare 同源口径（见 retranslateMeta / resumeMeta）。
  // 头部不再放菜单后，它们服务的是**右键菜单里被选中的那一项**（是当前项时才有真数据）。
  const rtInfo = retranslateMeta(
    rtPlan,
    rtBusy,
    rtPlan?.reworking ?? false,
    rtPlan !== null && rtPlan.retranslateCount === 0,
  );
  const resumeInfo = resumeMeta(pending, busy);

  /**
   * 右键菜单的内容（漫画级动作的**唯一**入口）。
   *
   * 项序按「看得见的在前、破坏性的在后」：打开目录 / ─ / 继续翻译 / 重新翻译 /
   * 编辑信息（大类）或 归并到（单话）/ 删除（大类「删除整本」、单话「删除本话」）。
   *
   * 预检文案（待续做几张 / 会覆盖几张）只有**当前项**有（计划是为 current 拉的）；
   * 右键别的项时不预取 —— 动作本身会先选中语义地打向该项的端点，服务端是权威校验，
   * 拒绝的理由会经 `errorText` 进 Toast。为一个右键菜单给库里每项都拉一遍计划，不值。
   */
  const renderComicMenu = (it: LibItem, close: () => void): ReactElement => {
    const comic = comicOf(it.key);
    const base = `/library/${encodeURIComponent(it.key)}`;
    const isCur = it.key === current?.comicName;
    const busyRt = rtBusy || reworkingComics.has(it.key);
    const rtSub = isCur ? rtInfo.sub : busyRt ? '返工中' : undefined;
    const resSub = isCur ? resumeInfo.sub : undefined;
    /** 右键项对应的**大类**（编辑信息需要 manifest 数据，单话没有 ⇒ null） */
    const bookOfItem = it.merged ? (books.find((b) => b.bookName === it.key) ?? null) : null;
    return (
      <>
        <MenuItem
          icon={<FolderUp size={13} />}
          label="打开目录"
          disabled={!comic}
          title="在文件管理器里打开这个漫画的目录"
          onClick={() => {
            close();
            if (comic) openPath(comic.outputDir).catch((e: unknown) => onToast(errorText(e), 'bad'));
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Play size={13} />}
          label="继续翻译"
          sub={resSub}
          disabled={busy || (isCur && resumeInfo.disabled)}
          title={isCur ? resumeInfo.title : '把待译的页加入队列（只补缺的，不覆盖已有译文）'}
          onClick={() => {
            close();
            void resume(base, it.name);
          }}
        />
        <MenuItem
          icon={<RotateCcw size={13} />}
          label="重新翻译"
          sub={rtSub}
          disabled={busyRt || (isCur && rtInfo.blocked)}
          title={
            busyRt
              ? '该漫画已有任务在队列中，等它跑完再返工'
              : isCur
                ? rtInfo.title
                : '重新翻译全部页（覆盖已有译文，原图不动）'
          }
          onClick={() => {
            close();
            void retranslate(base, it.name);
          }}
        />
        {it.merged ? (
          <MenuItem
            icon={<Pencil size={13} />}
            label="编辑信息"
            disabled={!bookOfItem}
            title={
              bookOfItem
                ? '改封面（本地图片 / 取第 1 话首图 / 移除）与作者'
                : '漫画信息还没就绪，稍后再试'
            }
            onClick={() => {
              close();
              if (bookOfItem) setEditBook(bookOfItem);
            }}
          />
        ) : books.length > 0 ? (
          <MenuItem
            icon={<GitMerge size={13} />}
            label="归并到"
            sub="挂到某本漫画的某一话"
            title="把这一话物理移动进某个大类目录（不可逆）"
            onClick={() => {
              close();
              setMergeTarget(it.key);
            }}
          />
        ) : null}
        <MenuItem
          icon={<Trash2 size={13} />}
          label={it.merged ? '删除整本' : '删除本话'}
          danger
          disabled={!comic}
          title={
            it.merged
              ? '从漫画库删除整部漫画（可选择是否连本地文件一起删）'
              : '从漫画库删除这一话（可选择是否连本地文件一起删）'
          }
          onClick={() => {
            close();
            if (comic) setToDelete({ comic, kind: it.merged ? '整本' : '本话' });
          }}
        />
      </>
    );
  };

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
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索漫画名 / 作者 / 话号…"
            spellCheck={false}
          />
          {queryInput ? (
            <button
              type="button"
              className="lib-search-clear"
              onClick={() => setQueryInput('')}
              aria-label="清空搜索"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        <div className="lib-left-list">
          {searching ? (
            /* ── 屏 A′：搜索结果分组态 ───────────────────────────────── */
            hasLayers ? (
              searchGroups.length > 0 ? (
                searchGroups.map((g) => {
                  const folded = foldedGroups.has(g.key);
                  return (
                    <div className="grp" key={g.key}>
                      {/* 分组标题可点选收起/展开（设计稿 §7.2「折叠」） */}
                      <button
                        type="button"
                        className="grp-head"
                        onClick={() =>
                          setFoldedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.key)) next.delete(g.key);
                            else next.add(g.key);
                            return next;
                          })
                        }
                      >
                        <ChevronDown size={12} className={folded ? 'grp-caret is-folded' : 'grp-caret'} />
                        <span className="grp-title" title={g.title}>
                          {/* 「其它」不加大类框，故不高亮书名号里的书名（它本来就不是书名） */}
                          {g.merged ? <Highlight text={g.title} query={query} /> : g.title}
                        </span>
                        <span className="num grp-count">{g.rows.length}</span>
                      </button>
                      {folded ? null : (
                        <div className="grp-body">
                          {g.merged ? null : (
                            <div className="other-hint">
                              未归并的单话会出现在这里，点「归并」把它挂到某本漫画的某一话。
                            </div>
                          )}
                          {g.rows.map((r) => (
                            <div className="grp-row" key={r.key}>
                              <button
                                type="button"
                                className={
                                  r.bookName === current?.comicName
                                    ? 'grp-row-main is-active'
                                    : 'grp-row-main'
                                }
                                onClick={() => setActive(r.bookName)}
                                title={r.label}
                              >
                                <span className="grp-row-label">
                                  <Highlight text={r.label} query={query} />
                                </span>
                                <span className="grp-row-status muted">
                                  · {progressLabel(r.target)}
                                </span>
                              </button>
                              {r.mergeable ? (
                                <span className="grp-row-act">
                                  <Btn kind="ghost" size="sm" onClick={() => setMergeTarget(r.target.dirName)}>
                                    <GitMerge size={12} />
                                    归并
                                  </Btn>
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="lib-empty">没有匹配「{query}」的漫画或话</div>
              )
            ) : (
              /* 旧服务端（无 books/others）：退回平铺过滤，行为与改造前一致 */
              <>
                {flatHits.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={it.key === current?.comicName ? 'lib-item is-active' : 'lib-item'}
                    onClick={() => setActive(it.key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, item: it });
                    }}
                  >
                    <CoverThumb
                      path={it.thumbPath}
                      name={it.name}
                      className="cover-thumb"
                      w={LIBRARY.cover.thumb.w}
                      h={LIBRARY.cover.thumb.h}
                      radius={LIBRARY.cover.thumb.radius}
                    />
                    <span className="lib-item-text">
                      <Tooltip label={it.name}>
                        <span className="lib-item-name">{it.name}</span>
                      </Tooltip>
                      <span className="lib-item-meta">
                        <span className="num">{it.pageCount}</span> 张
                      </span>
                    </span>
                  </button>
                ))}
                {flatHits.length === 0 ? (
                  <div className="lib-empty">没有匹配「{query}」的漫画</div>
                ) : null}
              </>
            )
          ) : (
            /* ── 屏 A：浏览态（封面缩略 + 名称 + 作者 · N 话 · M 页）────── */
            <>
              {pageSlice(items, libPage, LIB_PAGE_SIZE).map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className={it.key === current?.comicName ? 'lib-item is-active' : 'lib-item'}
                  onClick={() => setActive(it.key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, item: it });
                  }}
                >
                  <CoverThumb
                    path={it.thumbPath}
                    name={it.name}
                    className="cover-thumb"
                    w={LIBRARY.cover.thumb.w}
                    h={LIBRARY.cover.thumb.h}
                    radius={LIBRARY.cover.thumb.radius}
                  />
                  <span className="lib-item-text">
                    <Tooltip label={it.name}>
                      <span className="lib-item-name">{it.name}</span>
                    </Tooltip>
                    <span className="lib-item-meta">
                      {it.author || AUTHOR_FALLBACK} · <span className="num">{it.chapterCount}</span> 话 ·{' '}
                      <span className="num">{it.pageCount}</span> 页
                    </span>
                  </span>
                </button>
              ))}
              {items.length === 0 ? <div className="lib-empty">漫画库还是空的</div> : null}
            </>
          )}
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

        {/* 搜索态是分组的连续列表，不分页（设计稿 §7.2 的屏 A′ 里没有分页器） */}
        {!searching && libPages > 1 ? (
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
              {/* 屏 C 的返回（设计稿 §5.3：任何层级可「返回」且不丢选中态）——
                  返回的是屏 B 话列表，左栏选中保持不动 */}
              {inChapter ? (
                <IconButton title="返回这一部的话列表" onClick={() => setChapterNo(null)}>
                  <ArrowLeft size={20} />
                </IconButton>
              ) : null}
              <div className="lib-head-titles">
                <div className="lib-head-name" title={headName}>
                  {headName}
                </div>
                <div className="lib-head-path" title={headPath}>
                  {headPath}
                </div>
              </div>
              {/* 大类的补充信息：话内归因到所属大类，话列表给出作者与规模（设计稿 §7.1 同一口径） */}
              {currentBook ? (
                <span className="lib-head-sub muted">
                  {inChapter
                    ? `《${currentBook.bookName}》`
                    : `${currentBook.author || AUTHOR_FALLBACK} · ${currentBook.chapterCount} 话 · ${currentBook.totalPages} 页`}
                </span>
              ) : null}
              <Btn kind="ghost" onClick={onRefresh} title="重新扫描漫画库">
                <RefreshCw size={14} />
                刷新
              </Btn>
              {/* 头部按钮只留「刷新」：打开目录 / 续做 / 返工 / 编辑信息 / 删除 / 归并
                  全部迁往**左栏漫画项的右键菜单**（renderComicMenu）—— 操作的主语是
                  "被右键的那部漫画"，比"头部当前显示的这部"更不容易错位 */}
            </div>

            {currentBook && !inChapter ? (
              /* ── 屏 B：话列表（设计稿 §7.3）── 话卡沿用 110×165 网格几何；
                  大类自身没有"页"，所以它选中时右栏不渲染页网格 */
              <>
                <div className="card lib-grid-wrap">
                  <div className="lib-grid">
                    {chapterRows.map((ch) => (
                      <ChapterCard
                        key={ch.dirName}
                        bookName={currentBook.bookName}
                        chapter={ch}
                        busy={
                          // 整本有任务在跑 ⇒ 它的话也在被写，本话再返工会互相覆盖
                          reworkingComics.has(currentBook.dirName) ||
                          reworkingComics.has(`${currentBook.dirName}/${ch.dirName}`)
                        }
                        onOpen={() => {
                          if (ch.no !== null) setChapterNo(ch.no);
                        }}
                        onOpenDir={() =>
                          openPath(ch.absDir).catch((e: unknown) => onToast(errorText(e), 'bad'))}
                        onResume={() => {
                          if (ch.no === null) return; // 无话号的目录拼不出话级端点，卡片入口也已禁用
                          void resume(
                            `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${ch.no}`,
                            `《${currentBook.bookName}》第 ${ch.no} 话`,
                          );
                        }}
                        onRetranslate={() => {
                          if (ch.no === null) return; // 无话号的目录拼不出话级端点，卡片入口也已禁用
                          void retranslate(
                            `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${ch.no}`,
                            `《${currentBook.bookName}》第 ${ch.no} 话`,
                          );
                        }}
                        onEditNo={() => setEditNoChapter({ bookName: currentBook.bookName, chapter: ch })}
                      />
                    ))}
                  </div>
                </div>

                <div className="lib-foot-note">
                  <span>
                    共 <span className="num">{currentBook.chapters.length}</span> 话
                    {chPages > 1 ? (
                      <>
                        {' · 第 '}
                        <span className="num">{chPage}</span> / <span className="num">{chPages}</span> 页
                      </>
                    ) : null}
                  </span>
                  {chPages > 1 ? (
                    <span className="lib-grid-pager">
                      <Btn kind="ghost" size="sm" disabled={chPage <= 1} onClick={() => setChPage(chPage - 1)}>
                        上一页
                      </Btn>
                      <Btn
                        kind="ghost"
                        size="sm"
                        disabled={chPage >= chPages}
                        onClick={() => setChPage(chPage + 1)}
                      >
                        下一页
                      </Btn>
                    </span>
                  ) : (
                    <span>点任意一话看它的页 · 卡片「⋯」里可重译整话</span>
                  )}
                </div>
              </>
            ) : (
              /* ── 屏 A（整本 / 未归并单话）与屏 C（话内页）：同一套页网格渲染 ──
                  两处只差投影（gridView），格子本身零差别 */
              <>
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
                          <Thumb
                            path={state === 'done' && gridView ? gridView.imagePath(seq, 'translated') : ''}
                            seq={seq}
                            state={state}
                          />
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
            )}
          </>
        ) : (
          <Notice>
            {searching
              ? `没有匹配「${query}」的漫画或话。换个关键词，或清空搜索。`
              : '漫画库还是空的。点工具条的「新建漫画」创建一个，或从「本机投放」送翻译成品进来。'}
          </Notice>
        )}
      </section>

      {toDelete ? (
        <DeleteComicModal
          comic={toDelete.comic}
          kind={toDelete.kind}
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

      {newBookOpen ? (
        <NewBookModal
          root={lib?.root ?? ''}
          existing={comics.map((c) => c.dirName)}
          busy={creating}
          onCancel={() => setNewBookOpen(false)}
          onConfirm={(name, author) => void createBook(name, author)}
          onViewExisting={(name) => {
            // 同名时「查看它」：关弹窗 + 清搜索词（否则可能被过滤条件挡在左栏外）+ 选中
            setNewBookOpen(false);
            setQueryInput('');
            setActive(name);
          }}
        />
      ) : null}

      {editBook ? (
        <EditBookModal
          book={editBook}
          busy={savingMeta}
          onCancel={() => setEditBook(null)}
          onSubmit={(intent, author) => void saveMeta(intent, author)}
        />
      ) : null}

      {mergeTarget ? (
        <MergeModal
          source={mergeTarget}
          books={books}
          busy={merging}
          onCancel={() => setMergeTarget(null)}
          onConfirm={(target, no) => void mergeInto(target, no)}
        />
      ) : null}

      {editNoChapter ? (
        <EditChapterNoModal
          bookName={editNoChapter.bookName}
          chapter={editNoChapter.chapter}
          takenNos={(books.find((b) => b.bookName === editNoChapter.bookName)?.chapters ?? [])
            .map((c) => chapterNoOf(c.dirName))
            .filter((n): n is number => n !== null && n !== editNoChapter.chapter.no)}
          busy={renumbering}
          onCancel={() => setEditNoChapter(null)}
          onConfirm={(no) => void renumberChapter(editNoChapter.bookName, editNoChapter.chapter, no)}
        />
      ) : null}

      {ctxMenu ? (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          {(close) => renderComicMenu(ctxMenu.item, close)}
        </ContextMenu>
      ) : null}
    </div>
  );
}
