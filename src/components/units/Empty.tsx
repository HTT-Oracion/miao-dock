import type { ReactNode } from 'react';

/**
 * 空态 / 短提示（通用单元）。
 *
 * `bad` 走错误色（失败提示），`inline` 用于夹在内容流里的短提示
 * —— 后者不吃 `flex: 1`，否则会把同栏的其它内容挤走。
 *
 * `sub` / `actions` 是设计稿空态的第二、三层（`.empty h3 + p + .empty-actions`）：
 * 标题说"这里为什么是空的"，说明补"这意味着什么"，动作给"下一步能做什么"。
 * 两者都可缺省 —— 只给 `children` 时行为与旧版一致（短提示不该被迫长成一块空态）。
 *
 * 只负责"长什么样"，**不负责决定"该不该显示"**：空态文案由调用方给，
 * 因为"这里为什么是空的"只有那块业务知道（这一点是空态最容易写坏的地方：
 * 组件里写死"暂无数据"，十处空态就会给出十句一样且没有信息量的话）。
 */
export function Empty({
  children,
  sub,
  actions,
  bad,
  inline,
}: {
  children: ReactNode;
  /** 说明行（设计稿 `.empty p`）：补一句"这意味着什么" */
  sub?: ReactNode;
  /** 动作区（设计稿 `.empty-actions`）：下一步能做什么 */
  actions?: ReactNode;
  bad?: boolean;
  inline?: boolean;
}) {
  const cls = ['ui-empty', bad ? 'is-bad' : '', inline ? 'is-inline' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className="ui-empty-title">{children}</div>
      {sub ? <div className="ui-empty-sub">{sub}</div> : null}
      {actions ? <div className="ui-empty-actions">{actions}</div> : null}
    </div>
  );
}
