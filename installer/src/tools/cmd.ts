/**
 * PowerShell 命令的**复制形态**。
 *
 * 界面上分两行显示是为了看清 `-Path` 与 `-Name` 两段参数；但行尾那个续行符
 * （反引号）在"复制 → 粘贴到 PowerShell 窗口"这条路里并不总是可靠，
 * 所以复制出去的必须是没有换行的一整行 —— 展示与复制是两回事，别混为一谈。
 */
export function singleLineCommand(command: string): string {
  return command.replace(/`\r?\n\s*/g, ' ');
}
