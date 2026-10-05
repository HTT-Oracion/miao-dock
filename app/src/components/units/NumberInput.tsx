import { useEffect, useRef, useState } from 'react';

/**
 * 数字输入（通用单元）—— 一个**带提交语义**的窄数字框。
 *
 * ## 为什么不用 `<input type="number">`
 * 三个具体问题，每一个都真的会咬人：
 *   ① 某些浏览器在空值时仍会回一个 `''` 而不是 `NaN`，`Number('')` 是 **0** ——
 *      「把框里清空」会被读成「设为 0」，而 0 在本项目的语义是「**从不卸载**」。
 *      用户想删掉重打，结果改成了"永不卸载"，且没有任何提示。
 *   ② 它的上下箭头把宽度撑成平台相关（Safari/Chromium/Windows 三种宽度），
 *      而设置页右列是**固定窄列**，宽度漂移会挤到标题。
 *   ③ `e` / `+` / `-` 在 number 类型下被吞掉却不报错，用户看不出输入被拒了。
 * ⇒ 用 `type="text"` + `inputMode="numeric"`：自己控制"什么算合法输入"。
 *
 * ## 提交语义：**失焦或回车才落定**（不是每敲一个字符就写）
 * 逐字符提交的话，想把 `5` 改成 `30` 会先经历 `3`（= 3 分钟）—— 那是一次**真实生效**的
 * 写入（空闲卸载阈值立刻重建看护）。用户还在打字，系统已经照着他的半截输入改过一遍了。
 * 所以：编辑期间只动本地草稿，`blur` / `Enter` 时校验并提交，`Esc` 放弃。
 *
 * ## 非法输入不静默吞掉
 * 解析不出数字、或超出 `[min,max]`，一律**退回上一个合法值**并把框里显示改回来 ——
 * 而不是写一个被 clamp 过的近似值：那会让人以为自己输的 2000 生效了（其实是 1440）。
 * 退回是**可见的**（框里的数会跳回原值），用户立刻知道"这次没接受"。
 */
export function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  suffix,
  disabled = false,
  title,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  suffix?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  /** 正在编辑时不允许外部值把草稿冲掉（否则保存后的回读会打断用户的输入） */
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    editing.current = false;
    const n = Number(draft.trim());
    // `Number('')` 是 0，所以空串必须**单独挡掉** —— 这是本组件存在的首要理由（见文件头 ①）
    const ok = draft.trim() !== '' && Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max;
    if (!ok) {
      setDraft(String(value)); // 可见地退回：用户立刻知道这次没被接受
      return;
    }
    if (n !== value) onChange(n);
    setDraft(String(n));
  };

  return (
    <>
      <input
        type="text"
        className="ui-num"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        aria-label={label}
        title={title}
        onFocus={() => { editing.current = true; }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          // Esc 放弃这次编辑（与弹层/下拉的 Esc 语义一致）
          if (e.key === 'Escape') { editing.current = false; setDraft(String(value)); (e.target as HTMLInputElement).blur(); }
          // 上下键按 step 调一格 —— 键盘用户不必去点那个（我们刻意不画的）箭头
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = Math.min(max, Math.max(min, value + (e.key === 'ArrowUp' ? step : -step)));
            if (next !== value) onChange(next);
            setDraft(String(next));
          }
        }}
      />
      {suffix ? <span className="ui-num-suffix">{suffix}</span> : null}
    </>
  );
}
