/**
 * 原生取色器（通用单元）。
 *
 * `value` 始终回显当前色；`disabled` 是「**有真实理由的状态**」而非占位，
 * 调用方给 false 时必须真的可用（不允许出现点不动的假控件）。
 */
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
      className="ui-color"
      value={value}
      disabled={disabled}
      aria-label={label}
      title={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
