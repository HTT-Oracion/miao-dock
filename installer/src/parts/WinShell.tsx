import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { requestClose } from '../tools/window';

/** 标题栏的小圆头像（48px 那份，就够 24px 显示）；与 App 一样用**绝对 URL** 引公共资源 */
const BAR_LOGO = '/assets/icons/miao-logo-48.png';

/**
 * 猫耳窗口外壳 —— 标题栏 / 主体 / 底栏三段。
 *
 * 视觉取自安装引导页设计稿：顶部两只猫耳是伪元素画的三角形，与窗口同填 `surface`、
 * 同描 `line`（三角形没法直接给边框，靠 drop-shadow 补那一圈描边）。
 *
 * 宿主里窗口**没有系统标题栏**（`decorations: false`），所以标题栏要自己承担两件事：
 * 拖拽（`data-tauri-drag-region`）与关闭（右侧那枚 ✕）。
 */
export function WinShell({
  title,
  tag,
  foot,
  children,
}: {
  /** 标题栏左侧的产品名/窗口名 */
  title: string;
  /** 标题栏右侧的圆角标签（当前进展） */
  tag: string;
  /** 底栏内容：左侧说明 + 右侧按钮由调用方排 */
  foot: ReactNode;
  /** 窗口主体 */
  children: ReactNode;
}) {
  return (
    <div className="isr-page">
      <div className="isr-win">
        <div className="isr-bar" data-tauri-drag-region>
          <img className="isr-bar-logo" src={BAR_LOGO} alt="" data-tauri-drag-region />
          <b className="isr-bar-title" data-tauri-drag-region>
            {title}
          </b>
          <span className="isr-bar-tag">{tag}</span>
          <button type="button" className="isr-bar-close" onClick={requestClose} title="关闭" aria-label="关闭">
            <X size={13} strokeWidth={2.4} />
          </button>
        </div>
        <div className="isr-win-body">{children}</div>
        <div className="isr-win-foot">{foot}</div>
      </div>
    </div>
  );
}
