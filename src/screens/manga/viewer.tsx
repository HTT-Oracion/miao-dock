// 漫画库的「看图 / 对照」收口：单页 `Pane` · 全屏 `Lightbox`（缩放 + 平移）· 双图 `Compare`。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-148）：这一簇（含 200+ 行缩放/平移的交互说明）
// 是独立关切，却和「库列表 / 搜索 / 分页」挤在同一个 2,122 行文件里；单开本模块后
// 屏本体只留编排与列表。
//
// ⚠️ `check:units` 的 ZOOM 组读的是「`LibraryScreen.tsx` + 本文件」的**拼接源码**，
// 故 `zoomAt` / `onWheel` / `.lightbox-zoom-btn` 这些锚点仍可命中 —— 别把缩放再拆到第三个文件去。
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, RotateCcw, Search, X } from 'lucide-react';
import { Btn, IconButton, MenuButton, MenuItem } from '@components/units';
import type { RetranslatePlan } from '@/types';
import { useBlobUrl } from '@screens/manga/blob';
import type { PageView, Variant } from '@screens/manga/blob';
import { retranslateMeta } from '@screens/manga/meta';

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
            title={
              zoomed ? '拖动或双指滑动可调整显示区域 · 点一下隐藏工具栏' : 'Ctrl/⌘ + 滚轮（向上放大）· 点一下隐藏工具栏'
            }
          />
        ) : (
          <span className="lightbox-msg">{blob.kind === 'loading' ? '加载中…' : '该侧文件缺失'}</span>
        )}
      </div>

      {/* 隐藏后留一条极窄的提示带：否则用户不知道还能点回来 */}
      {barHidden ? <div className="lightbox-hint">点图显示工具栏</div> : null}

      {/*
        工具栏**常驻挂载、只淡出**（设计稿 `.lightbox .lb-head/.lb-foot { transition: opacity … }`）。
        旧写法是 `{!barHidden ? <bar/> : null}` —— 每次显隐都整块卸载重建：
        点一下图，工具栏"啪"地消失而不是淡出，回来时也没有过渡。
      */}
      <div
        className={barHidden ? 'lightbox-bar is-hidden' : 'lightbox-bar'}
        aria-hidden={barHidden}
        onClick={(e) => e.stopPropagation()}
      >
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
export function Compare({
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
        <Pane
          path={view.imagePath(seq, 'translated')}
          seq={seq}
          variant="translated"
          onZoom={() => setZoom('translated')}
        />
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
