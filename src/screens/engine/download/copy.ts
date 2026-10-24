import type { ServiceStatus } from '@/ipc';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import { assemblySizes } from '@screens/manga/assembly';

/**
 * 下载页的**全部界面文案**与**纯派生量**。
 *
 * 与引导页的 `notready/copy.ts` + `notready/derive.ts` 同构、同一条纪律：
 * 文案只在这一处，页面结构只管"画在哪"。
 *
 * ## 逐字约束
 * 每一句都对着设计稿 `.engine-download` 那一屏（`index.html` 的静态文案 +
 * `js/manga.js` 的 `renderEngineDownload()`）抄。**刻意偏离只有两处**，都在下方就地注明：
 *  ① 预检态那句「下载约 3.6 GB」不写死体积 —— 真实体积由清单算；
 *  ② 「重新下载」的弹窗正文按产品的 `fresh=true` 语义写（设计稿那句是另一条路径的行为）。
 */

// ------------------------------------------------------------------ 文案

/** 页标题（设计稿 `edTitle`） */
export function pageTitleOf(done: boolean, interrupted: boolean, idle: boolean): string {
  if (done) return '本地引擎已就绪';
  if (interrupted) return '本地引擎装配中断';
  if (idle) return '本地引擎装配';
  return '正在装配本地引擎';
}

/** 状态胶囊（设计稿 `edStateChip`）：文案 + 色位类名 */
export function chipOf(done: boolean, interrupted: boolean, running: boolean): { text: string; cls: string } {
  if (done) return { text: '已完成', cls: 'chip-success' };
  if (interrupted) return { text: '下载中断', cls: 'chip-danger' };
  if (running) return { text: '下载中', cls: 'chip-soft' };
  return { text: '等待开始', cls: 'chip-soft' };
}

/** 环心小字（设计稿 `edRingLabel`）：段名 / 完成 / 已中断 / 等待开始 */
export function ringLabelOf(done: boolean, interrupted: boolean, activePhase: string | null): string {
  if (done) return '完成';
  if (interrupted) return '已中断';
  return activePhase ?? '等待开始';
}

/** 环心大字：完成 ⇒ 「完成」；没有真实进度 ⇒ 「准备中」（**不画假的 0%**） */
export function ringCenterOf(done: boolean, overall: number | null): string {
  if (done) return '完成';
  if (overall == null) return '准备中';
  return `${Math.round(overall)}%`;
}

/**
 * 五段标题（与装配流程页同一套段号）。
 *
 * `models` 是全量 CLI 的兼容值，文案与 `llm` 一致；`stage` 只负责上面的
 * 「第 N 轮 / 共 2 轮」小字 —— 两者不是同一台状态机。
 */
export const STEP_TEXT: Record<string, { title: string; sub: string }> = {
  prepare: {
    title: '正在准备装配环境',
    sub: '校验清单、探测落点 —— 这段没有可量化的进度，走完即进入下载。',
  },
  runtime: {
    title: '正在装配运行环境',
    sub: 'Python 运行时 → venv → 引擎源码 → 补丁 → 依赖。',
  },
  visual: {
    title: '正在下载视觉模型',
    sub: '检测 / OCR / 抹字 / 字体，以及 llama.cpp 与 CUDA 运行库。',
  },
  llm: {
    title: '正在下载翻译模型',
    sub: 'Sakura 权重与 nllb（英译中）；期间可先用在线翻译，下完可在设置里切回本地引擎。',
  },
  models: {
    title: '正在下载翻译模型',
    sub: 'Sakura 权重与 nllb（英译中）；期间可先用在线翻译，下完可在设置里切回本地引擎。',
  },
};

/** 两轮指示器（`stage` 的取值空间只有两格） */
export const ROUND_TEXT: Record<string, string> = {
  stage1: '第 1 轮 / 共 2 轮',
  stage2: '第 2 轮 / 共 2 轮',
};

/**
 * 主标题（`ed-hero-copy h3`）。
 *
 * 五种终态各一句；运行中按真实 `step` 取段标题（取不到就退回"准备好后开始装配"，
 * 而不是编一个阶段名）。
 */
export function heroTitleOf(
  done: boolean,
  interrupted: boolean,
  idle: boolean,
  step: { title: string } | null,
): string {
  if (done) return '全部文件校验通过';
  if (interrupted) return '下载中断 · 已完成的部分会保留';
  if (idle) return '准备好后开始装配';
  return step?.title ?? '准备好后开始装配';
}

/** 副标题（`ed-hero-copy > p`）：中断态优先说**真实原因**，没有原因才退回末行日志。 */
export function heroDescOf(
  done: boolean,
  interrupted: boolean,
  idle: boolean,
  paused: boolean,
  step: { sub: string } | null,
  view: ModelDownloadView,
): string {
  if (done) return '引擎已可以启动，重启本地服务后生效。';
  if (interrupted) {
    return (
      view.interruptedReason ??
      (view.tail.length ? view.tail[view.tail.length - 1] : '原因未知；已完成的部分不会丢失。')
    );
  }
  if (idle) {
    // 🔴 不写死体积：设计稿那句「约 3.6 GB」是演示数据，真实体积在预检格里按清单算
    return '支持断点续传。确认保存位置与模型源后再开始。';
  }
  if (paused) return '已下载的部分会保留，随时可以从断点继续。';
  return step?.sub ?? '进度只来自真实下载事件。';
}

/** 五段状态条的小字（设计稿 `.ed-step small`）；`已暂停` 只在"中断且可续传"时说 */
export function stepStateText(note: 'done' | 'active' | 'failed' | 'waiting', paused: boolean): string {
  if (note === 'done') return '完成';
  if (note === 'failed') return paused ? '已暂停' : '失败';
  if (note === 'active') return '进行中';
  return '等待';
}

/** 预计剩余：只按真实 `etaMs` 换算，取不到就是 `—`（不拿百分比反推时间） */
export function fmtEta(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `约 ${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `约 ${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `约 ${h} 小时 ${m % 60} 分`;
}

// ------------------------------------------------------------------ 派生量

/**
 * 四格指标（设计稿 `.ed-metrics`）：没有真实来源的一律 `—`，不补"看起来合理"的数。
 *
 * 🔴 环用**整体装配进度**（段加权），不是字节百分比：venv / pip 装依赖 / 打补丁这几段
 *    一个字节都不进账本（pip 命中 `Using cached` 时更是一个都不下），
 *    用字节会把环冻在上一段的数值上 —— 实测「一直 0%，像卡死」。
 */
export interface Metric {
  label: string;
  value: string;
}

export function metricsOf(
  view: ModelDownloadView,
  running: boolean,
  totalFallback: number | null,
  fmt: (n: number) => string,
): Metric[] {
  const total = view.totalBytes ?? totalFallback;
  return [
    { label: '已下载', value: view.receivedBytes != null ? fmt(view.receivedBytes) : '—' },
    { label: '总大小', value: total != null ? fmt(total) : '—' },
    { label: '速度', value: running && view.speedBps != null ? `${fmt(view.speedBps)}/s` : '—' },
    { label: '剩余', value: running ? fmtEta(view.etaMs) : '—' },
  ];
}

/**
 * 预检四格（设计稿 `.ed-preflight`）。
 *
 * 设计稿的第三、四格是**磁盘剩余**与**模型源延迟**，服务端没有出口
 * （`/engine/status` 与 `/engine/runtime` 都不报）。这里换成两条**真实存在**的
 * 下载链路判据 —— 宁可换一个能答的问题，也不摆两个永远 `—` 的假检查项。
 */
export interface PreflightView {
  total: { value: string; hint: string; ok: boolean };
  dir: string;
  runner: { value: string; hint: string; ok: boolean };
  manifest: { value: string; hint: string; ok: boolean };
}

export function preflightOf(
  view: ModelDownloadView,
  status: ServiceStatus | null,
  fmt: (n: number) => string,
): PreflightView {
  const sizes = assemblySizes(status);
  const hint =
    sizes.total != null
      ? [
          sizes.visual != null ? `视觉 ${fmt(sizes.visual)}` : null,
          sizes.translation != null ? `翻译 ${fmt(sizes.translation)}` : null,
          sizes.runtime != null ? `运行环境 ${fmt(sizes.runtime)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '清单未读到';

  /*
   * 🔴 预检态（`state='idle'`，还没有任何下载记录）里 `view.runner` / `view.manifest` 是空的 ——
   *    那两个字段由**下载进程**报出，没跑过就还没报。但这两样东西此刻**确实存在或不存在**，
   *    问服务状态的 `runtime` 那一份即可（它与下载器读的是同一个清单）。
   */
  const runnerPath = view.runner || status?.runtime?.items.find((i) => i.id === 'llm')?.path || '';
  const runnerOk = view.runner ? view.runnerExists : !!status?.runtime;
  const manifestOk = view.manifest ? true : !!status?.runtime;

  return {
    total: { value: sizes.total != null ? fmt(sizes.total) : '—', hint, ok: sizes.total != null },
    dir: view.rootDir,
    runner: {
      value: runnerPath ? baseName(runnerPath) : '—',
      hint: runnerOk ? '执行体在位' : '执行体缺失',
      ok: runnerOk,
    },
    manifest: {
      value: view.manifest ? baseName(view.manifest) : 'models.manifest.json',
      hint: manifestOk ? '清单可读' : '清单缺失',
      ok: manifestOk,
    },
  };
}

/** 文件名（取路径末段）—— 预检格只报名字，不塞一整条绝对路径 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
