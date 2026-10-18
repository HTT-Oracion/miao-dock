import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../tools/clipboard';
import { singleLineCommand } from '../tools/cmd';

/** 「已复制」状态的持续时间（毫秒）—— 够看清变化，又不至于让按钮长时间不可用 */
const COPIED_HOLD_MS = 1600;

/**
 * 命令块 —— 深色地 + 单色字 + 右侧一枚复制按钮。
 *
 * 界面显示多行、复制出去一行（理由见 `tools/cmd.ts`）；复制**失败不切换图标**，
 * 否则用户以为已经粘上了，实则剪贴板还是上一次的内容。
 */
export function CmdBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    if (!(await copyText(singleLineCommand(command)))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPIED_HOLD_MS);
  }

  return (
    <div className="isr-code">
      <pre>{command}</pre>
      <button type="button" className="isr-code-copy" onClick={handleCopy}>
        {copied ? <Check size={11} strokeWidth={2.6} /> : <Copy size={11} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
