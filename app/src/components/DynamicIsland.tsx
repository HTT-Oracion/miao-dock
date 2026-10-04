import { ListMusic, Maximize2, Music, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { IconButton } from '@components/units/IconButton';
import { attachAnalyser, findAudioElement, isAudioContextRunning, readLevels } from '@music/audioGraph';
import { coverProxyUrl, fmtTime, useMusicStore } from '@music/store';
import type { IslandView, ParsedLyricLine } from '@music/store';
import type { Song } from '@music/types';
import { KaraokeLyrics } from '@screens/music/KaraokeLyrics';
import { toastBus, useToastsFromBus, type ToastKind } from '@/toastBus';

/**
 * 灵动岛 —— 拍板第 4 项（方案 B = 播放态 + 承接轻提示）。
 *
 * ## 形态与交互契约取自哪里
 * 取自 vendor 里的参考实现（`upstream-v10/components/dynamic-island.tsx`，只读不改）。
 * 它是 framer-motion 的 `useAnimationControls().start({width,height})` 驱动形变，
 * 本项目是**原生 CSS 路线**，所以逐项换成等效机制：
 *
 * | 参考实现                        | 本项目（不用 framer-motion）                       |
 * |---------------------------------|----------------------------------------------------|
 * | `controls.start({width,height})`| 内联 `style={{width,height}}` + `.di-capsule` 的 transition |
 * | `await controls.start(...)`     | `await wait(时长)` / `await nextPaint()`（时长与 CSS 同源） |
 * | `chainRef` Promise 链           | 同款 `chainRef`（见 run 的说明）                    |
 * | `expandedRef` 中止判定           | 同款：每段 await 后回查 ref                        |
 * | `useSongLevels` 纯前端假波形     | `AnalyserNode` 接真实音频 + 不可用时回落 CSS 动画波形 |
 *
 * ## 三态
 * 圆形 30×30（只有语义点）→ 胶囊（音乐 200×30 / 普通提示自适应宽×30）→ 大卡 320×150（音乐）。
 * 尺寸常量与参考实现**逐值一致**。
 *
 * ## 为什么空闲时不渲染 DOM
 * 空气里挂一个空胶囊比"根本不显示"更怪；而组件本身常驻（App 根一直渲染它），
 * `return null` 只是不下 DOM，state / refs 仍在 —— 所以动画状态能跨空闲期保留。
 */

/* ---- 尺寸常量：与参考实现逐值一致（30 / 200×30 / 320×150）---- */
const CIRCLE_SIZE = 30;
const COLLAPSED_HEIGHT = 30;
const MUSIC_COLLAPSED_WIDTH = 200;
const MUSIC_COLLAPSED_HEIGHT = 30;
const EXPANDED_WIDTH = 320;
const MUSIC_EXPANDED_HEIGHT = 150;
/** 普通提示展开态高度：参考实现里"无描述的单行提示"取 34 */
const TOAST_EXPANDED_HEIGHT = 34;

/** 形变（宽/高）时长 —— 必须与 app.css `.di-capsule` 的 width/height transition 一致 */
const MORPH_MS = 320;
/** 淡入/淡出时长 —— 必须与 app.css `.di-capsule` 的 transform/opacity 0.26s 一致 */
const FADE_MS = 260;
/** 波形柱数量（对齐参考实现折叠态的 5 根） */
const WAVE_BARS = 5;

/**
 * 歌词卡的歌词窗口行数：当前句 + 下一句。
 *
 * 两行的排法与**桌面歌词刻意相反**：桌面歌词窗在屏幕底部、可以放 3~5 行，
 * 按"当前句在最下、往上回溯"排（唱过的往上走，符合它自下而上的阅读方向）；
 * 而灵动岛在屏幕**顶部**且只有两行 —— 用户看它是"往下扫一眼"，
 * 把"即将唱什么"放在下面才是有信息的那一半，"已经唱过什么"在顶部的两行里意义不大。
 * 所以这里：当前句在上（高亮 + 逐字推进）、下一句在下（暗色小一号）。
 */
const ISLAND_LYR_WINDOW = 2;
/**
 * 歌词卡的字号（当前句 / 下一句，px）—— **卡片自己的固定值，不跟随 `lyricsFontSize`**。
 *
 * 为什么不跟随用户偏好：设置页那条量程是 17–48，服务的是"展开播放器铺满整屏"的场景。
 * 卡片只有 320px 宽，48px 一行放不下几个字，而 17px 又会让两行把 150px 高撑满 ——
 * 两端都不成立，所以这里按卡片自己的可用空间定死。
 * 高亮色则**跟随** `lyricsHighlightColor`：那是"用户选的颜色"，应当处处生效。
 */
const ISLAND_LYR_SIZE = 14;
const ISLAND_LYR_SIZE_NEXT = 12;

/** 参考实现的 `IslandStatus`（六态） */
type IslandStatus = 'success' | 'error' | 'info' | 'warning' | 'loading' | 'blue';

/**
 * 语义色映射表（实际代码里的六态口径）。
 * 总线侧保留了旧名 good/bad（6 处业务在用，不能破坏），这里做等价映射；
 * warning/loading/blue 是参考实现另有语义的三态，总线新增。
 */
const KIND_TO_STATUS: Record<ToastKind, IslandStatus> = {
  info: 'info',
  good: 'success',
  bad: 'error',
  warning: 'warning',
  loading: 'loading',
  blue: 'blue',
};

/** 形变阶段：圆形 → 胶囊 → 大卡（分别对应一组内联宽高） */
type Phase = 'circle' | 'collapsed' | 'expanded';

/** 当前**真正渲染在岛上**的内容（参考实现的 `displayed`）。 */
interface Shown {
  kind: 'toast' | 'music';
  /**
   * 展示键。**仅当它变化时才播出现/替换动画** —— 这是刻意去重：
   * `playSong` 会先置 currentSong 再异步置 isPlaying，
   * 若以"播放态"为触发，同一首歌会先淡入展开、再缩回扩散，看起来像加载两次。
   */
  key: string;
  /** 轻提示的 toast id（用于"只关这一条"）；音乐卡为固定 'music' */
  id: string;
  text: string;
  status: IslandStatus;
}

export function DynamicIsland() {
  const toast = useToastsFromBus();

  // 播放态数据。⚠️ 订阅粒度保持细：订阅 queue 整个数组会让每次入队/出队都重渲染这里。
  const currentSong = useMusicStore((s) => s.currentSong);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const hasQueue = useMusicStore((s) => s.queue.length > 0);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const prevTrack = useMusicStore((s) => s.prev);
  const nextTrack = useMusicStore((s) => s.next);
  const setPlayerExpanded = useMusicStore((s) => s.setExpanded);
  // 歌词卡：视图（播放卡 / 歌词卡）是**持久化偏好** —— hover 是"临时看一眼"，
  // 用户切过一次就该记住（见 store 里 IslandView 的注释）
  const islandView = useMusicStore((s) => s.islandView);
  const setIslandView = useMusicStore((s) => s.setIslandView);
  const lyrics = useMusicStore((s) => s.parsedLyrics);
  /** 用户选的歌词高亮色：灵动岛也要用（详见下面歌词卡根节点的变量注入） */
  const lyricsHighlight = useMusicStore((s) => s.lyricsHighlightColor);

  // 渲染用状态
  const [displayed, setDisplayed] = useState<Shown | null>(null);
  const [phase, setPhase] = useState<Phase>('circle');
  const [visible, setVisible] = useState(false); // 整体淡入淡出
  const [contentOn, setContentOn] = useState(false); // 折叠态内容（文字 / 波形 / 关闭键）
  const [cardOn, setCardOn] = useState(false); // 大卡内容
  const [leaving, setLeaving] = useState(false); // 点击关闭的退场
  const [rowWidth, setRowWidth] = useState(0); // 折叠态自适应宽（测量得到）
  const [titleOver, setTitleOver] = useState(false); // 标题是否溢出（溢出→右端淡出）

  // 同步给异步动画读取的 ref（setState 是异步的，动画链需要"此刻"的值）
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const visibleRef = useRef(false);
  const expandedRef = useRef(false);
  const phaseRef = useRef<Phase>('circle');
  const wantExpandedRef = useRef(false);
  const targetRef = useRef<Shown | null>(null);
  const displayedRef = useRef<Shown | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const pendingLeaveRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const leavingRef = useRef(false);
  const closeIdRef = useRef<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);

  const setShown = useCallback((it: Shown | null) => {
    displayedRef.current = it;
    setDisplayed(it);
  }, []);
  const goPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    expandedRef.current = p === 'expanded';
    setPhase(p);
  }, []);
  const setShownVisible = useCallback((v: boolean) => {
    visibleRef.current = v;
    setVisible(v);
  }, []);

  /**
   * 把动画排进 Promise 链，**串行执行**。
   *
   * 为什么必须串行：所有动画共享同一组 DOM 尺寸（胶囊的 width/height）与透明度。
   * 并发跑两个 play* 会各自写下目标值，后写的覆盖先写的 —— 表现是"缩到一半突然弹开"
   * 或"文字与胶囊错位"。参考实现也是用同一条 `chainRef` 链解决（这里照搬这个机制）。
   * `.catch` 吞掉单段的异常：一段动画失败不该让整条链僵死（后续动画永远排不进来）。
   */
  const run = useCallback((fn: () => Promise<void>) => {
    chainRef.current = chainRef.current.then(fn).catch(() => undefined);
  }, []);

  /**
   * 点击关闭：先补一段退场，再真正从总线移除。
   *
   * 为什么用 setTimeout 而不是 transitionend：元素会在 dismiss 后被条件渲染卸载，
   * 那时 transitionend 根本收不到，动画会被硬截断。
   * ⚠️ 260ms 必须与 app.css `.di-capsule` transition 里的 0.26s 一致
   * （check:units 的 ISLAND.leaveDurationSync 双向比对这两个数，改一处必须改另一处）。
   */
  const requestClose = useCallback(() => {
    const t = displayedRef.current;
    if (!t || t.kind !== 'toast' || leavingRef.current) return;
    const closeId = t.id;
    leavingRef.current = true;
    closeIdRef.current = closeId;
    setLeaving(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      // 只关"按下关闭键时的那一条"：退场途中若换了内容，不能连带关掉新提示
      const cur = displayedRef.current;
      if (cur && cur.kind === 'toast' && cur.id === closeId) {
        toastBus.dismiss(Number(closeId));
      }
      leavingRef.current = false;
      closeIdRef.current = null;
      setLeaving(false);
    }, 260);
  }, []);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // 退场途中来了**另一条**提示：取消退场，交给 replace 动画换内容（否则新提示也会被淡出）
  useEffect(() => {
    if (!toast) return;
    const id = String(toast.id);
    if (leavingRef.current && closeIdRef.current !== null && id !== closeIdRef.current) {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
      leavingRef.current = false;
      closeIdRef.current = null;
      setLeaving(false);
    }
  }, [toast]);

  /* ---------------- 动画段（每段 await 之后都要回查 ref，才能被中途中止） ---------------- */

  const playAppear = useCallback(async () => {
    const t = targetRef.current;
    if (!t || visibleRef.current) return;
    goPhase('circle');
    setContentOn(false);
    setCardOn(false);
    wantExpandedRef.current = false;
    // 先以"透明圆形"挂上 DOM：首帧不产生过渡，必须先让 opacity:0 落地再翻成 1
    setShown(t);
    await nextPaint();
    if (!displayedRef.current) return; // 中途中止：还没淡入就被换掉了
    // ① 圆形淡入
    setShownVisible(true);
    await wait(FADE_MS);
    if (!visibleRef.current) return; // 中途中止：期间已退场
    if (targetRef.current?.key !== t.key) return; // 内容已变 → 交给 playReplace
    // ② 文字浮现，并向两侧扩散成胶囊
    setContentOn(true);
    goPhase('collapsed');
  }, [goPhase, setShown, setShownVisible]);

  const playReplace = useCallback(async () => {
    const t = targetRef.current;
    if (!t) return;
    // 展开途中收到新内容：直接换，保持展开（否则会"缩回再弹开"，闪两下）
    if (expandedRef.current) {
      setShown(t);
      return;
    }
    // ① 缩回圆形（内容先淡出，再收窄）
    setContentOn(false);
    setCardOn(false);
    goPhase('circle');
    await wait(MORPH_MS);
    if (!visibleRef.current) return; // 中途中止
    const t2 = targetRef.current;
    if (!t2) return;
    if (t2.key === displayedRef.current?.key) return;
    // ② 换内容 —— 先让新内容的宽度测量落地，否则会先扩到旧宽再跳一下
    setShown(t2);
    await nextPaint();
    if (!visibleRef.current) return;
    setContentOn(true);
    goPhase('collapsed');
  }, [goPhase, setShown]);

  const playExpand = useCallback(async () => {
    const t = targetRef.current;
    if (!t || expandedRef.current) return;
    // 排队期间光标已经移开 → 直接放弃，别制造一次"扩了又收"的闪烁
    if (!wantExpandedRef.current) return;
    goPhase('expanded'); // 宽高同帧开动
    setContentOn(false); // 折叠内容原位淡出（位置固定，无位移）
    await wait(MORPH_MS);
    if (!expandedRef.current) return; // 中途中止：期间已收起
    if (phaseRef.current !== 'expanded') return;
    setCardOn(true); // 大卡内容在最终位淡入
  }, [goPhase]);

  const playCollapse = useCallback(async () => {
    if (!expandedRef.current || !displayedRef.current) return;
    setCardOn(false);
    goPhase('collapsed');
    setContentOn(true); // 折叠内容原位淡入，再收窄（收窄中它被 overflow 裁切，不产生位移）
    await wait(MORPH_MS);
  }, [goPhase]);

  /* ---------------- 交互 ---------------- */

  const handleMouseEnter = useCallback(() => {
    if (!displayedRef.current) return;
    wantExpandedRef.current = true;
    run(playExpand);
  }, [run, playExpand]);

  const handleMouseLeave = useCallback(() => {
    if (!displayedRef.current) return;
    wantExpandedRef.current = false;
    // 无论此刻是否已展开都排进队列：playExpand 是异步执行的，
    // "光标进→出"极快时 expandedRef 仍为 false，只判它就会把收起整个漏掉。
    run(playCollapse);
  }, [run, playCollapse]);

  const handleClick = useCallback(() => {
    const t = displayedRef.current;
    if (!t || leavingRef.current) return;
    if (expandedRef.current) {
      // 展开态点击 → 收起
      wantExpandedRef.current = false;
      run(playCollapse);
      return;
    }
    if (t.kind === 'music') {
      // 持久卡（音乐）折叠态点击 → 展开
      wantExpandedRef.current = true;
      run(playExpand);
      return;
    }
    // 普通提示折叠态点击 → 关闭
    requestClose();
  }, [requestClose, run, playCollapse, playExpand]);

  const openPlayer = useCallback(() => setPlayerExpanded(true), [setPlayerExpanded]);

  /** 切换歌词卡 ⇄ 播放卡；选择写回偏好，下次 hover 展开直接进这个视图 */
  const toggleIslandView = useCallback(
    () => setIslandView(islandView === 'lyrics' ? 'play' : 'lyrics'),
    [islandView, setIslandView],
  );

  /* ---------------- 目标内容 → 驱动动画 ---------------- */

  // 目标内容：轻提示优先（用户刚操作完，注意力在反馈上），其次播放卡。
  // 写 ref 是为了让上面的异步动画段读到"此刻"的目标（state 是异步的）。
  const target: Shown | null = toast
    ? {
        kind: 'toast',
        key: `toast:${toast.id}`,
        id: String(toast.id),
        text: toast.text,
        status: KIND_TO_STATUS[toast.kind],
      }
    : currentSong
      ? {
          kind: 'music',
          key: `int:${currentSong.id}:${currentSong.name}`,
          id: 'music',
          text: currentSong.name,
          status: 'info',
        }
      : null;
  targetRef.current = target;

  const targetKey = target ? target.key : null;
  useEffect(() => {
    if (targetKey === lastKeyRef.current) return; // 展示键没变 → 单纯的 play/pause 翻转，不重播形变
    lastKeyRef.current = targetKey;
    if (!targetRef.current) {
      // 空闲：直接清空（组件本就 return null，不需要退场动画）
      setShown(null);
      setShownVisible(false);
      goPhase('circle');
      setContentOn(false);
      setCardOn(false);
      wantExpandedRef.current = false;
      return;
    }
    if (!displayedRef.current) run(playAppear);
    else run(playReplace);
  }, [targetKey, goPhase, run, playAppear, playReplace, setShown, setShownVisible]);

  /* ---------------- 全局 mousemove 兜底 ---------------- */

  const expanded = phase === 'expanded';
  useEffect(() => {
    if (!expanded) return;
    /**
     * 为什么需要这条兜底（不是可选优化）：
     * 实测个别情况下 onMouseLeave / onPointerLeave **不会触发**（光标移出时元素正在
     * 变形、或指针从一个子元素直接移出到窗口外），结果"光标已经走远，岛还保持展开"。
     * 所以展开期间直接监听 window.mousemove，按**岛体矩形 + 24px 容错边距**判定：
     * 只有确实出了这个矩形才收起 —— 加边距是为了避免在边缘来回抖动时反复收/展。
     */
    const onMove = (e: MouseEvent) => {
      if (!expandedRef.current) return;
      const el = shellRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const m = 24; // 容错边距
      const out =
        e.clientX < r.left - m ||
        e.clientX > r.right + m ||
        e.clientY < r.top - m ||
        e.clientY > r.bottom + m;
      if (out && !pendingLeaveRef.current) {
        pendingLeaveRef.current = true;
        // 下一帧再判一次：鼠标在同帧内可能又回到边距内（抖动），避免误收
        requestAnimationFrame(() => {
          pendingLeaveRef.current = false;
          handleMouseLeave();
        });
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [expanded, handleMouseLeave]);

  /* ---------------- 测量 ---------------- */

  // 折叠态自适应宽：量"这一行内容的自然宽"，写到内联 width 上才能被 transition 补间。
  // ⚠️ 展开态下这一行是 width:100%（跟随胶囊），量到的是容器宽不是自然宽 → 必须跳过，
  // 否则会用它当收起目标，胶囊就永远收不回去了。
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => {
      if (phaseRef.current === 'expanded') return;
      const w = Math.ceil(el.getBoundingClientRect().width);
      setRowWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayed]);

  // 标题溢出检测：溢出时右端加渐隐遮罩（代替省略号，长歌名/长提示读起来更完整）
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const check = () => setTitleOver(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayed, phase]);

  /* ---------------- 波形 ---------------- */

  const wave = useWaveform(isPlaying && displayed?.kind === 'music', WAVE_BARS);

  /* ---------------- 渲染 ---------------- */

  // 空闲态：既没有提示、也没有队列 → 不渲染任何 DOM（不占位）
  if (!toast && !hasQueue) return null;
  if (!displayed) return null;

  const kind = displayed.kind;
  const shownMusic = kind === 'music';
  const width =
    phase === 'expanded'
      ? EXPANDED_WIDTH
      : phase === 'circle'
        ? CIRCLE_SIZE
        : shownMusic
          ? MUSIC_COLLAPSED_WIDTH
          : Math.max(CIRCLE_SIZE, rowWidth);
  const height =
    phase === 'expanded'
      ? shownMusic
        ? MUSIC_EXPANDED_HEIGHT
        : TOAST_EXPANDED_HEIGHT
      : shownMusic
        ? MUSIC_COLLAPSED_HEIGHT
        : COLLAPSED_HEIGHT;

  return (
    <div className="di-wrap">
      <div
        ref={shellRef}
        className={
          'di-capsule ' +
          (shownMusic ? 'is-music' : 'is-toast') +
          (phase === 'expanded' ? ' is-expanded' : '') +
          (leaving ? ' is-leaving' : '')
        }
        role="status"
        aria-live="polite"
        style={{
          width: `${width}px`,
          height: `${height}px`,
          opacity: leaving ? 0 : visible ? 1 : 0,
        }}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerLeave={handleMouseLeave}
      >
        {shownMusic && currentSong ? (
          <MusicCard
            song={currentSong}
            coverUrl={coverProxyUrl(currentSong.cover, proxyPort)}
            playing={isPlaying}
            contentOn={contentOn}
            cardOn={cardOn}
            levels={wave.levels}
            real={wave.real}
            onPrev={() => prevTrack()}
            onNext={() => nextTrack()}
            onToggle={() => togglePlay()}
            onOpen={openPlayer}
            view={islandView}
            lines={lyrics}
            highlight={lyricsHighlight}
            onToggleView={toggleIslandView}
          />
        ) : (
          <div className="di-row" ref={rowRef}>
            <span className="di-lead" aria-hidden="true">
              <span className={'di-dot di-dot-' + displayed.status} />
            </span>
            <span
              ref={titleRef}
              className={titleOver ? 'di-title is-clip' : 'di-title'}
              // 文字"浮现"用透明度（圆形阶段先不显示），而不靠胶囊扩开时被裁出来
              style={{ opacity: contentOn ? 1 : 0 }}
            >
              {displayed.text}
            </span>
            <span
              className="di-close"
              style={{ opacity: contentOn ? 1 : 0, pointerEvents: contentOn ? 'auto' : 'none' }}
            >
              <IconButton
                title="关闭提示"
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose();
                }}
              >
                <X size={12} />
              </IconButton>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 音乐卡：折叠态 = 封面 + 歌名 + 波形；展开态 = 播放卡（歌手 + 进度 + 传输控件）
 * 或**歌词卡**（两行歌词 + 传输控件），由 `view` 决定。
 *
 * 封面与歌名是**单一共享元素**：折叠/展开靠 transform 的 x/y/scale 补间到两个位置
 * （等价于参考实现用 framer-motion 对 x/y/scale 做数值插值），而不是两套元素互相淡入淡出 ——
 * 后者在切换瞬间会看到"两个封面"，前者是同一个封面在长/挪。
 * 两个视图共用这一个封面/歌名，所以切视图时不会"闪一下"。
 */
function MusicCard({
  song,
  coverUrl,
  playing,
  contentOn,
  cardOn,
  levels,
  real,
  view,
  lines,
  highlight,
  onPrev,
  onNext,
  onToggle,
  onToggleView,
  onOpen,
}: {
  song: Song;
  coverUrl: string;
  playing: boolean;
  contentOn: boolean;
  cardOn: boolean;
  levels: number[];
  real: boolean;
  view: IslandView;
  lines: ParsedLyricLine[];
  /** 用户选的歌词高亮色（store 的 lyricsHighlightColor） */
  highlight: string;
  onPrev: () => void;
  onNext: () => void;
  onToggle: () => void;
  onToggleView: () => void;
  onOpen: () => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  // 换歌要把"封面加载失败"重置掉，否则下一首永远显示占位块
  useEffect(() => setCoverFailed(false), [song.cover]);

  const stop =
    (fn: () => void) =>
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation(); // 否则会冒泡到胶囊，被当成"点击岛体 → 收起"
      fn();
    };

  /*
   * 歌词卡根节点要**自己注入一遍**歌词变量（--lyr-hl / --lyr-text / 字号）。
   *
   * 为什么不能靠继承：展开播放器把它们注入在 `.music-exp` 根上，靠 CSS 变量往下传；
   * 而灵动岛挂在主窗根上、**不在 .music-exp 子树里** —— 不注入就会全部走回落值
   * （`--lyr-text` 的回落是 #fff，卡片底色却是浅色/深色跟随主题的 --md-surface，
   *   浅色主题下就是"白字白底 = 完全看不见"）。
   * 所以取色/取字号的 owner 是"每个宿主各注入自己子树的那一份"，不是"谁抢到算谁的"。
   *
   * 高亮色跟随 `lyricsHighlightColor`（用户选的颜色应当处处生效）；
   * 字号用卡片固定值，不跟随 `lyricsFontSize`（理由见文件头的 ISLAND_LYR_SIZE 注释）。
   */
  const lyrStyle = {
    '--lyr-hl': highlight,
    '--lyr-text': 'var(--md-ink)',
    '--di-lyr-size': `${ISLAND_LYR_SIZE_NEXT}px`,
    '--di-lyr-on-size': `${ISLAND_LYR_SIZE}px`,
  } as CSSProperties;

  return (
    <div className="di-music">
      <div className="di-cover" aria-hidden="true">
        {coverUrl && !coverFailed ? (
          <img src={coverUrl} alt="" onError={() => setCoverFailed(true)} />
        ) : (
          <Music size={24} strokeWidth={2.2} />
        )}
      </div>

      <div className="di-name">{song.name}</div>

      {/* 波形：折叠态才显示；暂停时静止（语义是"正在出声"） */}
      <div
        className={real ? 'di-wave' : 'di-wave is-css'}
        data-on={playing ? '1' : '0'}
        style={{ opacity: contentOn ? 1 : 0 }}
        aria-hidden="true"
      >
        {levels.map((v, i) => (
          <i
            key={i}
            // 真实频谱可用时才写内联高度；降级走 CSS 动画时不能写，否则会顶掉动画
            style={real || !playing ? { height: `${Math.max(3, Math.round(v * 13))}px` } : undefined}
          />
        ))}
      </div>

      <div
        className={view === 'lyrics' ? 'di-card is-lyr' : 'di-card'}
        style={{ opacity: cardOn ? 1 : 0, pointerEvents: cardOn ? 'auto' : 'none' }}
      >
        {view === 'lyrics' ? (
          /**
           * 歌词区：只渲染「当前句 + 下一句」两行，当前句在上。
           * 复用 `KaraokeLyrics`（逐字推进的唯一实现），只把窗口调到 2 行、关掉滚动 ——
           * 小卡片里再写一份逐字实现是本项目明确禁止的（同一件事两份实现）。
           *
           * ⚠️ 整块 `onClick` 只 `stopPropagation`、不做别的事：胶囊自身的 onClick 是
           * "展开态点击 → 收起"，歌词区占了卡片一半面积，不拦住就会一点歌词就收回去。
           */
          <div className="di-lyr" style={lyrStyle} onClick={(e) => e.stopPropagation()}>
            {/*
             * ⚠️ `cardOn` 必须参与条件：`.di-card` 是**常驻渲染**的（折叠态只是 opacity:0），
             * 若只看 `lines.length`，逐字歌词的 RAF 循环会在胶囊折叠时也一直跑
             * —— 每帧读 `audio.currentTime` + 写一次 width，而用户此刻根本看不到卡片。
             * 挂在"大卡真正可见"时才渲染，RAF 就只在它有用时才存在。
             */}
            {cardOn && lines.length > 0 ? (
              <KaraokeLyrics
                lines={lines}
                fontPx={ISLAND_LYR_SIZE}
                windowSize={ISLAND_LYR_WINDOW}
                scroll={false}
              />
            ) : (
              // 纯音乐 / 歌词还没到：给固定文案，**不留空白**（空白卡片像半成品）
              <div className="di-lyr-empty">♪ 纯音乐，请欣赏</div>
            )}
          </div>
        ) : (
          <>
            <div className="di-artist">{song.artist || '未知歌手'}</div>
            <MusicProgress />
          </>
        )}
        <div className="di-ctl">
          <IconButton title="上一曲" onClick={stop(onPrev)}>
            <SkipBack size={20} />
          </IconButton>
          <IconButton title={playing ? '暂停' : '播放'} onClick={stop(onToggle)}>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </IconButton>
          <IconButton title="下一曲" onClick={stop(onNext)}>
            <SkipForward size={20} />
          </IconButton>
          {/* 视图切换键：歌词态→"播放"、播放态→"歌词"，两个方向都要有
              （只做一个方向 = 进了歌词卡出不来）。包一层 .di-toggle 是为了在视觉上
              与上面的传输控件区分开 —— 它切的是"看什么"，不是"播什么"。 */}
          <span className="di-toggle">
            <IconButton
              title={view === 'lyrics' ? '播放' : '歌词'}
              onClick={stop(onToggleView)}
            >
              {view === 'lyrics' ? <Play size={15} /> : <ListMusic size={15} />}
            </IconButton>
          </span>
          <span className="di-open">
            <IconButton title="打开播放器" onClick={stop(onOpen)}>
              <Maximize2 size={16} />
            </IconButton>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 进度行。**单独成组件**的原因：`progressMs` 每秒变很多次（timeupdate），
 * 让整个 DynamicIsland 跟着重渲染没有必要 —— 只有这一小段依赖它。
 */
function MusicProgress() {
  const progressMs = useMusicStore((s) => s.progressMs);
  const durationMs = useMusicStore((s) => s.durationMs);
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (progressMs / durationMs) * 100)) : 0;
  return (
    <div className="di-prog">
      <span className="di-time">{fmtTime(progressMs)}</span>
      <span className="di-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="di-time">{fmtTime(durationMs)}</span>
    </div>
  );
}

/* ================================================================== */
/* 音频电平：接真实音频，拿不到就降级                                  */
/* ================================================================== */

/**
 * 波形：连真实音频电平，拿不到就降级成 CSS 动画。
 *
 * ⚠️ 接管 `<audio>` 有一串各自都能**让声音消失**的坑：跨域资源 + 非 CORS 模式输出静音、
 * 上下文 suspended 时接管即静音、建了图没接回 destination……所以这些判断
 * **全部收口在 `@music/audioGraph`**（全项目唯一的接管入口）。
 * 本组件只做两件事：拿 AnalyserNode、把电平画出来。拿不到就 `real=false` 退回 CSS 动画 ——
 * 宁可没有真实波形，也**绝不能没声音**。
 */
function useWaveform(playing: boolean, bars: number): { levels: number[]; real: boolean } {
  const [levels, setLevels] = useState<number[]>(() => new Array(bars).fill(0));
  const [real, setReal] = useState(false);

  useEffect(() => {
    if (!playing) {
      // 暂停：波形静止。继续动会与"正在出声"的语义矛盾。
      setLevels(new Array(bars).fill(0));
      setReal(false);
      return;
    }
    let cancelled = false;
    let raf = 0;
    void (async () => {
      const got = await attachAnalyser(findAudioElement());
      if (cancelled) return;
      if (!got) {
        setReal(false); // 降级：CSS 动画波形
        return;
      }
      const tick = () => {
        if (cancelled) return;
        // 上下文被系统挂起时数据恒为 0，读它没有意义 → 回落 CSS 动画
        if (!isAudioContextRunning(got.ctx)) {
          setReal(false);
          return;
        }
        setReal(true);
        setLevels(readLevels(got.node, bars));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playing, bars]);

  return { levels, real };
}

/* ---------------- 动画时序小工具 ---------------- */

/** 等指定毫秒。时长与 CSS transition 同源（MORPH_MS / FADE_MS） */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 等两帧。为什么是两帧：一次 setState 到浏览器真正算出样式之间隔着一次渲染+一次布局，
 * 单帧在部分场景下仍在同一帧内（样式尚未提交），过渡就没有起点 —— 会看到"直接出现"而不是"淡入"。
 */
function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
