import { Settings, X } from 'lucide-react';
import { IconButton } from '@components/units';
import { useEsc } from '@hooks/useEsc';

/**
 * 桌面歌词设置弹窗。
 *
 * 本阶段**只交付骨架**：标题 + 关闭 + 「更多设置项见设置页」的占位说明。
 * 为什么先留占位而不是直接铺开设置项：桌面歌词的偏好（字号、高亮色、锁定等）
 * 已经由**设置页**统一持有并落到同一套 store 字段上，弹窗这里若再摆一份，
 * 就会出现「两个地方改同一个偏好」的第三份副本 —— 那正是本项目最反对的那种状态。
 * 具体摆哪些项、以及是否把设置页那一批整体搬进来，属于后续任务的范围，这里不替它决定。
 *
 * 复用方式：受控组件（`open` + `onClose`），由调用方决定开合；组件自身不持状态，
 * 这样 PlayerBar 之外（例如以后从设置页唤起）也能直接复用同一个弹窗。
 */
export function DesktopLyricsSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  /*
   * Esc 关闭挂在组件常驻期间（不随 open 卸载重挂）：
   * 关闭态下不响应，避免一个没打开的弹窗抢走全局 Esc。
   */
  useEsc(() => {
    if (open) onClose();
  });

  if (!open) return null;

  return (
    <div className="music-dlset-overlay" onClick={onClose}>
      {/* 阻止冒泡：点弹窗内部不应触发遮罩的「点击关闭」 */}
      <div className="music-dlset" onClick={(e) => e.stopPropagation()}>
        <div className="music-dlset-hd">
          <span className="music-dlset-title">
            <Settings size={15} /> 桌面歌词设置
          </span>
          <IconButton title="关闭" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="music-dlset-body">
          <div className="music-dlset-note">更多设置项见设置页</div>
        </div>
      </div>
    </div>
  );
}
