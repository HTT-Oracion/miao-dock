/**
 * 剪贴板写入 —— 安装向导里唯一需要它的是「复制 PowerShell 命令」。
 *
 * 为什么不直接用 `navigator.clipboard`：安装向导将来可能跑在不受信任的上下文里
 * （file:// 或非 localhost 的 WebView），那里 `clipboard` 干脆不存在。
 * 返回是否成功，由调用方决定要不要把按钮切成「已复制」——**写失败不许假装成功**。
 */
export async function copyText(text: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // 权限被拒或非安全上下文：落到下面的兜底，不在这里放弃
    }
  }
  return copyViaTextarea(text);
}

/** 兜底路径：临时 textarea + 选中 + 旧的同步 copy 命令（无 Promise 可用） */
function copyViaTextarea(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
