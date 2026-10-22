/**
 * 预设色点组（通用单元）：从一组候选色里挑一个。
 *
 * `value` 命中的那个加 `is-on`（CSS 用 ring 标选中，**不覆盖色点本身的颜色** ——
 * 色点的颜色就是它所承载的信息，被选中态盖掉就白选了）。
 *
 * `title` / `aria-label` 必须说得出"这是什么颜色"：色点只画颜色、不写文字，
 * 只靠视觉传达会让色觉障碍用户与读屏用户拿不到任何信息。
 * 有名字就用名字（`names`，如「天青」），没有就退回颜色值本身。
 *
 * 需要"预设之外的颜色"时，与 `ColorPicker` 并排使用（两者写同一个值）。
 */
export function Swatches({
  colors,
  names,
  value,
  onPick,
  label,
}: {
  colors: readonly string[];
  /** 颜色的名字表（`{ '#8FB6D6': '天青' }`）；缺省时用颜色值当名字 */
  names?: Record<string, string>;
  value: string;
  onPick: (c: string) => void;
  label: string;
}) {
  const cur = value.toLowerCase();
  return (
    <div className="ui-swatches" role="group" aria-label={label}>
      {colors.map((c) => {
        const on = c.toLowerCase() === cur;
        const name = names?.[c] ?? c;
        return (
          <button
            key={c}
            type="button"
            className={on ? 'ui-swatch is-on' : 'ui-swatch'}
            style={{ background: c }}
            title={name}
            aria-label={name}
            aria-pressed={on}
            onClick={() => onPick(c)}
          />
        );
      })}
    </div>
  );
}
