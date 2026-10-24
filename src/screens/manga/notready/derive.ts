import type { ServiceStatus } from '@/ipc';

/**
 * 引导页用到的**纯派生量**（不碰 React、不碰 DOM）。
 *
 * 抽出来有两个好处：
 *  ① 这些判断（"现在到底是不是在下载""缺了哪几样""失败在哪个阶段"）是**逻辑**，
 *     混在 JSX 里就只能靠读 JSX 才能验证；
 *  ② 它们各自有容易写错的口径（下面每条都标了），集中在一处才不会各分支各写一遍。
 */

/** 真实日志末行（Rust 的 LogBuffer，含三个子进程的 stdout）。没有就不显示，不补占位。 */
export function lastLogLine(log: string[] | undefined): string | null {
  if (!log || log.length === 0) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const s = (log[i] ?? '').trim();
    if (s) return s;
  }
  return null;
}

/**
 * 引擎是否**未装配**（D1）。
 *
 * 🔴 判据**只看**「real 档 + 运行时未就绪」，**不附加 `state !== 'running'`**：
 * D6 闸门只挡 ②/③、① 照常起，此时 state 仍是 running 而引擎仍未装配 ——
 * 「引擎就绪与否」只能由 `runtime.ready` 回答，不能拿服务状态代理。
 */
export function isRuntimeUnready(status: ServiceStatus | null): boolean {
  return status?.mode === 'real' && !!status?.runtime && !status.runtime.ready;
}

/**
 * 是否"已经开过一场下载"（中断 / 失败 / 进行中）。
 *
 * 引导页 CTA 的两种语义靠它分叉：**没开过** ⇒ 只打开下载页的预检态；
 * **开过** ⇒ 直接续传并进下载页（再让用户确认一遍等于把同一件事问两次）。
 */
export function hasStartedDownload(download: { state: string } | null | undefined): boolean {
  const s = download?.state;
  return s === 'running' || s === 'interrupted' || s === 'failed';
}

/** 是否正在下载（进行中或已中断）—— 决定"当前处于第 N 段"那行说不说。 */
export function isDownloading(download: { state: string } | null | undefined): boolean {
  const s = download?.state;
  return s === 'running' || s === 'interrupted';
}

/**
 * L2（引擎拉起阶段）失败。
 *
 * 此时"重启本地服务"没有意义 —— 坏的是引擎运行时，该给的是「重新下载模型」。
 * 抽成具名函数而不是内联三元（工程纪律第 8 条），两个动作的 kind 与条件都读它。
 */
export function isL2Failure(status: ServiceStatus | null): boolean {
  return status?.state === 'error' && status.phase === 'L2';
}

/** 日志默认展开的条件：失败时用户第一眼就该看到原因。 */
export function logOpenByDefault(failed: boolean): boolean {
  return failed;
}

/**
 * 装配体积的三格（设计稿 `.nr-diag`）：读不到的档位**整格不渲染**，不编数。
 *
 * 返回的顺序即渲染顺序（视觉 → 翻译 → 运行环境），与设计稿一致。
 */
export interface SizeCell {
  label: string;
  bytes: number;
}

export function sizeCellsOf(sizes: {
  visual: number | null;
  translation: number | null;
  runtime: number | null;
}): SizeCell[] {
  const out: SizeCell[] = [];
  if (sizes.visual != null) out.push({ label: '视觉模型', bytes: sizes.visual });
  if (sizes.translation != null) out.push({ label: '翻译模型', bytes: sizes.translation });
  if (sizes.runtime != null) out.push({ label: '运行环境', bytes: sizes.runtime });
  return out;
}

/** 文件名（取路径末段）—— 给"下载器 / 清单"这类只报名字的地方用 */
export function baseName(p: string | null | undefined): string {
  if (!p) return '—';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
