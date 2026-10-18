import { formatBytes } from './format';
import { DATA_ITEMS, type DataKind } from '../data';
import type { DataProfiles } from '../host';

/** 本次卸载的处理结果：删了哪几项、留了哪几项 */
export interface Outcome {
  deleted: string[];
  kept: string[];
}

/**
 * 完成页的汇总 —— 「已删除」与「保留清单」两条。
 *
 * 与进度行走的是**同一份判据**（`targets` 里有的才删），只是呈现场合不同；
 * 拆成两个函数而不是写在一处：进度关心"现在到哪一步"，完成页关心"最后到底删了什么"。
 * 勾选状态不在这里再判一遍 —— 传进来的 `targets` 已经是界面筛过的结果，
 * 两处各判一次就会出现"进度说删了、汇总说留着"的分叉。
 */
export function buildOutcome(profiles: DataProfiles, targets: DataKind[]): Outcome {
  const deleting = new Set(targets);
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const item of DATA_ITEMS) {
    const profile = profiles[item.kind];
    const label = `${item.short} ${formatBytes(profile.sizeBytes)}`;
    if (deleting.has(item.kind)) deleted.push(label);
    else kept.push(label);
  }
  return { deleted, kept };
}
