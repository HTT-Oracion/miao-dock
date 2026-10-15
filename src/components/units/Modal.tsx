import type { ReactNode } from 'react';

/**
 * 模态弹层（通用单元）：蒙层 + 卡片 + 「标题 / 正文 / 操作」三段。
 *
 * ## 为什么要有它
 * 这个壳在本仓被手写了 5 遍（退出确认 / 漫画库三个弹窗 / 设置页清缓存确认），
 * 每遍都是逐字相同的 `modal-mask` + `role="dialog"` + `aria-modal` + `stopPropagation`。
 * 一模一样的东西抄五份，改一处（比如加 `aria-labelledby`）必漏四处。
 *
 * ## 为什么 Esc / 焦点陷阱**不放这里**
 * 现状是"谁需要谁自己挂"（`CacheBlock` 在自身组件里调 `useEsc(onCancel)`），
 * 而不是每个弹层都收 Esc —— 一次性把它塞进通用件会**改变现有行为**
 * （例如退出确认原本不响应 Esc）。收口行为属独立决策，见 D-143。
 * 本件只做**结构**去重，行为一字不动。
 */
export function Modal({
  title,
  onClose,
  busy,
  children,
  actions,
}: {
  /** 标题；不传则不渲染标题行 */
  title?: ReactNode;
  /** 点蒙层 / 关闭时调用。`busy` 为真时蒙层点击**不生效**（避免提交中误关） */
  onClose: () => void;
  /** 提交中：蒙层点击失效（卡片内的按钮各自按需 disabled） */
  busy?: boolean;
  children: ReactNode;
  /** 操作区（通常是几个 `Btn`）；不传则不渲染操作行 */
  actions?: ReactNode;
}) {
  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      {/* `stopPropagation`：点卡片内部不该冒泡到蒙层把它关掉 */}
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {title ? <div className="modal-title">{title}</div> : null}
        <div className="modal-body">{children}</div>
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
