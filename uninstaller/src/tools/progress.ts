import { formatBytes } from './format';
import { DATA_ITEMS, type DataChecks, type DataKind } from '../data';
import type { UninstallProbe } from '../host';

/** 一行的形态：已完结 / 正在进行 / 还没开始 */
export type LineState = 'done' | 'now' | 'pending';

/**
 * 行的性质。
 *   `step` = 宿主**真的会执行**的一步，参与进度计数；
 *   `keep` = 明说"没碰"的保留项 —— 恒为已完成，**不计入**进度（否则进度条会为"没做的事"前进）。
 */
export type LineKind = 'step' | 'keep';

export interface ProgressLine {
  id: string;
  text: string;
  kind: LineKind;
  state: LineState;
}

/**
 * 本次卸载的计划（与宿主执行的步骤同序同数）。
 *
 * 三条规矩：
 *   · **勾了才叫"删除"，没勾的一律写"已保留"** —— 不能让用户从"没提到"去推断
 *     自己的数据还在不在（完成页的汇总走同一判据）；
 *   · 步骤顺序固定：快捷方式 → 程序文件与注册表 → 逐项数据 → 开始菜单入口；
 *   · 步数口径 `2 + targets.length + 1` 与 `host.ts` 的 `runUninstall` 注释同一条公式。
 */
export function buildPlan(probe: UninstallProbe, targets: DataKind[]): ProgressLine[] {
  const deleting = new Set(targets);
  const lines: ProgressLine[] = [
    { id: 'shortcut', text: '已移除桌面快捷方式', kind: 'step', state: 'pending' },
    {
      id: 'files',
      text: `已移除程序文件与注册表项（${formatBytes(probe.programSizeBytes)}）`,
      kind: 'step',
      state: 'pending',
    },
  ];

  for (const item of DATA_ITEMS) {
    if (deleting.has(item.kind)) {
      const size = formatBytes(probe.data[item.kind].sizeBytes);
      lines.push({ id: `del-${item.kind}`, text: `正在删除${item.title}（${size}）`, kind: 'step', state: 'pending' });
    } else {
      lines.push({ id: `keep-${item.kind}`, text: `已保留${item.short}（未触碰）`, kind: 'keep', state: 'done' });
    }
  }

  lines.push({
    id: 'menu',
    text: '清理开始菜单入口（注册表随卸载程序一并移除）',
    kind: 'step',
    state: 'pending',
  });
  return lines;
}

/** 真正要执行的步数（`keep` 行不算）—— 宿主报进度用的就是这个分母 */
export function stepCount(lines: ProgressLine[]): number {
  return lines.filter((line) => line.kind === 'step').length;
}

/**
 * 按"已完成几步"重排状态。
 *
 * `keep` 行恒为已完成（它们代表"没碰"，不该等）；`step` 行按序号推 ——
 * 这样"进度条走到哪"与"宿主执行到哪"是同一件事，不会出现"条满了但还在删"。
 */
export function markRunning(lines: ProgressLine[], done: number): ProgressLine[] {
  let index = -1;
  return lines.map((line) => {
    if (line.kind === 'keep') return { ...line, state: 'done' };
    index += 1;
    if (index < done) return { ...line, state: 'done' };
    if (index === done) return { ...line, state: 'now' };
    return { ...line, state: 'pending' };
  });
}

/** 完成百分比（按已执行的步数算 —— 不写死"64%"，那样换一组勾选数字就不动） */
export function progressPercent(lines: ProgressLine[], done: number): number {
  const total = stepCount(lines);
  if (total === 0) return 0;
  return Math.round((Math.min(done, total) / total) * 100);
}

/** 最终要删的几类：勾了**且**目录真的存在（不存在的那类没有可删的东西） */
export function deletionTargets(probe: UninstallProbe, checks: DataChecks): DataKind[] {
  return DATA_ITEMS.filter((it) => checks[it.kind] && probe.data[it.kind].exists).map((it) => it.kind);
}
