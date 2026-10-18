import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { requestClose } from '../tools/window';

/** 标题栏的小圆头像（48px 那份，就够 24px 显示）；与 App 一样用**绝对 URL** 引公共资源 */
const BAR_LOGO = '/assets/icons/miao-logo-48.png';

/**
 * 猫耳窗口外壳 —— 标题栏 / 主体 / 底栏 / 脚注四段。
 *
 * 与安装向导同一套窗口（同一个物种要有同一张脸）：顶部两只猫耳由伪元素画出，
 * 卸载页的底栏外面多一行脚注，用来交代"卸载会留什么"。
 *
 * 宿主里窗口**没有系统标题栏**（`decorations: false`），所以标题栏要自己承担两件事：
 * 拖拽（`data-tauri-drag-region`）与关闭（右侧那枚 ✕）。
 */
export function WinShell({
  title,
  tag,
  foot,
  note,
  children,
}: {
  title: string;
  tag: string;
  foot: ReactNode;
  /** 底栏下方那行浅色脚注（`undefined` 时不渲染） */
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="uns-page">
      <div className="uns-win">
        <div className="uns-bar" data-tauri-drag-region>
          <img className="uns-bar-logo" src={BAR_LOGO} alt="" data-tauri-drag-region />
          <b className="uns-bar-title" data-tauri-drag-region>
            {title}
          </b>
          <span className="uns-bar-tag">{tag}</span>
          <button type="button" className="uns-bar-close" onClick={requestClose} title="关闭" aria-label="关闭">
            <X size={13} strokeWidth={2.4} />
          </button>
        </div>
        <div className="uns-win-body">{children}</div>
        <div className="uns-win-foot">{foot}</div>
        {note === undefined ? null : <div className="uns-win-note">{note}</div>}
      </div>
    </div>
  );
}
