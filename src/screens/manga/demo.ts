import type { ServiceStatus, RuntimeProbe, RuntimeItem, RuntimeSetView } from '@/ipc';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import type { DemoState } from '@/stores/demo-override';

/**
 * 演示态的**输入夹具** —— 只造"状态机输入"，不造界面。
 *
 * 六种演示状态各自对应一组真实状态机的取值：
 *   · `running` / `starting` / `stopped` / `error` —— 换 `ServiceStatus.state`（其余照抄真值）；
 *   · `unassembled` —— `runtime.ready=false` + 缺件清单，且**没有**下载活动；
 *   · `assembling` —— 同上，但 `modelDownload.state='running'` 且带 `step`（五段亮到第几段由它决定）。
 *
 * 🔴 夹具只覆盖**状态字段**，路径 / 端口 / 体积一律沿用传进来的真值：
 *    演示要回答的是"这个状态长什么样"，不是"编一份看起来合理的机器信息"。
 */

/** 缺件项（`fix` 是给用户的产品内入口，不是命令行）。 */
function missingItems(): RuntimeItem[] {
  return [
    {
      id: 'venvRoot',
      ok: false,
      path: '（演示）运行时根目录尚未装配',
      detail: '运行时根目录不存在：引擎的 Python 与依赖还没有落盘',
      fix: '点「开始下载」即可 —— 喵坞会自动装配引擎运行时',
    },
    {
      id: 'deps',
      ok: false,
      path: '（演示）依赖尚未安装',
      detail: '引擎依赖（torch / manga_translator）缺失',
      fix: '点「开始下载」即可 —— 装配会从公网镜像安装引擎依赖',
    },
  ];
}

/** 七项全真的条目（用于 running / starting / stopped / error 四态：装配链是好的）。 */
function readyItems(): RuntimeItem[] {
  return [
    { id: 'venvRoot', ok: true, path: '（演示）运行时根目录', detail: '运行时根目录在位' },
    { id: 'python', ok: true, path: '（演示）python', detail: '解释器在位' },
    { id: 'source', ok: true, path: '（演示）引擎源码', detail: '源码在位' },
    { id: 'deps', ok: true, path: '（演示）依赖', detail: '依赖齐备' },
    { id: 'patches', ok: true, path: '（演示）补丁', detail: '补丁已应用' },
    { id: 'llm', ok: true, path: '（演示）llama-server', detail: '③ 可执行体在位' },
    { id: 'weights', ok: true, path: '（演示）翻译权重', detail: '权重在位' },
  ];
}

/** 分档视图：全就绪（真值缺席时给一个自洽的演示档）。 */
function readySets(): Record<string, RuntimeSetView> {
  const ok = (totalBytes: number): RuntimeSetView => ({ entries: 1, ready: true, totalBytes, readyBytes: totalBytes });
  return { runtime: ok(314572800), visual: ok(3006477107), llm: ok(966367641), translation: ok(0) };
}

/** 分档视图：视觉齐、翻译缺（`assembling` 停在视觉段时的形态）。 */
function partialSets(): Record<string, RuntimeSetView> {
  const ok = (totalBytes: number): RuntimeSetView => ({ entries: 1, ready: true, totalBytes, readyBytes: totalBytes });
  const missing = (totalBytes: number): RuntimeSetView => ({ entries: 1, ready: false, totalBytes, readyBytes: 0 });
  return { runtime: ok(314572800), visual: ok(3006477107), llm: missing(966367641), translation: ok(0) };
}

function probeOf(ready: boolean, items: RuntimeItem[], sets: Record<string, RuntimeSetView>): RuntimeProbe {
  const total = Object.values(sets).reduce((n, s) => n + s.totalBytes, 0);
  return { ready, items, sets, requiredBytes: total };
}

/**
 * 由真状态 + 演示态推出**服务状态**。
 *
 * 非服务态（`unassembled` / `assembling`）在真机上对应 `state='running'`：
 * D6 闸门只挡 ②/③，① 照常起 —— 装配页正是在这个 state 下渲染的。
 */
export function demoStatus(base: ServiceStatus | null, active: DemoState | null): ServiceStatus | null {
  if (!active) return base;
  const seed: ServiceStatus = base ?? {
    state: 'stopped',
    port: 5180,
    token: null,
    root_dir: null,
    sidecar_port: null,
    llm_port: null,
    mode: 'real',
    phase: null,
    degraded: false,
    children: [],
    transitions: [],
    log: [],
    last_error: null,
    runtime: probeOf(true, readyItems(), readySets()),
  };
  const children = (names: string[], alive: boolean, pidBase: number) =>
    names.map((name, i) => ({ name, alive, pid: alive ? pidBase + i : null }));

  switch (active) {
    case 'running':
      return {
        ...seed,
        state: 'running',
        mode: 'real',
        degraded: false,
        phase: null,
        port: 5180,
        sidecar_port: 5181,
        llm_port: 5182,
        children: children(['service', 'engine', 'llm'], true, 4266),
        runtime: probeOf(true, readyItems(), readySets()),
        last_error: null,
      };
    case 'starting':
      return {
        ...seed,
        state: 'starting',
        mode: 'real',
        degraded: false,
        phase: 'L2',
        port: 5180,
        sidecar_port: null,
        llm_port: null,
        children: [
          { name: 'service', alive: true, pid: 4266 },
          { name: 'engine', alive: false, pid: null },
          { name: 'llm', alive: false, pid: null },
        ],
        runtime: probeOf(true, readyItems(), readySets()),
        last_error: null,
        log: ['[演示] service started pid=4266 port=5180', '[演示] engine starting…'],
      };
    case 'stopped':
      return {
        ...seed,
        state: 'stopped',
        mode: 'real',
        degraded: false,
        phase: null,
        port: null,
        sidecar_port: null,
        llm_port: null,
        children: children(['service', 'engine', 'llm'], false, 0),
        runtime: probeOf(true, readyItems(), readySets()),
        last_error: null,
        log: [],
      };
    case 'error':
      return {
        ...seed,
        state: 'error',
        mode: 'real',
        degraded: true,
        phase: 'L2',
        port: 5180,
        sidecar_port: 5181,
        llm_port: null,
        children: [
          { name: 'service', alive: true, pid: 4266 },
          { name: 'engine', alive: true, pid: 4267 },
          { name: 'llm', alive: false, pid: null },
        ],
        runtime: probeOf(true, readyItems(), readySets()),
        last_error: 'llama-server 缺少 CUDA 运行库（runtime.dll）',
        log: [
          '[18:42:15] [llm] starting llama-server pid=4266 port=8081',
          '[18:46:15] [llm] start timeout after 240.0s',
          '[18:46:15] [engine] phase=starting -> failed',
          '[18:46:16] [service] diagnosis: missing cudart64_12.dll',
        ],
      };
    case 'unassembled':
      return {
        ...seed,
        state: 'running',
        mode: 'real',
        degraded: true,
        phase: null,
        port: 5180,
        sidecar_port: null,
        llm_port: null,
        children: [
          { name: 'service', alive: true, pid: 4266 },
          { name: 'engine', alive: false, pid: null },
          { name: 'llm', alive: false, pid: null },
        ],
        runtime: probeOf(false, [...missingItems(), ...readyItems().slice(2)], partialSets()),
        last_error: null,
      };
    case 'assembling':
      return {
        ...seed,
        state: 'running',
        mode: 'real',
        degraded: true,
        phase: null,
        port: 5180,
        sidecar_port: null,
        llm_port: null,
        children: [
          { name: 'service', alive: true, pid: 4266 },
          { name: 'engine', alive: false, pid: null },
          { name: 'llm', alive: false, pid: null },
        ],
        runtime: probeOf(false, [...missingItems(), ...readyItems().slice(2)], partialSets()),
        last_error: null,
      };
    default:
      return base;
  }
}

/** 下载视图的空壳（`idle`，用来补足真值缺席时的必填字段）。 */
function emptyDownload(base: ModelDownloadView | null): ModelDownloadView {
  if (base) return base;
  return {
    state: 'idle',
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    tail: [],
    rootDir: '',
    manifest: '',
    runner: '',
    runnerExists: false,
    percent: null,
    receivedBytes: null,
    totalBytes: null,
    speedBps: null,
    etaMs: null,
    stage: null,
    step: null,
    currentId: null,
    assemblyPercent: null,
    assemblyIndeterminate: false,
    canResume: false,
    interruptedReason: null,
  };
}

/** 由演示态推出**下载视图**（只对 `assembling` 造进行中态，其余照抄真值）。 */
export function demoDownload(base: ModelDownloadView | null, active: DemoState | null): ModelDownloadView | null {
  if (!active) return base;
  const shell = emptyDownload(base);
  if (active !== 'assembling') return shell;

  return {
    ...shell,
    state: 'running',
    running: true,
    startedAt: shell.startedAt ?? new Date().toISOString(),
    step: 'visual',
    stage: 'stage1',
    currentId: 'visual/detector.safetensors',
    percent: 38,
    receivedBytes: 1140850688,
    totalBytes: 3006477107,
    speedBps: 11534336,
    etaMs: 162000,
    assemblyPercent: 46,
    assemblyIndeterminate: false,
    canResume: true,
    tail: [
      '[演示] prepare · 校验清单与落点',
      '[演示] runtime · venv 与依赖已就绪',
      '[演示] visual · 正在下载 detector.safetensors',
    ],
  };
}
