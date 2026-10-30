import { AlertCircle } from 'lucide-react';
import { Btn, Modal } from '@components/units';

/**
 * 退出二次确认层（契约《02》§2.1）。
 *
 * 主文案是**文档明文规定**的，必须逐字照抄：
 *
 * > | 真正退出 | 托盘菜单 → 退出 Box，需**二次确认**，文案：「退出后浏览器插件将无法提交翻译任务」 |
 *
 * 这句曾经被扩写成「退出后本地翻译服务会一起停掉，浏览器插件将无法提交翻译任务，
 * 直到你再次打开喵坞」—— 读起来更完整，但**不再包含文档要求的连续子串**（中间被切断了），
 * 按 B3 的判据直接不合格。教训：文档里带引号的文案是**字面量**，不是「意思到位就行」。
 * 补充说明一律另起一段，主文案一个字都不动。
 *
 * 回归钉子见 `spec-check.ts` 的 B3 组 —— 它把这段真实渲染出来再读 DOM 文本。
 */
export const QUIT_CONFIRM_COPY = '退出后浏览器插件将无法提交翻译任务';

export function QuitConfirm({
  onStay,
  onQuit,
  onDismiss,
}: {
  onStay: () => void;
  onQuit: () => void;
  /**
   * 只关闭弹窗（右上角 × / 点蒙层）。
   *
   * 🔴 必须与 `onStay` 分开：`onStay` 是「留在后台」这个**动作**（关弹窗 + 收进托盘），
   *    而 × / 蒙层表达的是"我先不做决定、把弹窗收起"。此前两者共用同一个回调，
   *    于是点右上角 × 会把窗口收进托盘 —— 用户想的是"算了"，得到的是"窗口没了"。
   */
  onDismiss: () => void;
}) {
  return (
    <Modal
      width="narrow"
      title="退出喵坞？"
      onClose={onDismiss}
      actions={
        <>
          <div className="grow" />
          <Btn kind="ghost" onClick={onStay}>
            留在后台
          </Btn>
          <Btn kind="danger" onClick={onQuit}>
            退出喵坞
          </Btn>
        </>
      }
    >
      {/* 设计稿 `.confirm-line`：一枚告警图标 + 一句主文案，红底浅框 */}
      <div className="confirm-line is-warning">
        <AlertCircle size={15} />
        <div>
          {QUIT_CONFIRM_COPY}
          <br />
          <span>只是想收起窗口的话，点「留在后台」—— 服务会继续跑，托盘图标常驻。</span>
        </div>
      </div>

      {/*
       * 提示条：**用 `span` 而不是 `Notice`**。
       * 退出层这里是"一句补充说明"，不是需要图标与框的告示 ——
       * 上面那条 `.confirm-line` 已经是告警框了，再套一个盒子会让两段话抢同一个位置。
       * 上边距 12px 与 `.confirm-line` 拉开一档呼吸。
       */}
      <span className="quit-hint">本地服务与播放器会一起停止，已完成的作品不会受影响。</span>
    </Modal>
  );
}
