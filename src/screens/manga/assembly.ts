import type { RuntimeSetView, ServiceStatus } from '@/ipc';
import type { AssemblyStep, ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 装配流程的五段（D-233）。
 *
 * 与 `modelDownload.step` 一一对应（前三段有事件），后两段由真实判据推导：
 *   · `visual` —— 视觉模型档（`sets.visual`）全部在位；
 *   · `llm`    —— LLM 翻译模型档（`sets.llm` + `sets.translation` + `llama-server`）全部在位；
 *   · `ready`  —— **没有对应事件**：由 `runtime.ready` 与服务五态收尾。
 *
 * 🔴 与下载页的两步 `stage` 刻意分开：`stage` 是「第 1 轮 / 第 2 轮」，
 *    这里回答的是「装配到哪一段」，两者不是同一台状态机。
 */
export type PhaseId = 'prepare' | 'runtime' | 'visual' | 'llm' | 'ready';

export interface AssemblyPhase {
  id: PhaseId;
  /** 段名（时间线主行）—— 与设计稿 `.timeline-step strong` 逐字一致 */
  text: string;
}

/**
 * 五段段名。
 *
 * 🔴 段名是**界面文案**，取设计稿 `.timeline-step strong` 的五句
 * （`环境准备 / 运行环境 / 视觉模型 / 翻译模型 / 就绪`）；
 * 引导页与下载页共用这一份 —— 两处各写一套就会出现"同一段两个叫法"。
 */
export const ASSEMBLY_PHASES: AssemblyPhase[] = [
  { id: 'prepare', text: '环境准备' },
  { id: 'runtime', text: '运行环境' },
  { id: 'visual', text: '视觉模型' },
  { id: 'llm', text: '翻译模型' },
  { id: 'ready', text: '就绪' },
];

/** 段形态词（时间线副行的状态位）—— 四态，与节点形态一一对应。 */
export type StageNote = 'done' | 'active' | 'failed' | 'waiting';

export const NOTE_TEXT: Record<StageNote, string> = {
  done: '完成',
  active: '进行中',
  failed: '失败',
  waiting: '等待',
};

/** 事件段 → 五段下标。`models` 是全量 CLI 的兼容值，归到 llm 段。 */
export const STEP_INDEX: Record<AssemblyStep, number> = {
  prepare: 0,
  runtime: 1,
  visual: 2,
  llm: 3,
  models: 3,
};

/** 第一个未完成的模型段；`null` = 模型资产已齐（或根本没有模型档）。 */
export interface EngineInstallView {
  stage: 'visual' | 'llm';
  totalBytes: number;
  readyBytes: number;
  missingBytes: number;
}

const RUNTIME_ITEM_IDS = ['venvRoot', 'python', 'source', 'deps', 'patches'] as const;

function itemOk(status: ServiceStatus | null, id: string): boolean {
  return status?.runtime?.items.find((i) => i.id === id)?.ok ?? false;
}

/** 当前平台真的有条目的档位；`entries === 0` 视为「这一档不存在」，不当作缺失。 */
function setOf(status: ServiceStatus | null, id: string): RuntimeSetView | null {
  const s = status?.runtime?.sets?.[id];
  return s && s.entries > 0 ? s : null;
}

function runtimeItemsOk(status: ServiceStatus | null): boolean {
  return RUNTIME_ITEM_IDS.every((id) => itemOk(status, id));
}

function visualOk(status: ServiceStatus | null): boolean {
  return setOf(status, 'visual')?.ready ?? false;
}

/**
 * LLM 段是否装配完成。
 *
 * 🔴 必须同时覆盖 `translation`（nllb）：英译中走的是 nllb，不走 Sakura；
 *    只看 `llm` 档会让英译中用户看到"LLM 已就绪"却翻不出来。
 *    `translation` 档在当前平台没有条目时（entries=0）跳过 —— 那不是缺失。
 */
function llmAssetsOk(status: ServiceStatus | null): boolean {
  const llm = setOf(status, 'llm');
  if (!llm?.ready) return false;
  const tr = setOf(status, 'translation');
  if (tr && !tr.ready) return false;
  return itemOk(status, 'llm');
}

/**
 * 五段各自的形态。
 *
 * 优先级：**真实下载事件**（`download.step`）> 探针分档/条目 > 服务状态。
 * 下载进行中时，后面的段一律等待；只把当前段标成进行中/失败。
 */
export function assemblyNotes(status: ServiceStatus | null, download: ModelDownloadView | null): StageNote[] {
  const notes: StageNote[] = ['waiting', 'waiting', 'waiting', 'waiting', 'waiting'];
  if (!status) return notes;

  const downloading =
    download?.state === 'running' || download?.state === 'interrupted' || download?.state === 'failed';
  if (downloading && download?.step) {
    const idx = STEP_INDEX[download.step];
    for (let i = 0; i < idx; i++) notes[i] = 'done';
    notes[idx] = download.state === 'running' ? 'active' : 'failed';
    return notes;
  }

  // 装配链：探针能读到就算「环境准备」完成；之后按缺项逐段推进。
  //
  // 🔴 缺项在**没有实际活动**时只能是 `waiting`，不能标 `active`：
  //    `active` 意味着"正在装"，而服务未启动、也没有下载进程时，磁盘不会自己变。
  //    真实的下载活动由上面的 `download.step` 分支负责点亮。
  notes[0] = 'done';
  if (!runtimeItemsOk(status)) {
    notes[1] = 'waiting';
    return notes;
  }
  notes[1] = 'done';
  if (!visualOk(status)) {
    notes[2] = 'waiting';
    return notes;
  }
  notes[2] = 'done';
  if (!llmAssetsOk(status)) {
    notes[3] = 'waiting';
    return notes;
  }

  // 资产齐了：最后一段回答「②/③ 是不是真的起来了」。
  notes[3] = 'done';
  if (status.state === 'running' && status.runtime?.ready && !status.degraded) {
    notes[4] = 'done';
  } else if (status.state === 'starting') {
    notes[4] = 'active';
  } else if (status.state === 'error' || status.degraded) {
    notes[4] = 'failed';
  }
  return notes;
}

/**
 * 第一个未完成的模型段 + 该段的体积。
 *
 * `missingBytes` 只算**这一段**还差的字节 —— 不用全局 `requiredBytes`，
 * 否则部分装配的机器会以为要重下全部。
 */
export function engineInstallView(
  status: ServiceStatus | null,
  download: ModelDownloadView | null,
): EngineInstallView | null {
  if (!status?.runtime) return null;
  if (status.runtime.ready) return null;

  const visual = setOf(status, 'visual');
  const llm = setOf(status, 'llm');
  const tr = setOf(status, 'translation');

  // 下载进行中：以真实事件段为准，避免"视觉刚下完、探针还没刷新"时提示跳到 llm。
  const step = download?.state === 'running' ? download.step : null;
  if (step === 'visual') {
    const total = visual?.totalBytes ?? status.runtime.requiredBytes;
    const ready = visual?.readyBytes ?? 0;
    return { stage: 'visual', totalBytes: total, readyBytes: ready, missingBytes: Math.max(0, total - ready) };
  }
  if (step === 'llm' || step === 'models') {
    const total = (llm?.totalBytes ?? 0) + (tr?.totalBytes ?? 0);
    const ready = (llm?.readyBytes ?? 0) + (tr?.readyBytes ?? 0);
    return { stage: 'llm', totalBytes: total, readyBytes: ready, missingBytes: Math.max(0, total - ready) };
  }

  if (!visual?.ready) {
    const total = visual?.totalBytes ?? status.runtime.requiredBytes;
    const ready = visual?.readyBytes ?? 0;
    return { stage: 'visual', totalBytes: total, readyBytes: ready, missingBytes: Math.max(0, total - ready) };
  }

  if (!llm?.ready || (tr && !tr.ready) || !itemOk(status, 'llm')) {
    const total = (llm?.totalBytes ?? 0) + (tr?.totalBytes ?? 0);
    const ready = (llm?.readyBytes ?? 0) + (tr?.readyBytes ?? 0);
    return { stage: 'llm', totalBytes: total, readyBytes: ready, missingBytes: Math.max(0, total - ready) };
  }

  return null;
}

/**
 * 装配体积的三段拆分（视觉 / 翻译 / 运行环境），供引导页「需要下载」与下载页预检共用。
 *
 * 全部来自 `runtime.sets` 的 `totalBytes`（服务端按清单求和）；读不到的档位不编数，
 * 由调用方按 `null` 分支隐藏那一行。
 */
export interface AssemblySizes {
  visual: number | null;
  translation: number | null;
  runtime: number | null;
  /** 三者之和；任一档缺失时为 `null`（宁可说"未知"，不给一个少算的合计） */
  total: number | null;
}

export function assemblySizes(status: ServiceStatus | null): AssemblySizes {
  const visual = setOf(status, 'visual')?.totalBytes ?? null;
  const llm = setOf(status, 'llm')?.totalBytes ?? null;
  const tr = setOf(status, 'translation')?.totalBytes ?? null;
  const runtime = setOf(status, 'runtime')?.totalBytes ?? null;
  const translation = llm == null && tr == null ? null : (llm ?? 0) + (tr ?? 0);
  const total = visual == null || translation == null || runtime == null ? null : visual + translation + runtime;
  return { visual, translation, runtime, total };
}
