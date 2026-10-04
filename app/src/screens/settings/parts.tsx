import type { CSSProperties, ReactNode } from 'react';
import * as RSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { SETTINGS } from '../../theme/tokens';
import { Badge } from '../../components/atoms';
import type { SettingItem } from './catalog';

/** 允许在 style 里写自定义属性（`--x`）：`CSSProperties` 只覆盖标准属性 */
type CSSVarStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * 设置页的**排版件**（《09》§4.1）—— 只有几何与语义，没有一项具体能力。
 *
 * 五个分组组件都从这里取行与小节的排版，为的是让"26 项看起来像同一套东西"
 * 这件事**只由一处保证**：行高 50、padding 10、行间 1px line-soft、小节标题
 * 10.5/700/uppercase —— 这些值全部来自 `SETTINGS` 常量，本文件不出现第二个数字。
 *
 * 另一个职责：**不可点状态长什么样**。`PendingRow` 是全页唯一渲染"待接入"的地方，
 * 所以"未实现项绝不长得像能点"这条纪律也只有一处可查 —— 任何想给 pending 项
 * 加控件的人都会先撞到这里。
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

/** 深色模式开关（复用既有 `.switch` 原子样式，规格自检 C6 已覆盖其几何） */
export function Switch({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={on ? 'switch is-on' : 'switch'}
      onClick={onToggle}
      aria-pressed={on}
      aria-label={label}
    >
      <span className="switch-track">
        <i />
      </span>
    </button>
  );
}

/*
 * 下面五个是 ③ 播放·媒体 专用的**控件原语**（《09》§4.1）。
 *
 * 它们与能力无关，只把「一个真的能改 store 的控件长什么样」收敛到一处：
 * 用受控 `value` + `onChange` 直连调用方的 setter，组件本身**不持状态、不做持久化**
 * —— 因为 store 的 setter 已经负责持久化（见 store.ts），这里再存一份就是第二个事实源。
 * 多一个「看起来能改、实际没接线」的中间层，正是设置页最容易长出的假控件。
 */

/**
 * 下拉选择：选项由调用方按「值 → 中文标签」给出，本组件不认任何具体档位。
 *
 * 泛型钉住 `value`/`options`/`onChange` 三者同一个联合类型 —— 选项表张冠李戴
 * （比如把皮肤选项喂给音质）会在编译期报错，而不是运行期静默写坏偏好。
 *
 * 交互与无障碍交给 Radix（`@radix-ui/react-select`）：键盘 ↑↓/Home/End、typeahead、
 * 读屏 listbox 语义、焦点归还、滚动跟随都是它的事；外观仍全部走项目令牌（app.css），
 * 所以它长得跟这个页面里其它控件一样，而不是"装了个 UI 库"。
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  /*
   * 显式算 label 而不是把回显全交给 `<Select.Value />`：
   * Radix 的 Value 靠 ItemText 测量回显，而弹层从未打开时 Content 还没挂载 ——
   * 首次渲染（以及刷新后直接进设置页）会显示成空白。我们本就有 options 表，
   * 自己算一次就永远有正确回显，也少一次对这个内部机制的依赖。
   */
  const current = options.find((o) => o.value === value);

  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger className="set-select" aria-label={label}>
        <RSelect.Value>{current?.label ?? value}</RSelect.Value>
        <RSelect.Icon className="set-select-ico">
          <ChevronDown size={13} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        {/* popper + sideOffset：贴着触发按钮展开；align 与按钮左缘对齐（设置页右列右对齐，左对齐更稳） */}
        <RSelect.Content className="set-select-menu" position="popper" sideOffset={4} align="start">
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="set-select-item">
                {/* 命中项才渲染 indicator；未渲染时靠 Item 的左侧 padding 占位，文本不会左右跳 */}
                <RSelect.ItemIndicator className="set-select-ok">
                  <Check size={12} />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/**
 * 滑杆 + 右侧数值读数：读数与滑杆同源于 `value`，不可能显示成两个数。
 *
 * 已填充比例由这里算好后写成 CSS 变量 `--set-range-fill`：
 * 百分比取决于「值落在区间的哪儿」，CSS 算不出来（轨道宽度本身还是弹性的），
 * 只能由持有 `value` 的组件给出；样式侧只负责按这个比例画两种底色。
 */
export function Range({
  min,
  max,
  step,
  value,
  onChange,
  label,
  suffix,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  label: string;
  suffix?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const fill: CSSVarStyle = { '--set-range-fill': `${pct}%` };

  return (
    <>
      <input
        type="range"
        className="set-range"
        style={fill}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="set-range-val">
        {value}
        {suffix ?? ''}
      </span>
    </>
  );
}

/**
 * 预设色点组：`value` 命中的那个加 `is-on`（CSS 用 ring 标选中，不覆盖色点本身的颜色）。
 *
 * `title` / `aria-label` 都写颜色值 —— 色点的信息就是"它是什么颜色"，
 * 只靠视觉传达会让色觉障碍用户与读屏用户拿不到任何信息。
 */
export function Swatches({
  colors,
  value,
  onPick,
  label,
}: {
  colors: readonly string[];
  value: string;
  onPick: (c: string) => void;
  label: string;
}) {
  const cur = value.toLowerCase();
  return (
    <div className="set-swatches" role="group" aria-label={label}>
      {colors.map((c) => {
        const on = c.toLowerCase() === cur;
        return (
          <button
            key={c}
            type="button"
            className={on ? 'set-swatch is-on' : 'set-swatch'}
            style={{ background: c }}
            title={c}
            aria-label={c}
            aria-pressed={on}
            onClick={() => onPick(c)}
          />
        );
      })}
    </div>
  );
}

/** 原生取色器：`value` 始终回显当前色，`disabled` 是「有真实理由的状态」而非占位 */
export function ColorPicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string;
  onChange: (c: string) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="color"
      className="set-color"
      value={value}
      disabled={disabled}
      aria-label={label}
      title={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 控件旁的一行小字注解：解释"为什么这个控件此刻是灰的 / 只在这档生效" */
export function CtlNote({ children }: { children: string }) {
  return <span className="set-ctl-note">{children}</span>;
}
