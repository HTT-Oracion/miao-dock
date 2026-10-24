import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * 模态弹层（通用单元）。
 *
 * 结构按设计稿的 `modal-card` 四段还原：
 * `modal-head`（kicker + h2 + p + 关闭键）/ `modal-body` / `modal-foot`。
 * 三档宽度：默认 520 / `wide` 680 / `narrow` 420（`.modal-card` 系列）。
 *
 * ## 🔴 这里**不用** Portal（试过，退回来了）
 *
 * `.modal-layer` 是 `position: fixed`，会被带 `backdrop-filter` / `transform` / `filter`
 * 的祖先当作**包含块**（播放条 `.music-player` 就有 `backdrop-filter: blur(20px)`）。
 * 曾用 `createPortal` 把弹层挪到 `body` 规避这一点 —— 结果**弹窗里的按钮全部点不动**：
 * React 18 把事件委托挂在根容器（`#root`）上，靠事件冒泡到根来分发；
 * 挂到 `body` 之后事件不再经过 `#root`，`onClick` 一个都不触发
 * （实测：退出确认开着，点「留在后台」「退出喵坞」都没反应，蒙层也关不掉）。
 * 挂回 `#root` 内部也不行 —— 手动 `appendChild` 的容器不在 React 的 fiber 树里，
 * React 无法从 DOM 反查到组件，事件依旧分发不到。
 *
 * **正解是调用方负责**：把弹窗渲染在任何"带滤镜/变换的祖先"**之外**
 * （`PlayerBar` 已把「桌面歌词设置」挪到 `.music-player` 外面）。
 * 这样弹层仍在原位、仍在 React 事件树里，定位也回到视口坐标。
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

  return (
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
    </div>
  );
}
