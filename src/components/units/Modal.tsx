import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * 模态弹层（通用单元）。
 *
 * 结构按设计稿的 `modal-card` 四段还原：
 * `modal-head`（kicker + h2 + p + 关闭键）/ `modal-body` / `modal-foot`。
 * 三档宽度：默认 520 / `wide` 680 / `narrow` 420（`.modal-card` 系列）。
 *
 * ## 🔴 必须走 `createPortal` 挂到 `body`
 *
 * `.modal-layer` 是 `position: fixed`，而 fixed 的定位基准是**最近的"包含块"**，
 * 不是视口 —— 只要某个祖先带 `backdrop-filter` / `transform` / `filter` /
 * `will-change`，它就会成为包含块，fixed 元素改成相对**那个祖先**定位。
 *
 * 这不是理论风险：播放条 `.music-player` 就有 `backdrop-filter: blur(20px)`，
 * 「桌面歌词设置」弹窗正挂在它内部 ⇒ 蒙层只盖住播放条那一小条、卡片被挤到
 * 播放条的位置上（用户报的"弹窗位置混乱"）。挂到 `body` 就与祖先样式彻底解耦，
 * 任何调用方都不用再关心自己上面有没有滤镜。
 *
 * ## 为什么 Esc / 焦点陷阱**不放这里**
 * 现状是"谁需要谁自己挂"（`CacheBlock` 在自身组件里调 `useEsc(onCancel)`），
 * 一次性把它塞进通用件会**改变现有行为**（例如退出确认原本不响应 Esc）。
 * 收口行为属独立决策。本件只做**结构**去重。
 */
export function Modal({
  title,
  subtitle,
  kicker,
  width = 'default',
  cardClass,
  bodyClass,
  onClose,
  busy,
  children,
  actions,
}: {
  /** 标题（`modal-head h2`）；不传则不渲染标题区 */
  title?: ReactNode;
  /** 标题下的一句说明（`modal-head p`） */
  subtitle?: ReactNode;
  /** 标题上方的小字标签（`modal-kicker`） */
  kicker?: ReactNode;
  /** 卡片宽度档（设计稿 `.modal-card` / `.is-wide` / `.is-narrow`） */
  width?: 'default' | 'wide' | 'narrow';
  /**
   * 卡片 / 内容区的**特性修饰类**（设计稿的 `.login-card`、`.login-body` 这种"某个弹窗自己的尺寸与内边距"）。
   * 单元只管结构，特性样式留在各自的样式分片里 —— 与设计稿的分法一致。
   */
  cardClass?: string;
  bodyClass?: string;
  /** 点蒙层 / 关闭键时调用。`busy` 为真时蒙层点击**不生效**（避免提交中误关） */
  onClose: () => void;
  /** 提交中：蒙层点击失效（卡片内的按钮各自按需 disabled） */
  busy?: boolean;
  children: ReactNode;
  /** 操作区（`modal-foot`，通常是几个 `Btn`）；不传则不渲染操作行 */
  actions?: ReactNode;
}) {
  const baseCard = width === 'wide' ? 'modal-card is-wide' : width === 'narrow' ? 'modal-card is-narrow' : 'modal-card';
  const cardCls = cardClass ? `${baseCard} ${cardClass}` : baseCard;
  const bodyCls = bodyClass ?? 'modal-body';
  const hasHead = Boolean(kicker || title || subtitle);

  return createPortal(
    <div className="modal-layer">
      <div className="modal-mask" onClick={busy ? undefined : onClose} />
      {/* `stopPropagation`：点卡片内部不该冒泡到蒙层把它关掉 */}
      <div className={cardCls} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {hasHead ? (
          <header className="modal-head">
            <div>
              {kicker ? <span className="modal-kicker">{kicker}</span> : null}
              {title ? <h2>{title}</h2> : null}
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose} disabled={busy}>
              {/* 18 = 设计稿 `.ico` 默认档（`.icon-btn` 34×34 里的那颗）*/}
              <X size={18} />
            </button>
          </header>
        ) : null}
        <div className={bodyCls}>{children}</div>
        {actions ? <footer className="modal-foot">{actions}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
