import * as RSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

/**
 * 下拉选择（通用单元）。
 *
 * 选项由调用方按「值 → 中文标签」给出，本组件**不认任何具体档位** ——
 * 它不知道"音质"与"皮肤"是什么，只负责"在给定的一组值里选一个"。
 *
 * ## 为什么用 Radix 承担行为
 * 键盘 ↑↓/Home/End、typeahead、读屏 listbox 语义、焦点归还、滚动跟随都是它的职责；
 * 我们只给外观（app.css 的 `.ui-select*`，全部走设计令牌，深色模式自动跟随）。
 * 之前用原生 select：外观能自绘，但**行为**做不到 —— 弹层是系统的，
 * 既不能放缩略图/色点，也不能控宽度，深色下更是完全管不着。
 *
 * ## 泛型的作用
 * 钉住 `value`/`options`/`onChange` 三者同一个联合类型 —— 选项表张冠李戴
 * （比如把皮肤选项喂给音质）会在编译期报错，而不是运行期静默写坏偏好。
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  /**
   * 覆盖默认外观用的附加类名。
   * 存在这个口子是因为默认几何（`min-width: 132px`、行高 24）取自**设置页右列**，
   * 别处要用就得能覆盖 —— 否则第一个新调用点会去改 app.css 里的默认值，
   * 顺手把设置页也改了。
   */
  className?: string;
}) {
  /*
   * 显式算 label 而不是把回显全交给 `<Select.Value />`：
   * Radix 的 Value 靠 ItemText 测量回显，而弹层从未打开时 Content 还没挂载 ——
   * 首次渲染（例如刷新后直接进设置页）会显示成空白。我们本就有 options 表，
   * 自己算一次就永远有正确回显，也少一次对它内部机制的依赖。
   */
  const current = options.find((o) => o.value === value);

  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger className={className ? `ui-select ${className}` : 'ui-select'} aria-label={label}>
        <RSelect.Value>{current?.label ?? value}</RSelect.Value>
        <RSelect.Icon className="ui-select-ico">
          <ChevronDown size={13} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        {/* popper + sideOffset：贴着触发按钮展开；align 左对齐（右列控件右对齐时左对齐更稳） */}
        <RSelect.Content className="ui-select-menu" position="popper" sideOffset={4} align="start">
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="ui-select-item">
                {/* 命中项才渲染 indicator；未渲染时靠 Item 的左侧 padding 占位，文本不会左右跳 */}
                <RSelect.ItemIndicator className="ui-select-ok">
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
