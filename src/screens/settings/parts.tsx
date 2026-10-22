import { useState } from 'react';
import type { ReactNode } from 'react';
import { SETTINGS } from '@/themes/tokens';
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

/**
 * 把 `**重点**` 渲染成 `<b>` —— catalog 文案里的强调标记。
 *
 * ## 为什么必须有个解析器
 * `catalog.ts` 的 `note` / `why` / `blurb` 是**产品文案**，作者一直按 markdown 的写法
 * 用 `**` 标重点（全表 100+ 处）。但 React 不解析字符串里的 markdown：
 * 把字符串直接塞进 JSX 的结果是**界面上原样显示两个星号** ——
 * `本组 10 项**全部接真实能力**`。它编译得过、类型检查过、断言也抓不到，
 * 只有人眼看得见（这一类"沉默的显示错误"正是本项目最防的一类）。
 *
 * ## 为什么是"加解析"而不是"把 `**` 删掉"
 * 删掉等于**连重点标记的意图一起删掉**：哪些是重点、哪些是正文区分不出来了。
 * 而这里十来行就能让**已有的写法真正生效** —— 100+ 处文案一个字都不用动，
 * 也不会出现"某个作者忘了这里不能用 md"的新坑。
 *
 * ## 只支持这一种标记，且不做通用 markdown
 * 多支持一种语法就多一类能出错的地方；而这里的输入**全部来自本仓的 catalog 常量**，
 * 不是在渲染用户内容。落单的 `**`（奇数个）**原样保留**，不做"补一个"的猜测 ——
 * 宁可看见两个星号，也不要把后半句整段加粗（那等于替作者虚构了一个重点）。
 */
export function emphasis(text: string): ReactNode {
  const parts = text.split('**');
  // 成对的 `**` 才构成重点 ⇒ 分割后段数必为奇数（n 对 ⇒ 2n+1 段）
  if (parts.length % 2 === 0) return text;
  return parts.map((seg, i) => (i % 2 === 1 ? <b key={i}>{seg}</b> : seg));
}

/**
 * 纯文本化：去掉 `**` 强调标记。
 *
 * 给 `title` 这类**只能收字符串**的属性用 —— 那里没法渲染 JSX，
 * 而把带 `**` 的原文直接塞进去，用户悬停会看见一串星号。
 */
export function plain(text: string): string {
  return text.replace(/\*\*/g, '');
}

/**
 * 字节数 → 人读的大小（GB / MB / KB / B）。
 *
 * 为什么放在这里而不是各自组件里：这个函数被**两个**块用（引擎诊断 / 模型管理），
 * 而"同一个数在两处显示成不同单位"正是本仓一直在防的那类偏差
 * （同 `plain()` 的理由：纯函数、与具体能力无关，故归排版件）。
 *
 * 单位用 1024 进制、保留一位小数 —— 与 `docs/install-guide-*.md` 里"6.93 GiB"
 * 那类数字同一套换算（文档里的数是清单求和后按 GiB 算的）。
 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * 组级说明：**一行摘要 + 「为什么」抽屉**（catalog 的 `note` / `noteSummary`）。
 *
 * ## 折叠的不是信息，是占位
 * `note` 是写给维护者的 —— 两个服务端视角为何缺一不可、两个阈值待遇为何不同。
 * 它对用户的任务只有一条：**告诉他改哪些要重启**。这一段的默认形态是 6 行，
 * 于是三小节的标题与主要控件被顶出首屏。折叠后默认只显示 `noteSummary` 那一行，
 * 全文**一字不删**地留在抽屉里。
 *
 * ## 折叠与否由**数据**决定，不在这里猜长度
 * 给了 `noteSummary` 才折叠；没给就原样铺全文（`note` 本来就短，加个抽屉只多一次点击）。
 * 按字符数猜阈值是"没人能解释、也没法被断言"的写法，所以阈值留在 catalog。
 *
 * ## 缺组说明 ⇒ 整块不渲染（自守，不靠调用处记得删）
 * 显隐由**数据**决定：catalog 给了 `note` 才出现这一块，没给就 `return null`。
 * 于是"删掉某组的 `note`"这件事只需改一处（catalog），调用处不必跟着删渲染点 ——
 * 调用了也不会渲染。分组数、渲染点因此可以固定为"每组都写一行"，与文案增减解耦。
 *
 * 🔴 这一守同时是**崩溃防线**：`children` 为 `undefined` 时 `emphasis(undefined)`
 * 会抛 `TypeError`。类型上 `{X.note as string}` 把 `string | undefined` 硬掰成了
 * `string`，`tsc --noEmit` 放行 —— 只看编译期发现不了（本页已因此崩过两次）。
 *
 * ## `emphasis(children)` 只在展开态求值
 * 折叠态显示的是 `summary`（纯文本，按 catalog 的硬约束它不含标记）；
 * 全文始终走 `emphasis()` —— 它是 `**` 唯一的渲染点之一。
 */
export function GroupNote({ children, summary }: { children?: string; summary?: string }) {
  const [open, setOpen] = useState(false);
  // 没有组说明：整块不渲染（读屏也不念）
  if (!children) return null;
  if (!summary) return <div className="set-note">{emphasis(children)}</div>;
  return (
    <div className={open ? 'set-note is-open' : 'set-note'}>
      <div className="set-note-row">
        <div
          className={open ? 'set-note-sum is-full' : 'set-note-sum'}
          // 折叠态悬停可读全文：摘要是一行的下限，不是唯一入口
          title={open ? undefined : plain(children)}
        >
          {open ? emphasis(children) : summary}
        </div>
        <button type="button" className="set-note-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : '为什么 ?'}
        </button>
      </div>
    </div>
  );
}

/**
 * 一行设置的骨架 —— 标题 + 说明在左，控件在右。
 *
 * 几何（`min-height:56` / `padding:12px 16px`）由 CSS 承载，组件不再内联注入：
 * 行内注入会盖掉卡片内的左右留白，让每一行都贴着卡片边缘。
 *
 * `children` 为空时右侧什么都不渲染（只读项就是这种）。**不给「不可点」的假控件
 * 留位置**：没有能力时右侧要么是只读文本，要么整个换成 `PendingRow`。
 */
export function Row({ item, children }: { item: SettingItem; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <div className="set-row-title">
          <span className="set-row-name">{item.label}</span>
          {item.def ? <DefaultChip value={item.def} /> : null}
        </div>
        {item.why ? (
          /* `is-one`：行内只占一行（`title` 悬停可读全文）—— 见 `PendingRow` 的同一处 */
          <div className="set-row-why is-one" title={plain(item.why)}>
            {emphasis(item.why)}
          </div>
        ) : null}
      </div>
      {children ? <div className="set-row-ctl">{children}</div> : null}
    </div>
  );
}

/**
 * 出厂默认值（catalog 的 `SettingItem.def`）—— 标题行内的一枚浅色小字。
 *
 * ## 为什么挂在标题行内，而不是另起一行
 *
 * 另起一行会让行从「标题 + why」长成三行：`SETTINGS.rowMinHeight` 是 50，
 * 三行实际量出来 70+。而这一页刚做完一轮"把 why 压回一行"的简化 —— 再往回长是自相矛盾。
 * 标题行右侧本来就是空的（标题很少占满整列），这枚小字因此是**零高度成本**的。
 *
 * ## 🔴 必须带「默认」二字，且 `title` 要说清它不是当前值
 *
 * `def` 是**出厂默认**，不随用户改动而变（改过的值在右侧控件里）。只写 `浅色`
 * 会被读成"你现在是浅色" —— 那正好是它要回答的那个问题的反面。
 * 所以：文字写「默认：X」，悬停再补一句"不是你当前的设置"。
 *
 * ## 只在 `Row` 用，`PendingRow` 刻意不用
 * `pending` 项**还没有能力**，谈"出厂默认"没有对象 —— 给一个尚未存在的功能
 * 标一个默认值，读起来像它已经能配了。等它转 `live` 那天自然就带上了。
 */
function DefaultChip({ value }: { value: string }) {
  return (
    <span className="set-row-def" title={`出厂默认：${value} —— 这不是你当前的设置`}>
      默认：{value}
    </span>
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
    <div className="set-row is-pending">
      <div className="set-row-label">
        <div className="set-row-title">{item.label}</div>
        {item.why ? (
          /*
           * 与 `Row` 用同一条规则（live / pending 的 why 高度必须一致，否则两种行
           * 摆在一起会读成两种层级）。注意 `is-pending` 的降权只改颜色、不改高度。
           */
          <div className="set-row-why is-one" title={plain(item.why)}>
            {emphasis(item.why)}
          </div>
        ) : null}
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
