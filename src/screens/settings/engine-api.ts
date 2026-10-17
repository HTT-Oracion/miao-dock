import { apiGet, apiPost, type RuntimeProbe } from '@/ipc';

/**
 * ② 翻译服务 ·「推理引擎 / 模型与诊断」两小节的**服务端接口收口**。
 *
 * ## 为什么单独成文件
 * 这六个端点（`/engine/options|status|settings|unload|models/verify|models/download`）
 * 都是 **Box 专用**（不在插件契约里），且返回体形状复杂、字段多。
 * 把形状定义与调用散在组件里，会出现"界面读的字段名和服务端给的对不上"——
 * 而这类错**在运行时只表现为 `undefined`**（渲染成一个空值或"读取中…"），
 * 不报错、不崩、断言也抓不到。所以形状在这里只定义一次，组件只消费。
 *
 * ## 为什么字段全部标 `| null`
 * 服务端刻意用 `null` 表达"此刻没有"（引擎没跑 ⇒ `tier.effective=null`；
 * 未配置 ⇒ `configured=null`）。类型上允许 null 是**逼调用方显式处理这种情况**，
 * 而不是让 `?? '—'` 之类的兜底把它悄悄变成一个看起来正常的值。
 * 这一条与《02》§5.2「状态文字一律 ink、颜色只由状态点承载」是同一件事的两面：
 * **界面上出现的每个值都必须能追溯到服务端的一个真实字段**，不能是我们编的默认值。
 */

// ------------------------------------------------------------------ 取值域

export type EngineTier = 'tiny' | 'small' | 'medium';
export type EngineAccel = 'auto' | 'cuda' | 'mps' | 'cpu';
export const ACCEL_LABEL: Record<EngineAccel, string> = {
  auto: '自动',
  cuda: 'CUDA',
  mps: 'MPS（Metal）',
  cpu: 'CPU',
};

/** 空闲阈值来源：谁定的这个值（用户改不动时界面必须说得出是谁压着它） */
export type SettingSource = 'env' | 'file' | 'hardware' | 'default';

// ------------------------------------------------------------------ /engine/options

export interface EngineTierOption {
  tier: EngineTier;
  /** 该档**整机峰值内存估算**（《02》§5 表；原文标注"估算、待实测校准"） */
  peakGb: number;
  recommended: boolean;
  /** 非推荐档的强警告文案（`null` = 就是推荐档） */
  warning: string | null;
  /** 该档权重是否已纳入 `models.manifest.json`（false ⇒ 选了也下不到，按钮必须禁） */
  weightsReady: boolean;
  blockedReason: string | null;
}

export interface EngineAccelOption {
  value: EngineAccel;
  label: string;
  detail: string;
}

export interface EngineIdle {
  ms: number;
  min: number;
  /** 分钟是否**精确**（env 能把阈值压到秒级 ⇒ 界面不能假装分钟就是全部事实） */
  minIsExact: boolean;
  /** 改完要不要重启引擎才生效 */
  appliesAfterRestart: boolean;
  source: SettingSource | 'env' | 'file';
}

export interface EngineHardware {
  platform: string;
  arch: string;
  totalRamGb: number;
  gpuKind: string;
  gpuName: string;
  accel: string;
}

export interface EngineOptions {
  protocol: string;
  hardware: EngineHardware;
  tier: {
    /** 引擎**此刻在跑**的档位（引擎不在时是 null） */
    effective: EngineTier | null;
    /** **已配置**的档位（盘上那份）；null = 未指定（按硬件推荐） */
    configured: EngineTier | null;
    source: SettingSource;
    hardwareRecommended: EngineTier;
    weightsAvailable: EngineTier[];
    options: EngineTierOption[];
  };
  accel: {
    effective: string;
    choice: EngineAccel;
    source: SettingSource;
    hardwareRecommended: string;
    /** 用户指定了本机没有的后端时非 null —— 界面**必须**显示它，不能装作已生效 */
    mismatch: string | null;
    reason: string;
    options: EngineAccelOption[];
  };
  idle: { llm: EngineIdle; vision: EngineIdle; neverUnload: boolean };
  modelDir: {
    /** 服务**当前正在用**的目录（进程启动时定，改了要重启） */
    current: string;
    configured: string | null;
    defaultDir: string;
    source: SettingSource;
    exists: boolean;
  };
  models: ModelStatus;
  /** 哪些键改完要重启引擎（《09》§4.3）—— 界面据它决定亮不亮提示条 */
  restartRequiredKeys: string[];
  settingsFile: {
    path: string;
    keys: string[];
    exists: boolean;
    corrupt: boolean;
    reason: string | null;
    ignoredKeys: string[];
    invalidValues: { key: string; must: string }[];
  };
}

/**
 * 清单里**一条**（D8）—— 界面直接渲染，不再自己写一份"应该有哪些文件"。
 *
 * 字段来自 `models.manifest.json` 本身 ⇒ 改清单，引导跟着变。
 * `path` 是**判据真正作用的绝对路径**（引擎实际会打开的那个），不是清单里那条相对路径。
 */
export interface ModelFileStatus {
  id: string;
  /** 所属分组（`visual` / `llm` / `runtime` / `translation`） */
  set?: string;
  /** 清单里的落点（相对模型根） */
  dest: string;
  /** 引擎实际打开的那个（相对 `<root>/src`）；没有 ⇒ 键不存在 */
  linkTo?: string;
  url?: string;
  sizeBytes?: number;
  /** 平台限定；不存在 = 平台无关 */
  platform?: string;
  /** 是否适用于**本机** ⇒ 界面据此决定要不要算进"你还缺什么" */
  applicable: boolean;
  /** 在位且大小与清单一致 */
  ready: boolean;
  /** 目标**绝对路径** */
  path: string;
}

/**
 * 一个档位（`sets` 的一项）在当前平台下的体积与条数（C1）。
 *
 * 字段全部由清单的 `sizeBytes` 求和得出 —— 界面只做单位换算，**不自己估**。
 */
export interface ModelSetGuide {
  id: string;
  /** 该档位在**当前平台**下可见的条目数 */
  entries: number;
  /** 这些条目的 `sizeBytes` 之和 */
  bytes: number;
}

/**
 * 安装引导（C1）—— 「装之前先说清楚要留多少盘、装到哪」。
 *
 * 🔴 与服务端的关系：这里的每个数字都是服务端**算好的**（`totalBytes` 出自 `guidance`，
 *    不是前端把 `files` 再遍历一遍）。前端各算一份的结果就是"两处显示同一个量、数字却不同"。
 */
export interface ModelGuidance {
  /** 当前平台标识（与清单 `platform` 同一口径） */
  platform: string;
  /** 当前平台可见的条目数 */
  entries: number;
  /** 这些条目的 `sizeBytes` 之和（逐字节可复算） */
  totalBytes: number;
  /** 分档位细分；各项之和恒等于 `totalBytes` */
  sets: ModelSetGuide[];
}

/**
 * 盘上实况（D4）—— 「装了什么、占了多少盘、什么时候落的」。
 *
 * 🔴 与服务端的关系同 `ModelGuidance`：每个数都是服务端**算好的**，前端只做单位换算。
 *    三个数各自的诚实边界（写在服务端的同名字段上）：
 *    · `bytes` 只算**就绪**条目、且按 inode **去重**（硬链接不重复计）；
 *    · `assembledAt` 是"就绪资产里最新的落盘时间"，**不是**"装配完成时刻"——
 *      我们没有那个事件的记录，所以界面文案也不写"装配于"。
 */
export interface ModelDisk {
  /** 参与统计的就绪条目数 */
  readyEntries: number;
  /** 去重后的真实文件数（硬链接只算一份） */
  uniqueFiles: number;
  /** 去重后的占用字节 */
  bytes: number;
  /** 就绪资产里最新的 mtime（ISO-8601 UTC）；无就绪条目 ⇒ 键不存在 */
  assembledAt?: string;
}

export interface ModelStatus {
  visualReady: boolean;
  sakuraReady: boolean;
  lastVerifiedAt: string | null;
  /**
   * 逐条清单（D8）。**顺序与清单一致**；清单读不到 ⇒ 空数组。
   *
   * 为什么在三个聚合布尔之外还要它：那三个回答"能不能翻译"，答不了"**还缺哪一个文件**"——
   * 而后者才是用户在点「重新下载模型」之前要问的。
   */
  files: ModelFileStatus[];
  /** 安装引导（C1）：按当前平台的合计体积与分档位细分 */
  guidance: ModelGuidance;
  /** 盘上实况（D4）：真实占用与最近一次落盘时间 */
  disk: ModelDisk;
}

// ------------------------------------------------------------------ /engine/status

/**
 * 装配五段的段号（D-233）—— `modelDownload.step` 的值域，服务端 `state.rs` 是唯一来源。
 *
 * 🔴 这里的值**不覆盖** `stage` 的两步：下载详情页那个指示器只认 `stage1` / `stage2`
 * （`DownloadPanel.tsx` 的 `STAGE_TEXT`），`visual` 在它眼里仍属第 1 步、`llm` 属第 2 步。
 * 第五段「就绪」**没有**对应事件 —— 它由 `runtime.ready` 推导，不是装配发出来的。
 *
 * `models` 是**全量 CLI**（`--fetch-models` 不带 `--stage`）的兼容值：产品主路径只会发
 * `prepare / runtime / visual / llm`，前端把它映射到第一个未就绪的模型段。
 */
export type AssemblyStep = 'prepare' | 'runtime' | 'visual' | 'llm' | 'models';

export interface ModelDownloadView {
  state: 'idle' | 'running' | 'interrupted' | 'done' | 'failed';
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** 子进程输出尾巴（进度与错误都在这）—— **原样转发**，不做结构化解析 */
  tail: string[];
  rootDir: string;
  manifest: string;
  /** 模型下载/校验的**执行体**路径（A3d 起是 `mangasvc`，不再是那个 .mjs 脚本） */
  runner: string;
  /** 执行体不在盘上 ⇒ 界面把按钮**变灰**（不让用户点了换一条报错） */
  runnerExists: boolean;
  // ---- G5：结构化进度（全部来自 `--progress-log`，null = 无真实来源）----
  /** 0..100；`total` 未知时为 `null`（界面显示「准备中」而非假的 0%） */
  percent: number | null;
  receivedBytes: number | null;
  totalBytes: number | null;
  /** 实时速度（字节/秒）；取不到为 `null` */
  speedBps: number | null;
  /** 预计剩余（毫秒）；取不到为 `null` */
  etaMs: number | null;
  /** 当前阶段：`stage1`（准备运行环境）| `stage2`（下载权重，后台继续）| `null` */
  stage: 'stage1' | 'stage2' | null;
  /**
   * 装配四段的当前段（D-231④）：环境准备 / 运行环境装配 / 本地引擎装配；`null` = 还没有真实阶段事件。
   *
   * 🔴 与 `stage` **并存而非取代**：`stage` 的取值空间被下载详情页的 `STAGE_TEXT`（只有两格）钉死，
   * 扩成四段会让那个指示器在准备期整块消失。四段时间线走这一个字段。
   */
  step: AssemblyStep | null;
  /** 当前正在处理的条目 id（文件名 / 阶段名）；无真实来源为 `null` */
  currentId: string | null;
  // ---- G5：中断 / 续传 ----
  /** 可续传：盘上存在 `.part`，或 `.ready` 未覆盖全部选中条目 */
  canResume: boolean;
  /** 中断原因（措辞取自服务端事实）；`null` = 未中断 */
  interruptedReason: string | null;
}

export interface EngineStatus {
  engine: { state: string; version: string; port: number | null; pid: number | null };
  llm: { state: string; model: string | null; port: number | null; pid: number | null };
  tier: EngineTier | null;
  accel: string;
  warmed: boolean;
  config: Record<string, unknown> & {
    translator: string;
    /** `null` = 基线不固定源语言，**逐任务**按其方向下发（ver2.1 起）；界面显示成"按任务方向" */
    fromLang: string | null;
    targetLang: string;
    detector: string;
    /** `null` = 我们**没下发**它（引擎用自身默认），与"下发了 2048"不是一回事 */
    detectionSize: number | null;
    ocr: string;
    inpainter: string;
  };
  models: ModelStatus;
  /** 运行时就绪检测（七项 + 分档 `sets`）；与 `ServiceStatus.runtime` 同一份 */
  runtime: RuntimeProbe;
  /** 引擎原始阶段名（`seq N: 原话`）。**不进插件契约**，只给 Box 诊断看 */
  recentStageLog: string[];
  modelDownload: ModelDownloadView;
}

// ------------------------------------------------------------------ /engine/settings

export interface EngineSettingsPatch {
  tier?: EngineTier;
  accel?: EngineAccel;
  idleLlmMin?: number;
  idleVisionMin?: number;
  modelDir?: string;
}

export interface EngineSettingsResult {
  ok: true;
  settings: EngineSettingsPatch;
  /** 这次真改了哪几个键（"保存成功"不该是一个不说明改了什么的消息） */
  changed: string[];
  restartRequired: boolean;
  restartRequiredKeys: string[];
  /** 改完**立刻**生效的键（只有空闲卸载 LLM 属此列） */
  appliedNow: string[];
}

// ------------------------------------------------------------------ 调用

export const engineOptions = () => apiGet<EngineOptions>('/engine/options');

export const engineStatus = () => apiGet<EngineStatus>('/engine/status');

export const saveEngineSettings = (patch: EngineSettingsPatch) =>
  apiPost<EngineSettingsResult>('/engine/settings', patch);

export const unloadEngineLlm = () =>
  apiPost<{ ok: boolean; unloaded: boolean; reason?: string; state: string }>('/engine/unload', {});

export interface ModelsVerifyResult {
  /** `false` 只表示"发现了不符"—— 它仍是一次**成功的调用**，不是操作失败 */
  ok: boolean;
  pass: number;
  bad: number;
  missing: number;
  total: number;
  /** HF 缓存布局（带 `hf` 的条目）：只有**不可解析 0** 才算在 —— 光文件在、布局坏，引擎仍加载不了 */
  hf: { resolvable: number; broken: number; total: number };
  problems: string[];
  rootDir: string;
  exitCode: number;
  elapsedMs: number;
  manifest: string;
}

export const verifyEngineModels = () => apiPost<ModelsVerifyResult>('/engine/models/verify', {});

/**
 * 发起「下载/重新下载模型」。
 *
 * `fresh` = 屏上「重新下载」（清 `.part` 从头下）；缺省 = 「继续下载」/ 首次（续传）。
 * 🔴 续传由 `.part` + HTTP Range 天然完成 —— 再调一次同一个端点即可（plan 关键决策三）。
 */
export const downloadEngineModels = (fresh = false) =>
  apiPost<{ ok: true; started: true; download: ModelDownloadView }>(
    fresh ? '/engine/models/download?fresh=1' : '/engine/models/download',
    {},
  );
