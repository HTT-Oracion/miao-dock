/**
 * 桌面歌词窗口（独立窗口，label 固定 `desktop-lyrics`）。
 *
 * 与主窗的契约（**已冻结，本文件只消费，不改字段名**）：
 * - 主窗 `emit('lyrics://state', payload)` → 本窗 `listen` 接收，形状见 `LyricsPayload`。
 *   ⚠️ 该事件上有**两种**载荷：完整状态（`LyricsPayload`）与只带偏好的轻量载荷
 *   （`LyricsPrefsPayload`，用户改字号/颜色/行数时发）。靠 `prefsOnly` 判别，
 *   判别字段名必须与主窗 `music/ipc.ts` 逐字一致（两侧刻意各自声明类型，见 ②）。
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
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Lock, X } from 'lucide-react';
import {
  DL_BASE_COLOR_DEF,
  DL_HIGHLIGHT_COLOR_DEF,
  DL_LINE_COUNT,
  DL_LYRICS_SIZE,
} from '@music/player-options';

// ------------------------------------------------------------------ 契约类型

/** 一行歌词。`ms` 是该行的**起始**毫秒（不是结束）。 */
export interface LyricsLine {
  ms: number;
  text: string;
}

/**
 * 桌面歌词的**独立**偏好。字段名与主窗 `music/ipc.ts` 的 `DesktopLyricsPrefs`
 * **逐字一致**（本窗刻意不 import 主窗类型，见文件头 ②）。
 *
 * 为什么是独立的一套而不是复用主窗的 `lyricsFontSize`：展开播放器可铺满整屏，
 * 本窗只有 160px 高且不可缩放（`resizable(false)`，几何在 Rust 侧）。
 * 共用一个字号时，用户为详情页调到 48 会把本窗撑爆 ——
 * 两个窗口的可用空间差一个量级，偏好就不该是同一个。
 */
export interface DesktopLyricsPrefs {
  /** 当前（高亮）行字号，px */
  fontSize: number;
  /** 当前行颜色 */
  highlightColor: string;
  /** 其余（未高亮）行颜色 */
  baseColor: string;
  /** 一次显示几行（含当前行，当前行在最下方） */
  lineCount: number;
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
  /**
   * 桌面歌词的独立偏好。完整推送总会带上（新开的窗口首帧就有正确外观）；
   * 标成可选是为了**兼容缺失** —— 缺了就一直用本窗已经读到的值，而不是回默认值。
   */
  desktopLyrics?: DesktopLyricsPrefs;
}

/**
 * 「只带偏好」的轻量载荷：用户拖字号滑杆 / 点色点时会连发几十条这样的消息。
 *
 * 为什么要能和完整载荷共用同一个事件：Rust 的 `lyrics_push` 收的是
 * `serde_json::Value` 并原样 emit，不解析结构，所以多一种载荷形状**不必改 Rust**。
 * 本窗据此**不重置进度基准**（只改外观）—— 否则每拖一下字号，歌词都会按
 * 那一次推送的进度重新对齐，drag 过程中会看到歌词轻微抖动。
 */
export interface LyricsPrefsPayload {
  /** 判别字段：true 表示这条只带偏好、不含歌词行与进度。名字与主窗 ipc.ts 逐字一致 */
  prefsOnly: true;
  desktopLyrics: DesktopLyricsPrefs;
}

/** 判别：是不是「只带偏好」的轻量载荷 */
function isPrefsOnly(p: LyricsPayload | LyricsPrefsPayload): p is LyricsPrefsPayload {
  return (p as LyricsPrefsPayload).prefsOnly === true;
}

/** 主窗写偏好用的 localStorage 键（与主窗同 origin，实测共享 —— 台账 D-47） */
const LS_PREFS = 'miaodock.music.prefs';

/** 本窗自己写的一个键：记住用户上次锁没锁（Rust 侧也存了一份，但读回来要过命令） */
const LS_LOCKED = 'miaodock.lyrics.locked';

/** localStorage 里那四项的原始形状（读进来的是未知类型，逐项校验后再用） */
interface StoredPrefs {
  desktopLyricsFontSize?: unknown;
  desktopLyricsHighlightColor?: unknown;
  desktopLyricsBaseColor?: unknown;
  desktopLyricsLineCount?: unknown;
}

/** 夹到区间内的整数；拿不到有效数字就用默认值（偏好被外部写坏时不能让本窗崩） */
function clampInt(v: unknown, min: number, max: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * 把任意来源的偏好（localStorage / 推送载荷）规整成合法值。
 *
 * ⚠️ 两个入口都要过这一道：推送里若混进越界值（旧版本存的 48、被手改过的
 * localStorage），字号会把浮条撑出窗口、行数会渲染出 9 行 —— 而这类
 * 「看起来像渲染 bug」的现象最难联想到这里。区间常量是唯一权威（player-options）。
 */
function normalizePrefs(p: Partial<DesktopLyricsPrefs> | null | undefined): DesktopLyricsPrefs {
  return {
    fontSize: clampInt(p?.fontSize, DL_LYRICS_SIZE.min, DL_LYRICS_SIZE.max, DL_LYRICS_SIZE.def),
    highlightColor: p?.highlightColor || DL_HIGHLIGHT_COLOR_DEF,
    baseColor: p?.baseColor || DL_BASE_COLOR_DEF,
    lineCount: clampInt(p?.lineCount, DL_LINE_COUNT.min, DL_LINE_COUNT.max, DL_LINE_COUNT.def),
  };
}

/**
 * 读主窗写的偏好（**只覆盖 localStorage 那一路**；实时那一路见 applyPayload）。
 *
 * 首屏读 localStorage 是必需的：窗口是"先建好、再推状态"的，而用户从头到尾没改过
 * 设置时，主窗的完整推送也不会带新值 —— 不读这一下，用户上次调好的外观就丢了。
 *
 * ⚠️ 刻意**不依赖 `storage` 事件**做实时同步：它在同 origin 的不同 WebView 间
 * **不保证触发**（WKWebView 已知差异），依赖它会得到「有时生效有时不生效」的幽灵行为。
 *
 * 每次读都走 try/catch：JSON 可能被外部写坏（用户手改、别的版本残留），
 * 读失败就用默认值，不能让一个偏好把整个歌词窗拖崩。
 */
function readPrefs(): DesktopLyricsPrefs {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (!raw) return normalizePrefs(null);
    const p = JSON.parse(raw) as StoredPrefs;
    return normalizePrefs({
      fontSize: p.desktopLyricsFontSize as number | undefined,
      highlightColor: p.desktopLyricsHighlightColor as string | undefined,
      baseColor: p.desktopLyricsBaseColor as string | undefined,
      lineCount: p.desktopLyricsLineCount as number | undefined,
    });
  } catch {
    return normalizePrefs(null);
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

/**
 * 窗口状态（Rust 侧 `LyricsWindowState` 的前端形状）。
 *
 * ⚠️ 字段名与个数必须与 Rust 侧**逐字一致**（含 `x`）。Rust 用 serde 反序列化，
 * 对不上会**整条命令失败** —— 而失败被 `.catch()` 静默吞掉，症状只是"位置不记忆"。
 * 这条契约由断言 `LYRICS.stateFieldMatch` 守着（它会从 Rust 结构体解析字段名来比对）。
 *
 * 口径同样是**屏幕坐标 + 逻辑像素**（不是"距底距离"，不是物理像素）。
 */
interface WindowState {
  /** 窗口左上角的屏幕 x 坐标（逻辑像素）；-1 = 未记录 */
  x: number;
  /** 窗口左上角的屏幕 y 坐标（逻辑像素）；-1 = 未记录 */
  y: number;
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

  /**
   * 桌面歌词的独立偏好。
   *
   * 初值走 localStorage（首屏就得有正确外观，见 `readPrefs`），之后由主窗推送更新 ——
   * 两条路都过 `normalizePrefs`，所以不变量是"state 里永远是合法值"。
   * 用 useState 而不是 useMemo(readPrefs)：它**会被推送改写**，不是一次性的派生值。
   */
  const [prefs, setPrefs] = useState<DesktopLyricsPrefs>(readPrefs);

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
    // 偏好跟着完整推送一起来：先落外观，再走进度基准（两者互不影响）
    if (p.desktopLyrics) setPrefs(normalizePrefs(p.desktopLyrics));
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

  /**
   * 只应用偏好，**不碰进度基准**。
   *
   * 用户拖字号滑杆时会连发几十条 prefsOnly 载荷；若每条都走 `applyPayload`，
   * 歌词会被反复按"那一条推送里的进度"重新对齐 —— drag 过程中能看到歌词轻微抖动，
   * 而这不是任何人的意图。偏好与进度是正交的，就分开处理。
   */
  const applyPrefsOnly = useCallback((p: LyricsPrefsPayload) => {
    setPrefs(normalizePrefs(p.desktopLyrics));
  }, []);

  // 订阅主窗推送。
  // ⚠️ 必须用 try/catch 包住 listen：非 Tauri 环境（直接在浏览器里开 lyrics.html 调试）
  // 没有事件桥，listen 会 reject，不兜住的话整个模块白屏、连静态降级态都看不到。
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    void (async () => {
      try {
        const off = await listen<LyricsPayload | LyricsPrefsPayload>('lyrics://state', (e) => {
          if (disposed) return;
          // 两种载荷共用同一个事件，靠 prefsOnly 判别（见 isPrefsOnly 的注释）
          if (isPrefsOnly(e.payload)) applyPrefsOnly(e.payload);
          else applyPayload(e.payload);
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
  }, [applyPayload, applyPrefsOnly]);

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

  /**
   * 已记录的位置（本地缓存）。
   *
   * ⚠️ 存在的理由：Rust 侧的 `save_lyrics_window_state` 是**全量覆盖**，
   * 而本组件有两种调用场景 —— ① 拖完存位置 ② 切锁定时只改 `locked`。
   * 若第 ② 种也照直传 `{ locked }`，`x`/`y` 会以默认值 `-1` 覆盖掉用户拖好的位置
   * （症状：一锁定，下次打开就回到默认位置）。所以这里缓存已知值做**部分更新**。
   */
  const posRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });

  const persist = useCallback(
    (next: { x?: number; y?: number; locked?: boolean }) => {
      const known = posRef.current;
      // 只更新调用方显式给出的字段，其余沿用已记录值 —— 见 posRef 的注释
      if (next.x !== undefined) known.x = next.x;
      if (next.y !== undefined) known.y = next.y;

      const state: WindowState = {
        x: known.x,
        y: known.y,
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
      const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
      // ⚠️ 存**窗口左上角的屏幕坐标**（x 与 y 都要，只存 y 会让水平位置丢失），
      // 不做"距底距离"换算 —— Rust 侧的字段就是坐标，换算等于引入第二套口径。
      // 唯一需要的换算是除以 scaleFactor：outerPosition() 返回**物理像素**，
      // 而 Rust 的 position() 收**逻辑像素**（Retina 上不除会飘一倍）。
      const scaleSafe = scale > 0 ? scale : 1;
      persist({ x: Math.round(pos.x / scaleSafe), y: Math.round(pos.y / scaleSafe) });
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

  /**
   * 「还没到第一句」（idx === -1）。
   *
   * 契约要求的降级文案是「纯音乐」提示，这里照办：idx 为 -1 时当前行确实**没有歌词可显示**，
   * 而桌面歌词只有少数几行的空间，塞别的内容会把浮条形态撑变形。
   * 需要说明的边界：这一档同时覆盖「这歌没歌词」和「有歌词但还在首字前的间奏」，
   * 后者说「纯音乐」严格讲不准确（间奏确实是纯器乐，措辞成立），但它无法与前者区分 ——
   * 歌词窗拿不到「这歌到底有没有词」之外的额外信息。
   * 要更准就得等主窗多推一个 hasLyrics 标志，那要改冻结契约，不在本窗能做。
   */
  const beforeFirst = hasSong && idx < 0;

  /**
   * 可见的歌词行：**当前行在最下方**，往上回溯 `lineCount - 1` 行。
   *
   * 为什么当前行排在最后一行而不是居中：改造前就是「上一行 + 当前行」（当前行在下），
   * 这是最小惊讶的推广 —— `lineCount === 2` 时与改造前逐像素等价。
   * 元素为 `null` 表示"那一格还没有词"（开头几句之前）：仍然渲染成等高空行，
   * 否则行数一变整条浮条的高度与位置就会跳。
   */
  const rows: (LyricsLine | null)[] = [];
  for (let k = prefs.lineCount - 1; k >= 0; k -= 1) {
    rows.push(idx - k >= 0 ? lines[idx - k] : null);
  }

  return (
    <div
      className={`dl-root${locked ? ' is-locked' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      /* 行数写到 DOM 上：CSS 据此在行数多时收紧浮条上下内边距（见 WINDOW_CSS）。
         用属性而不是多个类名 —— 行数是连续量，类名会退化成 dl-lines-4 / -5 的枚举。 */
      data-lines={prefs.lineCount}
      role="status"
      aria-label="桌面歌词"
    >
      {/*
        字号注入在**浮条**上（而不是逐行写 px）：
        `.dl-side` 用 0.86em、`.dl-cur` 用 1em 相对它换算 —— 逐行写死 px 就没法
        让副行随主行等比缩放，改字号时两行的比例会散架。
      */}
      <div
        className={`dl-bar${fresh ? ' is-fresh' : ''}`}
        style={{ fontSize: `${prefs.fontSize}px` }}
      >
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
            {rows.map((line, i) => {
              const isCur = i === rows.length - 1;
              if (isCur) {
                return line ? (
                  // 当前行：用用户配的高亮色。大小差异已由 .dl-cur 的 1em 承担，
                  // 颜色差异由这里的 inline color 承担 —— 两级焦点，不再叠「×1.15」的放大。
                  <div key={`cur-${idx}`} className="dl-line dl-cur" style={{ color: prefs.highlightColor }}>
                    {line.text}
                  </div>
                ) : (
                  // 还没到第一句：给「纯音乐」提示，不留空白（空白浮条是半成品）。
                  // ⚠️ 提示色**不跟**用户配的「未高亮行颜色」走 —— 它不是歌词，
                  // 用副行色会让人以为那是一句词。
                  <div key="cur-wait" className="dl-line dl-cur dl-wait">
                    {beforeFirst ? '♪ 纯音乐，请欣赏' : ''}
                  </div>
                );
              }
              // 其余行（上一句及更早）：用用户配的底色。桌面歌词的经典形态 ——
              // 前几句留在视野里，眼睛不用来回扫。
              return (
                <div
                  key={`side-${i}-${idx}`}
                  className="dl-line dl-side"
                  style={{ color: prefs.baseColor }}
                >
                  {line?.text ?? ''}
                </div>
              );
            })}
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

/* 行数多时收紧上下内边距。
   窗口是 160px 高且 resizable(false)（几何写死在 Rust 的 WIN_H，本窗改不了），
   所以能做的只有"让内容自己挤进去"：默认字号下 5 行 ≈ 155px，正好卡在窗口内；
   若不收这 6px，5 行会被 overflow:hidden 裁掉一条边。
   这只是兜底 —— 大字号 + 多行的组合仍会溢出（见弹窗里的说明与交付报告的"未验证"项）。 */
.dl-root[data-lines='4'] .dl-bar,
.dl-root[data-lines='5'] .dl-bar {
  padding-top: 8px;
  padding-bottom: 8px;
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

/* 歌词行。min-height 固定成 1.3em：短句（如「嗯」）不写 min-height 会让
   整条浮条随内容上下跳，视觉上像在抽搐；行数可调之后，固定的 min-height
   还额外保证"行数切换时整条浮条的高度是 N×固定值"，不会忽高忽低。
   1.3 而不是 1.4 是为了让 5 行的默认组合能塞进 160px 的窗口。 */
.dl-line {
  min-height: 1.3em;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 焦点只由「大小 + 颜色」两级表达，不靠加粗：22px 上下加粗在中文小字号下发糊。 */
  font-weight: 400;
  letter-spacing: 0.01em;
  text-align: center;
  transition: opacity 200ms ease;
}
/* 当前（高亮）行：字号 = 浮条字号（1em），颜色由组件用用户配的高亮色 inline 注入。
   刻意不在 CSS 里写死颜色 —— 写死就会出现"用户在弹窗选的红，窗里还是黄"。 */
.dl-cur {
  font-size: 1em;
}
/* 其余（未高亮）行：0.86em 相对浮条字号缩小，颜色由组件用用户配的底色 inline 注入。
   em 而非 px：换字号时主副两行等比缩放，比例不会散架。 */
.dl-side {
  font-size: 0.86em;
  margin-bottom: 2px;
}
/* 未到第一句时的「纯音乐」提示：固定弱化色（**不跟**用户配的底色走 ——
   它不是一句歌词，用了副行色会让人以为那是一句词）。 */
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
