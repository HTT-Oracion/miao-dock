/**
 * 开关（通用单元）。
 *
 * 纯受控：`on` + `onToggle`，组件自己不持状态 —— 状态一律归调用方
 * （设置项归 store、临时开关归局部 state）。
 *
 * 类名 `.switch` 是中性名，不随本次抽离改名；它的几何由规格自检 C6 覆盖，
 * 所以这里不写任何尺寸，尺寸只在 app.css 一处。
 */
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
