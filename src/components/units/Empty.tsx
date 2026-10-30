import type { ReactNode } from 'react';
import { Mascot } from '@components/units/Mascot';

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
 * ## 插画（`art`）
 * 设计稿的**空态**都带那只趴着的猫（`.empty-art > .mascot-svg`）。但它只属于"空"，
 * 不属于"坏"：错误态要的是"这里出了问题"的紧迫感，摆一只打盹的猫会读成"没什么大事"。
 * 所以插画由 `art` 显式开启，且 `bad` 时即便传了也不画 —— 两个条件都在组件里守住，
 * 免得十处调用各记一遍。
 */
export function Empty({
  children,
  sub,
  actions,
  bad,
  inline,
  art,
}: {
  children: ReactNode;
  /** 说明行（设计稿 `.empty p`）：补一句"这意味着什么" */
  sub?: ReactNode;
  /** 动作区（设计稿 `.empty-actions`）：下一步能做什么 */
  actions?: ReactNode;
  bad?: boolean;
  inline?: boolean;
  /** 画不画空态插画（设计稿 `.empty-art`）；错误态强制不画 */
  art?: boolean;
}) {
  const cls = ['ui-empty', bad ? 'is-bad' : '', inline ? 'is-inline' : ''].filter(Boolean).join(' ');
  const withArt = art && !bad && !inline;
  return (
    <div className={cls}>
      {withArt ? (
        <div className="ui-empty-art">
          <Mascot mood="sleep" />
        </div>
      ) : null}
      <div className="ui-empty-title">{children}</div>
      {sub ? <div className="ui-empty-sub">{sub}</div> : null}
      {actions ? <div className="ui-empty-actions">{actions}</div> : null}
    </div>
  );
}
