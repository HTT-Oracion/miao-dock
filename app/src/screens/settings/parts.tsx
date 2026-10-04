import type { ReactNode } from 'react';
import { SETTINGS } from '@/theme/tokens';
import { Badge } from '@components/units';
import type { SettingItem } from '@screens/settings/catalog';

/**
 * 设置页的**排版件**（《09》§4.1）—— 只有几何与语义，没有一项具体能力。
 *
 * 五个分组组件都从这里取行与小节的排版，为的是让"全部项看起来像同一套东西"
 * 这件事**只由一处保证**：行高 50、padding 10、行间 1px line-soft、小节标题
 * 10.5/700/uppercase —— 这些值全部来自 `SETTINGS` 常量，本文件不出现第二个数字。
 *
 * 另一个职责：**不可点状态长什么样**。`PendingRow` 是全页唯一渲染"待接入"的地方，
 * 所以"未实现项绝不长得像能点"这条纪律也只有一处可查 —— 任何想给 pending 项
 * 加控件的人都会先撞到这里。
 *
 * ## 为什么这些留在这里、而控件在 units（《09》§2.2）
 * 它们**只在设置页成立**：`Row` 的 50px 行高与"label 在左 / 控件在右"的骨架，
 * 是为设置页的两栏壳与分组列表设计的；`SubTitle` 服务的是"组内分层"这条本页规则。
 * 提到 units 会让别处被迫接受这套行高与分层，反而限制了复用。
 * 反过来，真正通用的控件（Select / Range / Switch / Swatches / ColorPicker）
 * 已移到 `components/units/`，本文件**不再定义任何控件**。
 */

/** 小节标题：10.5px / 700 / uppercase / .05em（《09》§4.1「组内分层的关键」） */
export function SubTitle({ children }: { children: string }) {
  return (
    <div
      className="set-subtitle"
      style={{
        fontSize: SETTINGS.sectionTitleSize,
        letterSpacing: SETTINGS.sectionTitleTracking,
      }}
    >
      {children}
    </div>
  );
}

/** 组级说明：解释这一组为什么有这么多"待接入"（对应 catalog 的 `note`） */
export function GroupNote({ children }: { children: string }) {
  return <div className="set-note">{children}</div>;
}

/**
 * 一行设置的骨架 —— 标题 + 说明在左，控件在右。
 *
 * `children` 为空时右侧什么都不渲染（只读项就是这种）。**不给「不可点」的假控件
 * 留位置**：没有能力时右侧要么是只读文本，要么整个换成 `PendingRow`。
 */
export function Row({ item, children }: { item: SettingItem; children?: ReactNode }) {
  return (
    <div className="set-row" style={{ minHeight: SETTINGS.rowMinHeight, padding: `${SETTINGS.rowPaddingY}px 0` }}>
      <div className="set-row-label">
        <div className="set-row-title">{item.label}</div>
        {item.why ? <div className="set-row-why">{item.why}</div> : null}
      </div>
      {children ? <div className="set-row-ctl">{children}</div> : null}
    </div>
  );
}

/**
 * 未实现项：**不可点 + 「待接入」标注**（《09》§4.4 的硬约束）。
 *
 * 刻意不给 `<button disabled>` —— 那会渲染出一个灰按钮，读起来是"暂时不可用，
 * 等会儿就好"，而这里的真相是"上游能力还不存在"。所以右侧只有一个 Badge，
 * 左侧把缺什么写清楚。全页没有任何可点元素，故不存在"点了没反应"。
 */
export function PendingRow({ item }: { item: SettingItem }) {
  return (
    <div
      className="set-row is-pending"
      style={{ minHeight: SETTINGS.rowMinHeight, padding: `${SETTINGS.rowPaddingY}px 0` }}
    >
      <div className="set-row-label">
        <div className="set-row-title">{item.label}</div>
        {item.why ? <div className="set-row-why">{item.why}</div> : null}
      </div>
      <div className="set-row-ctl">
        <Badge>待接入</Badge>
      </div>
    </div>
  );
}

/**
 * 行下方的通栏附注 —— 承接"这一行为什么要说这么多"。
 *
 * 与 `Row` 分开而不是塞进行内：行的右列是控件区（窄），
 * 而令牌说明、生命周期说明这类文字需要整行宽度，塞进右列会被挤成一条细缝。
 */
export function RowNote({ children }: { children: ReactNode }) {
  return <div className="set-row-note">{children}</div>;
}

/** 只读值：端口 / 目录 / 版本号这类"读出来给你看，改不了"的东西 */
export function ReadOnly({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="set-ro" title={title}>
      {children}
    </code>
  );
}

/** 控件旁的一行小字注解：解释"为什么这个控件此刻是灰的 / 只在这档生效" */
export function CtlNote({ children }: { children: string }) {
  return <span className="set-ctl-note">{children}</span>;
}
