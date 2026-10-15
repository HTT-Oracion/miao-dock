import type { ReactNode } from 'react';

/**
 * 空态 / 短提示（通用单元）。
 *
 * `bad` 走错误色（失败提示），`inline` 用于夹在内容流里的短提示
 * —— 后者不吃 `flex: 1`，否则会把同栏的其它内容挤走。
 *
 * 只负责"长什么样"，**不负责决定"该不该显示"**：空态文案由调用方给，
 * 因为"这里为什么是空的"只有那块业务知道（这一点是空态最容易写坏的地方：
 * 组件里写死"暂无数据"，十处空态就会给出十句一样且没有信息量的话）。
 */
export function Empty({ children, bad, inline }: { children: ReactNode; bad?: boolean; inline?: boolean }) {
  const cls = ['ui-empty', bad ? 'is-bad' : '', inline ? 'is-inline' : ''].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
}
