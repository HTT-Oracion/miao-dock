/**
 * 桌面歌词窗口（独立窗口，label 固定 `desktop-lyrics`）。
 *
 * 与主窗的契约（**已冻结，本文件只消费，不改字段名**）：
 * - 主窗 `emit('lyrics://state', payload)` → 本窗 `listen` 接收，形状见 `LyricsPayload`。
 * - 需要写回窗口状态时调 Rust 的 `save_lyrics_window_state` / `close_lyrics_window`。
 *
 * ## 这个窗口和主窗的三个根本差异
 *
 * ① **它是深色玻璃浮条，不是页面。** 它要浮在任意应用之上，浅色底在白底窗口上会看不见，
 *    所以这里自定一套深色玻璃配色（`--dl-*` 变量），不消费主窗的主题令牌 ——
 *    主窗能跟着用户切浅色，桌面歌词不能跟着变，否则在浅色应用上又消失了。
 *
 * ② **它不消费 zustand store。** store 是主窗的进程内状态，跨窗口不共享；
 *    跨窗口唯一可靠的通道是 Tauri 事件。这里连 `@music/store` 都不 import ——
 *    只 import 了 `@music/player-options` 的常量（纯编译期数值，不含状态）。
 *
 * ③ **它自己走表。** 见下面「进度推进」段。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import { Lock, X } from 'lucide-react';
import { LYRICS_COLOR_DEF, LYRICS_SIZE } from '@music/player-options';

// ------------------------------------------------------------------ 契约类型

/** 一行歌词。`ms` 是该行的**起始**毫秒（不是结束）。 */
export interface LyricsLine {
  ms: number;
  text: string;
}

/**
 * 主窗推来的歌词状态。字段名与主窗推送处逐字一致，**不要在本窗改名** ——
 * 改了就等于两个窗口讲两种话，症状是「推了但什么都不显示」，极难查。
 */
export interface LyricsPayload {
  /** null = 无当前歌曲 */
  songId: string | null;
  songName: string;
  artist: string;
  /** 已解析的歌词行，按 ms 升序；空数组 = 无歌词 */
  lines: LyricsLine[];
  playing: boolean;
  /**
   * 推送时刻的播放进度（毫秒）。本窗**以它为基准 + 本地计时**推进，
   * 之后不再指望主窗再推进度（`timeupdate` 每秒数次，事件扛不住）。
   */
  startedAtMs: number;
  durationMs: number;
  /** 主窗侧「推送时的墙上时钟」，用于校正两窗时钟漂移 */
  sentAtEpoch: number;
}

/** 主窗写偏好用的 localStorage 键（与主窗同 origin，实测共享 —— 台账 D-47） */
const LS_PREFS = 'miaodock.music.prefs';

/** 本窗自己写的一个键：记住用户上次锁没锁（Rust 侧也存了一份，但读回来要过命令） */
const LS_LOCKED = 'miaodock.lyrics.locked';

interface Prefs {
  lyricsFontSize?: number;
  lyricsHighlightColor?: string;
}

/**
 * 读主窗的歌词偏好。
 *
 * ⚠️ 只在**首屏读一次**，刻意不做实时同步：`localStorage` 的 `storage` 事件在
 * 同 origin 的不同 WebView 间**不保证触发**（WKWebView 已知差异）—— 依赖它做实时同步
 * 会得到「有时生效有时不生效」的幽灵行为，比「改了字号要重开窗口才生效」更难排查。
 * 用户改字号后重开歌词窗即可生效。
 *
 * 同理每次读都走 try/catch：JSON 可能被外部写坏（用户手改、别的版本残留），
 * 读失败就用默认值，不能让一个偏好把整个歌词窗拖崩。
 */
function readPrefs(): Required<Prefs> {
  const fallback = { lyricsFontSize: LYRICS_SIZE.def, lyricsHighlightColor: LYRICS_COLOR_DEF };
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Prefs;
    return {
      lyricsFontSize:
        typeof p.lyricsFontSize === 'number' ? p.lyricsFontSize : fallback.lyricsFontSize,
      lyricsHighlightColor: p.lyricsHighlightColor || fallback.lyricsHighlightColor,
    };
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ 纯函数

/**
 * 定位当前行：找**最后一个** `ms <= nowMs` 的行；没有则 -1。
 *
 * 为什么是「最后一个」而不是「第一个」：歌词行有首字前的静音段，
 * 时间落在两行之间时应当仍显示上一行（歌词的语义是「唱到这句了」，
 * 间隙属于上一句的延续）；反过来若用「第一个」，间隙会提前跳到下一句。
 *
 * 逐行线性扫而不是二分：桌面歌词一首歌通常几十到一两百行，且顺序天然接近有序
 * （用户 seek 才会造成大跳跃）。二分在随机 seek 后反而要先二分定位再加局部回退，
 * 收益抵不过复杂度。真要优化，正确的做法是缓存上次索引做局部前移/后移。
 */
function indexAt(lines: LyricsLine[], nowMs: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].ms <= nowMs) idx = i;
    else break;
  }
  return idx;
}

/** 窗口状态（Rust 侧 LyricsWindowState 的前端形状） */
interface WindowState {
  /** 距屏幕底部的像素（负值 = 贴底） */
  offset_y: number;
  locked: boolean;
}

// ------------------------------------------------------------------ 组件

export function DesktopLyrics() {
  const [payload, setPayload] = useState<LyricsPayload | null>(null);
  const [idx, setIdx] = useState(-1);
  const [locked, setLocked] = useState(false);
  /** 切歌/首帧时置 true，用来给新行加淡入（避免刚推进就抖一下） */
  const [fresh, setFresh] = useState(true);
  /** 拖动 / 锁定失败时的可见提示（只作告知，不阻断） */
  const [hint, setHint] = useState<string | null>(null);

  const prefs = useMemo(readPrefs, []);

  // ---- 进度推进（核心）----------------------------------------------------
  //
  // 判据：**不准依赖主窗再推**。所以本窗收到 payload 时记下两个基准：
  //   baseMs  = 收到的 startedAtMs（对齐到主窗的播放进度）
  //   basePerf= 收到的瞬间 performance.now()（本窗单调钟）
  // 之后 `now = baseMs + (performance.now() - basePerf)` 自己往前推。
  //
  // 为什么用 performance.now() 而不是 Date.now()：它是单调时钟，不受系统时间
  // 调整（NTP 校时、用户改时间、时区/夏令时切换）影响；Date.now() 跳一下歌词就飞。
  //
  // ⚠️ 为什么用 requestAnimationFrame 而**不是** `setInterval(..., 100)`：
  // 桌面歌词窗是**可见的置顶小窗**，rAF 与该窗口的渲染节奏对齐（跟得上刷新率），
  // 且切到别的应用后浏览器可能把定时器节流到 1Hz —— 歌词会一跳一跳。
  // rAF 在窗口不可见时自动暂停，回来时不会累积一堆过期回调。
  //
  // 两窗时钟漂移校正：主窗推的 `sentAtEpoch` 是它的 Date.now()。
  // 若不做任何处理，主窗与本窗的系统时钟若有偏差（正常情况下同机同钟，偏差极小，
  // 但跨唤醒/跨时区可能出现），歌词会整体偏一点。这里把漂移量折进基准，
  // 且**夹在 ±2000ms** —— 超过 2s 的差值更可能是主窗被挂起后的陈旧推送，
  // 全量采纳反而会让歌词瞬间跳到很偏的位置。
  const baseMsRef = useRef(0);
  const basePerfRef = useRef(0);
  const playingRef = useRef(false);
  const linesRef = useRef<LyricsLine[]>([]);
  const idxRef = useRef(-1);

  const applyPayload = useCallback((p: LyricsPayload) => {
    const drift = p.sentAtEpoch ? Date.now() - p.sentAtEpoch : 0;
    const clamped = Math.max(-2000, Math.min(2000, drift));
    baseMsRef.current = p.startedAtMs + clamped;
    basePerfRef.current = performance.now();
    playingRef.current = p.playing;
    linesRef.current = p.lines ?? [];
    setPayload(p);
    setIdx(indexAt(linesRef.current, baseMsRef.current));
    idxRef.current = indexAt(linesRef.current, baseMsRef.current);
    setFresh(true);
  }, []);

  // 订阅主窗推送。
  // ⚠️ 必须用 try/catch 包住 listen：非 Tauri 环境（直接在浏览器里开 lyrics.html 调试）
  // 没有事件桥，listen 会 reject，不兜住的话整个模块白屏、连静态降级态都看不到。
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    void (async () => {
      try {
        const off = await listen<LyricsPayload>('lyrics://state', (e) => {
          if (!disposed) applyPayload(e.payload);
        });
        if (disposed) off();
        else un = off;
      } catch {
        /* 无 Tauri 桥：保持「待播放」静态态 */
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, [applyPayload]);

  // rAF 推进循环。playing === false 时**不推进**（暂停必须真的停住）——
  // 暂停若还在走表，歌词会在暂停期间继续往前爬，这是最容易被当成「歌词乱跳」的 bug。
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (playingRef.current) {
        const now = baseMsRef.current + (performance.now() - basePerfRef.current);
        const next = indexAt(linesRef.current, now);
        if (next !== idxRef.current) {
          // 跳变超过 1 行说明中途发生过 seek / 主窗推送滞后：靠 CSS 淡入柔化，
          // 不用 JS 动画库（那会让这个「只有两行字」的窗口背上几十 KB 依赖）。
          idxRef.current = next;
          setIdx(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 淡入只在换行时播一次：fresh 置位后由下面的定时器关掉，
  // 否则每次 rAF 重建样式都会重播动画，看起来像在闪。
  useEffect(() => {
    if (!fresh) return;
    const t = window.setTimeout(() => setFresh(false), 400);
    return () => window.clearTimeout(t);
  }, [fresh, idx]);

  // 提示语自动消失：它是「刚发生的事」的回执，常驻会变成一块永久 UI 噪声。
  // 空依赖 + 内部计时器：只在 hint 变化时重置，读的是当次的 hint 值。
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 1800);
    return () => window.clearTimeout(t);
  }, [hint]);

  // ---- 窗口状态持久化 ----------------------------------------------------
  const win = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);

  const persist = useCallback(
    (next: { offset_y?: number; locked?: boolean }) => {
      const state: WindowState = {
        offset_y: next.offset_y ?? 0,
        locked: next.locked ?? locked,
      };
      // 位置存 Rust（跨进程重启保留，配置文件比 localStorage 稳），
      // 锁定态额外存一份 localStorage：本窗启动时不必等一次 IPC 往返就能拿到上次状态。
      try {
        localStorage.setItem(LS_LOCKED, JSON.stringify(state.locked));
      } catch {
        /* 隐私模式等禁写场景：忽略，锁定态退化为「本次窗口内有效」 */
      }
      void invoke('save_lyrics_window_state', { state }).catch(() => {
        /* 非 Tauri 环境或窗口已销毁：静默，位置丢失不影响本窗显示 */
      });
    },
    [locked],
  );

  // 启动时恢复锁定态。放在 effect 而不是 useState 初始值里：
  // 初始值只在首挂载算一次，而这里读 localStorage 与渲染顺序无关，effect 语义更清楚。
  useEffect(() => {
    try {
      if (localStorage.getItem(LS_LOCKED) === 'true') setLocked(true);
    } catch {
      /* 读不到就按未锁定处理 */
    }
  }, []);

  // ---- 拖动 --------------------------------------------------------------
  //
  // ⚠️⚠️ macOS 平台限制（务必保留注释）：`startDragging()` **只能在按下事件里直接调，
  // 不能 await 之后再调**。它内部走的是「把这次原生拖动会话交给系统」，
  // 系统要求调用发生在用户手势的同一个事件循环内；一旦 await 过（哪怕只是
  // `await getCurrentWindow()`），手势上下文已经失效，调用会被静默忽略 ——
  // 表现是「按住没反应」，且没有任何报错，极难定位。
  // 所以这里**提前**把 win 备好（useMemo），按下回调里直接同步调用。
  const draggingRef = useRef(false);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 关闭按钮与锁标记不参与拖动，否则点关闭会变成「拖了一下没关掉」。
      if ((e.target as HTMLElement).closest('button')) return;
      if (locked) {
        setHint('已锁定 · 双击解锁');
        return;
      }
      // 双击的第一次按下也会走到这里。若不区分，`detail === 2` 时既发起了拖动
      // 又要切锁定，macOS 上两者会互相打断（表现为「双击没反应，只拖了一下」）。
      // 故第二次按下（detail 2）直接不拖，把这次手势完整留给双击。
      if (e.detail > 1) return;
      if (!win) return;
      // 同上：这里必须是**同步**调用，不能有 await。
      draggingRef.current = true;
      void win.startDragging().catch(() => {
        draggingRef.current = false;
        setHint('拖动不可用（窗口权限不足）');
      });
    },
    [locked, win],
  );

  /**
   * 拖动结束后持久化位置。
   *
   * `startDragging()` 返回的 Promise 在**拖动开始**时就 resolve 了（它只是把会话
   * 交给系统），所以不能靠 await 它来判断「拖完了」—— 那样存的是拖动**开始**时的位置。
   * 改为监听 mouseup：原生拖动会话期间鼠标事件仍会回到 WebView，抬手即拖动结束。
   * 读 `outerPosition` 得到的是**物理像素**，而 Rust 侧 `position()` 期望逻辑像素，
   * 所以要除以 scaleFactor —— Retina 屏上不除会差一倍（表现为重开窗口后位置飘）。
   */
  const savePosition = useCallback(async () => {
    if (!win) return;
    try {
      const [pos, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      // 契约是「距屏幕底部的像素（负值 = 贴底）」，故用 屏幕高 - 窗口底边。
      // 取不到显示器高度时退回 0：宁可不完美也不要失败。
      let screenH = 0;
      try {
        // currentMonitor 是模块级函数（不是 Window 实例方法）——
        // 它报的是「光标当前所在的那个显示器」，多屏场景下正是歌词窗所在屏。
        const mon = await currentMonitor();
        if (mon) screenH = mon.size.height / scale;
      } catch {
        screenH = 0;
      }
      const bottomGap = screenH > 0 ? screenH - (pos.y / scale + size.height / scale) : 0;
      persist({ offset_y: Math.round(bottomGap) });
    } catch {
      /* 读位置失败：跳过持久化 */
    }
  }, [win, persist]);

  useEffect(() => {
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      void savePosition();
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [savePosition]);

  // ---- 锁定（双击切换）---------------------------------------------------
  //
  // ⚠️ macOS 上「点击穿透」做不到：Tauri 的 `always_on_top` 只保证浮在上面，
  // 没有「鼠标事件穿透到下层应用」这种能力（Windows 才有 WS_EX_TRANSPARENT）。
  // 所以 locked **只做「不可拖动 + 半透明 + 锁标记」**，
  // 任何文案都不得承诺「鼠标穿透」「不影响下层应用点击」——
  // 承诺做不到的事等于埋一个更坏的坑：用户会以为挡住了，然后发现下层还是点不动。
  const toggleLock = useCallback(() => {
    const next = !locked;
    setLocked(next);
    setHint(next ? '已锁定 · 再次双击解锁' : '已解锁 · 可拖动');
    persist({ locked: next });
  }, [locked, persist]);

  const onDoubleClick = useCallback(() => {
    toggleLock();
  }, [toggleLock]);

  // ---- 关闭 --------------------------------------------------------------
  // ⚠️ 必须调 Rust 的 `close_lyrics_window`，**不能用 `window.close()`**：
  // 后者只关掉这个 WebView，主窗的「桌面歌词」开关状态不会同步，
  // 于是开关还亮着、窗口却没了 —— 用户再点开关会走「已存在则 focus」的分支，
  // 表现为「点了没反应」。窗口的生死归主窗管（见 lyrics_window.rs 的注释）。
  const onClose = useCallback(() => {
    void invoke('close_lyrics_window').catch(() => {
      /* 窗口已被主窗关掉：忽略 */
    });
  }, []);

  // ---- 降级态 ------------------------------------------------------------
  const hasSong = payload !== null && payload.songId !== null;
  const lines = payload?.lines ?? [];
  const noLyrics = hasSong && lines.length === 0;

  const cur = idx >= 0 ? lines[idx] : null;
  const prev = idx > 0 ? lines[idx - 1] : null;

  /**
   * 「还没到第一句」（idx === -1）。
   *
   * 契约要求的降级文案是「纯音乐」提示，这里照办：idx 为 -1 时当前行确实**没有歌词可显示**，
   * 而桌面歌词只有两行的空间，塞别的内容会把双行形态撑变形。
   * 需要说明的边界：这一档同时覆盖「这歌没歌词」和「有歌词但还在首字前的间奏」，
   * 后者说「纯音乐」严格讲不准确（间奏确实是纯器乐，措辞成立），但它无法与前者区分 ——
   * 歌词窗拿不到「这歌到底有没有词」之外的额外信息。
   * 要更准就得等主窗多推一个 hasLyrics 标志，那要改冻结契约，不在本窗能做。
   */
  const beforeFirst = hasSong && idx < 0;

  const size = prefs.lyricsFontSize;
  const curSize = Math.round(size * 1.15);

  return (
    <div
      className={`dl-root${locked ? ' is-locked' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      role="status"
      aria-label="桌面歌词"
    >
      <div className={`dl-bar${fresh ? ' is-fresh' : ''}`}>
        {!hasSong ? (
          // 无歌曲：窗口**保持存在**，只显示极简待播放态。
          // ⚠️ 绝不 `window.close()` —— 那是主窗的职责（它调 close_lyrics_window）。
          // 理由：用户很可能「先开窗口再播歌」；窗口自己关掉会让主窗的开关状态
          // 与实际窗口数不符，用户看到的现象是「开关关不掉 / 点了没反应」。
          <div className="dl-idle">
            <span className="dl-note">♪</span>
            <span className="dl-idle-text">待播放</span>
          </div>
        ) : noLyrics ? (
          // 无歌词：不能显示一条空白的浮条（那是半成品），也仍要给出信息。
          <div className="dl-meta">
            <div className="dl-meta-name">{payload?.songName}</div>
            <div className="dl-meta-artist">{payload?.artist}</div>
            <div className="dl-tip">♪ 纯音乐，请欣赏</div>
          </div>
        ) : (
          <>
            {/* 上一行：低透明度。桌面歌词的经典双行形态 —— 上一句留在视野里，
                眼睛不用来回扫。min-height 固定，防止长/短句切换时整条浮条高度跳动。 */}
            <div className="dl-line dl-prev">{prev?.text ?? ''}</div>
            {cur ? (
              <div
                className="dl-line dl-cur"
                style={{ fontSize: `${curSize}px`, color: prefs.lyricsHighlightColor }}
              >
                {cur.text}
              </div>
            ) : (
              // 还没到第一句：给「纯音乐」提示，不留空白（空白浮条是半成品）。
              // 提示用弱化色而非高亮色 —— 它不是正在唱的词，不该抢焦点。
              <div className="dl-line dl-cur dl-wait" style={{ fontSize: `${curSize}px` }}>
                {beforeFirst ? '♪ 纯音乐，请欣赏' : ''}
              </div>
            )}
          </>
        )}

        <button className="dl-close" onClick={onClose} title="关闭桌面歌词" aria-label="关闭桌面歌词">
          <X size={13} strokeWidth={2.4} />
        </button>

        {locked ? (
          <span className="dl-lock" title="已锁定（双击解锁）">
            <Lock size={11} strokeWidth={2.4} />
          </span>
        ) : null}
      </div>

      {hint ? <div className="dl-hint">{hint}</div> : null}

      <style>{WINDOW_CSS}</style>
    </div>
  );
}

// ------------------------------------------------------------------ 窗口样式

/**
 * 窗口样式 —— **内联注入，不进 `app/src/styles/app.css`**。
 *
 * 为什么：这份样式只在这个窗口存在（深色玻璃浮条 + 置顶小窗几何）。
 * 放进全局 app.css 会让主窗也背上这份字节，而主窗永远不会用到其中任何一条 ——
 * 「只在一个窗口存在的样式进全局」是后来者删不掉的负担。
 */
const WINDOW_CSS = `
/* 字体令牌兜底 —— 必须在本窗口自己声明。
   \`--md-font-body\` 平时由主窗的 useThemeTokens（theme/apply.ts 的 cssVars）写进
   documentElement；**本窗不会跑那条路径**（没有 App.tsx、没有主题切换），
   不兜底就会退成浏览器默认字形，与主窗完全不是一款字。
   这里显式给出与 tokens.ts FONT.body 同序的栈，但**去掉 @fontsource 字体名**：
   本入口刻意不引 @fontsource 的 CSS（那是给主窗正文用的，桌面歌词只要系统栈），
   写上未加载的字体名只会让它逐个落空。最终落到系统的中文字体。 */
.dl-root {
  --md-font-body: system-ui, -apple-system, 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', sans-serif;
}

/* 窗口本体：整窗透明，浮条自己画自己的深色玻璃 —— 透明窗口 + 圆角浮条是
   「不像应用窗口」的关键，否则用户会看到一个带标题栏的小播放器。 */
.dl-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  /* 桌面歌词要能整体拖走，因此整窗禁用文本选择 */
  user-select: none;
  -webkit-user-select: none;
  overflow: hidden;
  font-family: var(--md-font-body);
}

/* 深色玻璃浮条：深色底 + 轻微背景模糊 + 圆角 + 细描边。
   描边用半透明白而不是实色 —— 浮在深色应用上时实色描边会画出一道硬边。 */
.dl-bar {
  position: relative;
  min-width: 300px;
  max-width: 480px;
  padding: 14px 44px 14px 22px;
  border-radius: var(--md-radius-lg, 22px);
  background: linear-gradient(180deg, rgba(38, 33, 64, 0.82), rgba(20, 15, 41, 0.78));
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
  cursor: grab;
}

/* 锁定：降不透明度 + 换光标。macOS 上没有点击穿透，所以**不承诺**穿透，
   这里只表达「这条不会再被拖走了」。 */
.dl-root.is-locked .dl-bar {
  opacity: 0.72;
  cursor: default;
}
.dl-root.is-locked .dl-bar:hover {
  opacity: 0.92;
}

/* 换行/换歌时的一次性淡入：跳变（seek）用短过渡柔化，避免生硬瞬切。
   纯 CSS transition/animation —— 不引 JS 动画库（见上面注释）。 */
.dl-bar.is-fresh .dl-line {
  animation: dl-fade 260ms ease-out;
}
@keyframes dl-fade {
  from { opacity: 0.15; }
  to   { opacity: 1; }
}

/* 两行歌词。min-height 固定成 1.4em：短句（如「嗯」）不写 min-height 会让
   整条浮条随内容上下跳，视觉上像在抽搐。 */
.dl-line {
  min-height: 1.4em;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 当前行用大小 + 颜色两级焦点，不靠加粗：19px 上下加粗在中文小字号下发糊。 */
  font-weight: 400;
  letter-spacing: 0.01em;
  text-align: center;
  transition: opacity 200ms ease;
}
.dl-prev {
  font-size: 0.92em;
  /* 上一行低透明度：留住上一句，但明确让位给当前行 */
  color: rgba(245, 242, 255, 0.42);
  margin-bottom: 2px;
}
.dl-cur {
  color: #ffe066;
}
/* 未到第一句时的「纯音乐」提示：弱化色，不抢「正在唱的词」的焦点 */
.dl-wait {
  color: rgba(245, 242, 255, 0.66);
}

/* 无歌词：显示歌名/歌手 + 「纯音乐」提示，而不是留一条空白浮条 */
.dl-meta { text-align: center; }
.dl-meta-name {
  font-size: 14px;
  line-height: 1.35;
  color: rgba(245, 242, 255, 0.88);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-meta-artist {
  font-size: 12px;
  line-height: 1.35;
  color: rgba(245, 242, 255, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-tip {
  margin-top: 3px;
  font-size: 12.5px;
  color: rgba(245, 242, 255, 0.66);
}

/* 无歌曲（待播放）：极简，一行小字 —— 窗口留着是为了让用户先开窗再播歌 */
.dl-idle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 22px;
}
.dl-note { font-size: 13px; color: rgba(245, 242, 255, 0.5); }
.dl-idle-text {
  font-size: 12.5px;
  color: rgba(245, 242, 255, 0.5);
  letter-spacing: 0.08em;
}

/* 关闭按钮：常驻极低透明度，hover 才显现 —— 常显会抢歌词的注意力 */
.dl-close {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: rgba(245, 242, 255, 0.32);
  opacity: 0.55;
  transition: opacity 140ms ease, background 140ms ease, color 140ms ease;
}
.dl-bar:hover .dl-close { opacity: 1; }
.dl-close:hover {
  background: rgba(255, 255, 255, 0.12);
  color: rgba(245, 242, 255, 0.92);
}

/* 锁定标记：小锁 + 低透明度，出现在右下，与关闭按钮分开占位 */
.dl-lock {
  position: absolute;
  right: 30px;
  bottom: 8px;
  display: flex;
  color: rgba(245, 242, 255, 0.5);
  pointer-events: none;
}

/* 锁定/失败提示：浮条下方一行小字，几秒后由调用处自行消失 */
.dl-hint {
  font-size: 11px;
  color: rgba(245, 242, 255, 0.55);
  background: rgba(20, 15, 41, 0.7);
  padding: 2px 8px;
  border-radius: 999px;
}

@media (prefers-reduced-motion: reduce) {
  .dl-bar.is-fresh .dl-line { animation: none; }
  .dl-line { transition: none; }
}
`;
