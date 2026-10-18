import { Btn, Modal } from '@components/units';

/**
 * 退出二次确认层（契约《02》§2.1）。
 *
 * 主文案是**文档明文规定**的，必须逐字照抄：
 *
 * > | 真正退出 | 托盘菜单 → 退出 Box，需**二次确认**，文案：「退出后浏览器插件将无法提交翻译任务」 |
 *
 * 这句曾经被我扩写成「退出后本地翻译服务会一起停掉，浏览器插件将无法提交翻译任务，
 * 直到你再次打开喵坞」—— 读起来更完整，但**不再包含文档要求的连续子串**（中间被切断了），
 * 按 B3 的判据直接不合格。教训：文档里带引号的文案是**字面量**，不是「意思到位就行」。
 * 补充说明一律另起一段，主文案一个字都不动。
 *
 * 回归钉子见 `spec-check.ts` 的 B3 组 —— 它把这段真实渲染出来再读 DOM 文本。
 */
export const QUIT_CONFIRM_COPY = '退出后浏览器插件将无法提交翻译任务';

export function QuitConfirm({ onStay, onQuit }: { onStay: () => void; onQuit: () => void }) {
  return (
    <Modal
      title="退出喵坞？"
      onClose={onStay}
      actions={
        <>
          <Btn kind="ghost" onClick={onStay}>
            留在后台
          </Btn>
          <Btn kind="danger" onClick={onQuit}>
            退出喵坞
          </Btn>
        </>
      }
    >
      {QUIT_CONFIRM_COPY}
      <br />
      <br />
      只是想收起窗口的话，点「留在后台」—— 服务会继续跑，托盘图标常驻。
    </Modal>
  );
}
