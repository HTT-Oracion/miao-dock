// 漫画库菜单项的**文案构造**：把返工 / 继续翻译的长链三元抽成**早返回函数**，
// 让每个分支可读、可单测（范式见 AGENTS.md §2.10 的「禁内联长链三元」）。
//
// 为什么单开本模块（D-148）：主组件与 `Compare`（已搬到 `viewer.tsx`）**都要**用它，
// 留在 `LibraryScreen.tsx` 会形成 `viewer.tsx ↔ LibraryScreen.tsx` 的循环 import。
import type { RetranslatePlan } from '@/types';

/** 返工菜单项文案：按 提交中 / 返工中 / 无原图 / 计划未就绪 / 正常 取值（避免内联多级三元）。 */
export function retranslateMeta(
  plan: RetranslatePlan | null,
  submitting: boolean,
  reworking: boolean,
  noOriginal: boolean,
): { title: string; sub: string; blocked: boolean } {
  if (submitting) return { title: '返工请求正在提交', sub: '提交中…', blocked: true };
  if (reworking) return { title: '该漫画已有任务在队列中，等它跑完再返工', sub: '返工中', blocked: true };
  if (noOriginal) return { title: '该漫画目录里没有原图，无从返工', sub: '没有原图', blocked: true };
  if (!plan) return { title: '正在读取返工计划…', sub: '读取中…', blocked: true };
  return {
    title: `重新翻译全部 ${plan.retranslateCount} 张（覆盖 ${plan.overwriteCount} 张已有译文）`,
    sub: `全部 ${plan.retranslateCount} 张 · 覆盖 ${plan.overwriteCount} 张`,
    blocked: false,
  };
}

/** 继续翻译菜单项文案。 */
export function resumeMeta(
  pending: number | null,
  busy: boolean,
): { title: string; sub: string; disabled: boolean } {
  if (busy) return { title: '正在提交…', sub: '提交中…', disabled: true };
  if (pending === 0) return { title: '该漫画没有待续做的页', sub: '没有待续做的页', disabled: true };
  const n = pending ?? '…';
  return { title: `把待译的页加入队列（待续做 ${n} 张）`, sub: `待续做 ${n} 张`, disabled: false };
}
