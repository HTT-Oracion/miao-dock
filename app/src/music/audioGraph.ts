/**
 * 音频图基础设施 —— **全项目唯一的 `<audio>` 接管入口**。
 *
 * ## 为什么必须收口成一处
 *
 * 至少有三处需要读音频电平：灵动岛的波形、「音域回响」皮肤的频谱、
 * 以及可能的未来可视化。而 `createMediaElementSource` 有一条**不可逆**的硬约束：
 *
 * > 对同一个 `<audio>` 元素**只能调用一次**，第二次抛 `InvalidStateError`。
 *
 * 所以"谁先到谁建图"这件事必须由一个模块统一裁决 —— 散在各组件里写，
 * 第二个调用方必然抛错，且错法是"波形不出来"这种不指向真因的现象。
 *
 * ## ⚠️ 这一节是最容易埋雷的地方：接管会**静音**
 *
 * `createMediaElementSource` 会把元素的输出从"直接出声"改成"必须经音频图回到
 * `destination`"。由此派生出两条各自独立、都会导致**完全没声音**的失效路径：
 *
 * 1. **没接回 destination** —— 建了图但不连出口。本模块用 `wired` 标志保证只连一次、
 *    且在 catch 里补连（万一在"已接管、未接回"之间抛错）。
 * 2. **跨域资源 + 非 CORS 模式 → 输出静音** —— 这是 Web Audio 的安全规则：
 *    元素未以 CORS 模式加载（`crossOrigin` 未设）时，跨域媒体的输出**恒为静音**。
 *    本地歌曲走 `asset://`（Tauri 的 asset 协议带 CORS 头）不受影响，
 *    而网络歌曲来自第三方 CDN，**一旦被接管就彻底没声** ——
 *    实测症状正是"网络歌曲播放没声音，本地歌曲正常"。
 *
 * 因此本模块**拒绝接管非 CORS 模式的元素**（见 `isWirable`），
 * 让这种情况下退回 CSS 动画波形 —— 宁可没有真实波形，也不能没声音。
 * 这与参考实现的做法一致：它给 `<audio>` 全局设了 `crossOrigin="anonymous"`。
 *
 * ## 不依赖 store
 *
 * 本模块只认 DOM（`document.querySelector('audio')`）与传入的元素，
 * 不 import store —— 它属于基础设施层，与 `toastBus` / `ipc` 同级。
 */

/** 频率桶数量。统一为 1024（512 bins）—— 波形只要 5 根柱子、频谱场景要细分，
 *  取大的一档同时满足两者：`AnalyserNode.fftSize` 可写，但两个消费方互相改会打架，
 *  所以定死一个值，谁都不要改。 */
const FFT_SIZE = 1024;

interface AudioGraph {
  node: AnalyserNode;
  ctx: AudioContext;
}

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let graph: AudioGraph | null = null;

/** 已接管的元素。`createMediaElementSource` 一次性的约束靠它兜住 */
let sourceEl: HTMLAudioElement | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let wired = false;

/** 硬失败（WebView 不支持 AudioContext / 元素已被别人接管）—— 粘住，不再重试 */
let hardFailed = false;

/** 建图中的 Promise：并发调用共用同一次建图，避免对同一元素建两次图 */
let inFlight: Promise<AudioGraph | null> | null = null;

/**
 * **明确禁止接管**的元素集合。
 *
 * 由 CORS 加载失败的回退路径写入（见 MusicKernel 的 `onError`）：
 * 某音源不带 CORS 头时，`crossOrigin="anonymous"` 会让它**加载失败**；
 * 回退到非 CORS 模式后虽然能加载、能出声，但**不能接管**（接管即静音）。
 * 用 WeakSet 而不是打 DOM 属性标记：这是模块内部状态，不该出现在 DOM 上。
 */
const noWire = new WeakSet<HTMLAudioElement>();

/**
 * 该元素是否**允许**被音频图接管。
 *
 * 两条否据，任一条成立都只能退回 CSS 动画波形：
 * - 被回退路径标记为不可接管（该资源无 CORS 头）
 * - 元素不是 CORS 模式 —— 接管后跨域资源输出静音
 *
 * ⚠️ 第二条**必须**保留：它防的是"未来有人把 `crossOrigin` 去掉之后，
 * 波形还在、声音却没了"这种谁都不会立刻联想到真因的故障。
 */
export function isWirable(el: HTMLAudioElement | null): boolean {
  if (!el) return false;
  if (noWire.has(el)) return false;
  return el.crossOrigin === 'anonymous';
}

/** 标记某元素永久不可接管（CORS 回退路径专用） */
export function markNotWirable(el: HTMLAudioElement | null): void {
  if (el) noWire.add(el);
}

/** 拿（或建）全局 AudioContext。硬失败后恒返 null（不再反复尝试） */
function ensureContext(): AudioContext | null {
  if (hardFailed) return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    hardFailed = true;
    return null;
  }
  audioCtx = audioCtx ?? new Ctor();
  return audioCtx;
}

/**
 * 激活音频上下文（必须在用户手势里调用）。
 *
 * 单独暴露出去是因为调用时机有讲究：**播放动作（用户点击）里调**最可靠。
 * 自动播放策略下上下文默认 suspended，此时接管元素＝彻底静音 ——
 * 所以 `getAnalyser` 只在确认 running 后才接管。
 */
export async function ensureAudioContextActive(): Promise<boolean> {
  const ctx = ensureContext();
  if (!ctx) return false;
  if (isRunning(ctx)) return true;
  try {
    await ctx.resume();
  } catch {
    return false;
  }
  // 必须走 isRunning 而不是直接比 —— 见它的注释
  return isRunning(ctx);
}

/**
 * 单独成函数（而不是直接写 `ctx.state === 'running'`）：
 * 直接比较时 TS 会把 `state` 按上一条 if 收窄，await 之后那次判断会被判成
 * "两个类型没有重叠"（`TS2367`）—— 而运行时这个判断完全成立。
 * 走一遍带类型的形参就绕开了这个收窄。
 */
function isRunning(ctx: AudioContext): boolean {
  return ctx.state === 'running';
}

export { isRunning as isAudioContextRunning };

async function doAttach(el: HTMLAudioElement): Promise<AudioGraph | null> {
  if (hardFailed) return null;
  if (graph) return graph;
  try {
    const ctx = ensureContext();
    if (!ctx) return null;

    /**
     * ⚠️ 关键顺序：**先确认上下文在跑，再接管音频元素**。
     * suspended 时接管＝彻底静音，比"没有波形"严重得多。起不来就当场放弃、绝不接管。
     */
    if (!isRunning(ctx)) {
      await ctx.resume();
      if (!isRunning(ctx)) return null;
    }

    if (sourceEl !== el || !sourceNode) {
      sourceNode = ctx.createMediaElementSource(el);
      sourceEl = el;
      wired = false;
    }
    analyser = analyser ?? ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.78;

    if (!wired) {
      sourceNode.connect(analyser);
      analyser.connect(ctx.destination); // 不接回 destination = 静音
      wired = true;
    }
    graph = { node: analyser, ctx };
    return graph;
  } catch {
    // 兜底：万一在"已接管、还没接回 destination"这一步失败，必须补上，
    // 否则用户看到的是"播放坏了"（实际是音频被路由走了没连出口）
    try {
      if (sourceNode && audioCtx) sourceNode.connect(audioCtx.destination);
    } catch {
      /* 此时确实无能为力，交给 CSS 波形降级 */
    }
    hardFailed = true;
    return null;
  }
}

/** 建图（并发调用共用同一次） */
export function attachAnalyser(el: HTMLAudioElement | null): Promise<AudioGraph | null> {
  if (!el || !isWirable(el)) return Promise.resolve(null);
  if (graph) return Promise.resolve(graph);
  if (inFlight) return inFlight;
  inFlight = doAttach(el).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * 从时域数据算出 `bars` 根柱子的电平（0..1）。
 *
 * 用 `getByteFrequencyData`（频域）而不是时域波形 —— 频域更贴近"音乐在响"的观感：
 * 低频鼓点与高频镲片的差异能体现在不同柱子上，时域只是上下起伏的一根线。
 * `floor` 抬一个下限，避免静音段柱子归零后看起来"坏了"。
 */
export function readLevels(node: AnalyserNode, bars: number, floor = 0.06): number[] {
  const buf = new Uint8Array(node.frequencyBinCount);
  node.getByteFrequencyData(buf);
  const step = Math.max(1, Math.floor(buf.length / bars));
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) sum += buf[i * step + j] ?? 0;
    out.push(Math.max(floor, Math.min(1, sum / step / 255)));
  }
  return out;
}

/** 找页面里的播放元素（`MusicKernel` 里那个 `display:none` 的 `<audio>`） */
export function findAudioElement(): HTMLAudioElement | null {
  return document.querySelector('audio');
}
