/**
 * 预设色点组（通用单元）：从一组候选色里挑一个。
 *
 * `value` 命中的那个加 `is-on`（CSS 用 ring 标选中，**不覆盖色点本身的颜色** ——
 * 色点的颜色就是它所承载的信息，被选中态盖掉就白选了）。
 *
 * `title` / `aria-label` 都写颜色值：色点的信息就是"它是什么颜色"，
 * 只靠视觉传达会让色觉障碍用户与读屏用户拿不到任何信息。
 *
 * 需要"预设之外的颜色"时，与 `ColorPicker` 并排使用（两者写同一个值）。
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
    <div className="ui-swatches" role="group" aria-label={label}>
      {colors.map((c) => {
        const on = c.toLowerCase() === cur;
        return (
          <button
            key={c}
            type="button"
            className={on ? 'ui-swatch is-on' : 'ui-swatch'}
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
