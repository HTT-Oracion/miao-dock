/**
 * 展开播放器的逐字歌词（卡拉OK / karaoke）渲染层。
 *
 * 从参考实现（vendor/music-reference/upstream-v10）移植**渲染方案**，但按其说明
 * 重写为原生 DOM + CSS（不引 Chakra / framer-motion，与本项目其余 UI 一致）。
 *
 * ## 渲染方案：双层叠加 + width% 裁切
 *   · 底层：整行文本，用「未唱色」（高亮色压到低透明度）；
 *   · 顶层：**同一行文本**，用「已唱色」（满高亮），`position:absolute` 压底层之上，
 *     靠 `width: N%` 裁切 —— 只露左侧已唱过的部分；
 *   · RAF 每帧把顶层 width 从 0% 推到 100%，就得到"逐字填充"的推进感；
 *   · 顶层右缘加 `mask-image` 渐变，让裁切边不是一道硬线，而是柔和过渡。
 *
 * ## 为什么用双层而不是 `background-clip: text`
 *   ① `background-clip:text` 要把进度写进背景渐变的 stop 或 `var()` 的 `calc()`，
 *      而本项目的皮肤会在多层选择器里覆盖这些变量，派生值在 `calc()` 里的解析不稳定 ——
 *      进度会时对时错，且只在特定皮肤下复现；
 *   ② 它强依赖 `-webkit-` 前缀，与部分皮肤的 `filter` / 背景叠用时会串味；
 *   ③ 双层只动**一个** `width` 百分比，RAF 里只写这一个属性、不触发布局重算，
 *      兼容性与性能都更好（参考实现得出同一结论，此处采用其结论，不照抄其组件）。
 *
 * ## 时间来源：优先读音频元素的真实 `currentTime`
 *   store 的 `progressMs` 由 `<audio>` 的 `timeupdate` 更新，**约 4Hz** —— 直接拿它
 *   驱动 width，逐字推进会一跳一跳。所以每帧读 `findAudioElement()?.currentTime`
 *  （本项目唯一的 `<audio>` 访问入口，见 audioGraph 注释），拿不到元素时**必须降级**：
 *   以「最近一次 progressMs + 本地单调钟外推」继续推进（浏览器里直开主窗调试的场景）。
 *   外推用 `performance.now()` 而不是 `Date.now()`：前者是单调钟，不受系统校时/改时间影响。
 *
 * ## 性能
 *   每帧只做两件小事：① 定位当前行索引（变了才 setState）；② 给**当前行**的顶层写一次
 *   width。非当前行不参与 RAF、也不重渲染 —— 整表 setState 只在换行时发生。
 */
import { useEffect, useRef, useState } from 'react';
import { findAudioElement } from '@music/audioGraph';
import { lyricIndexAt, useMusicStore } from '@music/store';
import type { ParsedLyricLine } from '@music/store';

/**
 * smoothstep 缓动（0→1）。行级插值用它替代线性：
 * 线性推进在行的首尾都显得"匀速而呆"，smoothstep 让起步与收尾更缓、中段更快，
 * 更接近"字被一个个唱出来"的观感。有逐字数据时不需要它（本来就走精确字符位置）。
 */
function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

interface KaraokeLyricsProps {
  /** 已解析歌词行（time 单位秒；含可选 duration / words） */
  lines: ParsedLyricLine[];
  /**
   * 歌词字号（px）。这里**只**用于按字号缩放顶层的 mask 渐变宽度；
   * 字号与高亮色的真正落地走 CSS 变量（ExpandedPlayer 注入的 --lyr-size / --lyr-hl）。
   */
  fontPx: number;
  /**
   * 歌词整体对齐（可选，默认居中）。
   * 「透明彩胶 / 封面渐染」两套皮肤按参考实现是**左对齐**的歌词列表，
   * 其余皮肤居中。这里只切一个根类名（is-left），不改动画/双层渲染逻辑。
   */
  align?: 'center' | 'left';
  /**
   * 窗口模式：只渲染「当前句起」的 N 行（默认 `undefined` = 全部，即展开播放器的既有行为）。
   *
   * 为什么必须有它：灵动岛歌词卡只有 320×150，整首几十行塞进去既装不下，
   * 也会让 `.music-exp-lyr-box` 的滚动定位在小盒子里来回跳。
   * ⚠️ 它**只切渲染区间的起止下标**，双层结构与 RAF 逐字推进**一行都不改** ——
   * 逐字实现全项目只有这一份（第二份实现是本项目明确禁止的）。
   */
  windowSize?: number;
  /**
   * 是否把当前行 `scrollIntoView`（默认 true = 展开播放器的既有行为）。
   * 灵动岛传 `false`：卡片里只有两行，"滚动"既无意义也会顶掉整窗布局。
   */
  scroll?: boolean;
  /**
   * 是否在每行歌词下方显示翻译（默认 false = 不显示）。
   * 展开播放器传 true；灵动岛**不传**（空间不够，翻译行会撑爆 320×150 的卡片）。
   * ⚠️ 做成 prop 而非全局开关：灵动岛复用同一个 KaraokeLyrics，不能一开全开。
   */
  showTranslation?: boolean;
}

/**
 * 计算某行的填充进度 (0~1)。
 *
 * - **有逐字数据**：遍历每个词，按「词起点 + 词时长」把进度精确定位到字符位置；
 * - **无逐字数据**：行级线性插值 + smoothstep 缓动（绝大多数歌走的是这一路）。
 *
 * ⚠️ 无逐字分支不是"兜底的可选项"，而是**主路径**：平台绝大多数只给行级 LRC。
 * 它的跨度来自 `line.duration` / 下一行起点（由 store 的 finalizeLineDurations 保证有值），
 * 没有这一步，没有 yrc 的歌就完全没有推进感。
 */
function getLineProgress(
  line: ParsedLyricLine | undefined,
  nextLine: ParsedLyricLine | undefined,
  nowSec: number,
): number {
  if (!line) return 0;

  const hasWords = !!(line.words && line.words.length);
  // 视觉补偿：让高亮略超前音频，抵消人眼感知与播放链路的滞后。有逐字数据时更小。
  const now = nowSec + (hasWords ? 0.03 : 0.02);

  if (hasWords && line.text.length > 0) {
    const total = line.text.length;
    let lastP = 0;
    for (const w of line.words as NonNullable<ParsedLyricLine['words']>) {
      const ws = w.t;
      const we = w.t + Math.max(0.08, w.d || 0.24);
      if (now < ws) return lastP;
      const local = now >= we ? 1 : (now - ws) / Math.max(0.08, we - ws);
      const clamped = Math.max(0, Math.min(1, local));
      // 用词的字符区间 [c0,c1) 在整行里的占比定位当前字符
      const p = (w.c0 + (w.c1 - w.c0) * clamped) / total;
      lastP = Math.max(lastP, p);
      if (now < we) return lastP;
    }
    return 1;
  }

  // ── 无逐字数据：行级线性插值 + smoothstep 缓动 ──
  const nextT =
    nextLine && nextLine.time > line.time ? nextLine.time : line.time + (line.duration || 4.8);
  // 跨度下限 0.75s：两行贴得极近时也能看清推进，不会被压缩成一闪
  const span = Math.max(0.75, nextT - line.time);
  const prog = Math.max(0, Math.min(1, (now - line.time) / span));
  return smoothstep(prog);
}

export function KaraokeLyrics({
  lines,
  fontPx,
  align = 'center',
  windowSize,
  scroll = true,
  showTranslation = false,
}: KaraokeLyricsProps) {
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 当前行顶层（已唱）文字的容器：RAF 只改它的 width */
  const overlayRef = useRef<HTMLSpanElement | null>(null);
  /** 当前行整行节点：用于滚动定位 */
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  // 供 RAF 闭包读取的最新值（RAF 的 effect 依赖为空，不能直接闭包捕获渲染期变量）
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const idxRef = useRef(-1);
  // 整行/逐字模式：整行模式下当前行直接满亮，不走逐字/行级渐进分支
  const lyricsMode = useMusicStore((s) => s.lyricsMode);
  const modeRef = useRef(lyricsMode);
  modeRef.current = lyricsMode;
  // 降级外推用的基准：最近一次 progressMs 及其到达时刻（performance.now）
  const fallbackMsRef = useRef(0);
  const fallbackAtRef = useRef(0);

  // 切歌（lines 变化）：清空当前行与基准，避免上一首的索引/宽度残留
  useEffect(() => {
    idxRef.current = -1;
    setActiveIndex(-1);
    fallbackMsRef.current = 0;
    fallbackAtRef.current = 0;
    if (overlayRef.current) overlayRef.current.style.width = '0%';
  }, [lines]);

  // 单条 RAF 循环：定位当前行 + 只给当前行写 width（不每帧 setState）
  useEffect(() => {
    let raf = 0;

    /** 读"当前播放秒数"：优先音频元素真实时间，拿不到再本地外推 */
    const readNowSec = (): number => {
      const el = findAudioElement();
      if (el) return el.currentTime;
      // ── 降级：无 <audio> 时用 store 的 progressMs（~4Hz）+ 本地单调钟外推 ──
      const st = useMusicStore.getState();
      if (st.progressMs !== fallbackMsRef.current) {
        fallbackMsRef.current = st.progressMs;
        fallbackAtRef.current = performance.now();
      }
      // ⚠️ 暂停时**不**外推：否则暂停期间歌词会继续往前爬（最容易被当成"歌词乱跳"）
      const elapsed =
        st.isPlaying && fallbackAtRef.current ? performance.now() - fallbackAtRef.current : 0;
      return (fallbackMsRef.current + elapsed) / 1000;
    };

    const tick = () => {
      const ls = linesRef.current;
      if (ls.length) {
        const now = readNowSec();
        const idx = lyricIndexAt(ls, now);
        if (idx !== idxRef.current) {
          idxRef.current = idx;
          // 只在换行时 setState（每行至多一次，不是每帧）
          setActiveIndex(idx);
        }
        const el = overlayRef.current;
        if (el && idx >= 0) {
          // 整行模式：当前行满亮（100%）；逐字模式：走 getLineProgress 的逐字/行级渐进
          const p = modeRef.current === 'line' ? 1 : getLineProgress(ls[idx], ls[idx + 1], now);
          el.style.width = `${(p * 100).toFixed(2)}%`;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // 空依赖：RAF 循环只建一次；数据经 ref 读取，避免每帧重建
  }, []);

  // 当前行滚到容器中央（与改造前的观感一致；切歌/换行/拖动进度都跟随）
  useEffect(() => {
    if (activeIndex < 0) return;
    if (!scroll) return; // 窗口模式（灵动岛）：只有两行，滚动既不必要也会顶掉布局
    activeRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex, scroll]);

  /*
   * 窗口区间的起点。
   *
   * ⚠️ `activeIndex === -1`（还没唱到第一句：前奏/间奏/刚起播）必须回落到 **0**：
   * 若按 -1 起算，切片会拿到 `lines[-1..1)` 这样的空区间 —— 卡片上就是一片空白，
   * 而此时所有断言照样全绿（它不报错，只是"没开唱时歌词卡是空的"）。
   * 从头显示开头几行的好处是：用户还能提前看到即将唱什么。
   */
  const winStart = windowSize && windowSize > 0 ? Math.max(0, activeIndex) : 0;
  const winEnd = windowSize && windowSize > 0 ? Math.min(lines.length, winStart + windowSize) : lines.length;
  // 非窗口模式下直接用原数组（不 slice），避免每帧多产一个新数组
  const viewLines = winStart === 0 && winEnd === lines.length ? lines : lines.slice(winStart, winEnd);

  // mask 渐变宽度随字号缩放：小字号时固定 18px 会把整行都遮上，导致底层透出
  const maskFade = Math.min(18, Math.max(6, fontPx * 0.7));
  const maskGradient = `linear-gradient(90deg, #000 0%, #000 calc(100% - ${maskFade}px), rgba(0,0,0,0.3) 100%)`;

  // 字号与高亮色（--lyr-size / --lyr-hl / --lyr-text）由**宿主**注入：
  // 展开播放器注入在 .music-exp 根上、灵动岛注入在歌词卡根节点上，都靠 CSS 变量继承传下来。
  // 本组件不自己注入 —— 否则同一份"取色/取字号"会有第三个 owner。
  // ⚠️ 灵动岛**不在** .music-exp 子树里，所以它必须自己注入一遍（见 DynamicIsland 的注释）。
  return (
    <div className={align === 'left' ? 'music-exp-lyr-box is-left' : 'music-exp-lyr-box'}>
      {viewLines.map((line, k) => {
        // 窗口模式下 k 是「窗口内下标」，判定是否当前行必须用**整首里的绝对下标**
        const i = winStart + k;
        const isActive = i === activeIndex;
        if (!isActive) {
          // 非当前行：普通一行（沿用 .music-lyr-line 的暗色语汇）
          return (
            <div key={i} className="music-lyr-line kara-line">
              {line.text}
              {showTranslation && line.translation ? (
                <span className="kara-trans">{line.translation}</span>
              ) : null}
            </div>
          );
        }
        // 当前行：双层叠加 —— 底层未唱 + 顶层已唱（width 裁切 + mask 柔边）
        return (
          <div key={i} ref={activeRowRef} className="music-lyr-line is-on kara-line kara-line-on">
            <span className="kara-dup">
              <span className="kara-under">{line.text}</span>
              <span
                className="kara-over"
                ref={overlayRef}
                style={{ maskImage: maskGradient, WebkitMaskImage: maskGradient }}
              >
                {line.text}
              </span>
            </span>
            {showTranslation && line.translation ? (
              <span className="kara-trans">{line.translation}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
