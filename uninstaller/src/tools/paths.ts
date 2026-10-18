/**
 * 路径派生（纯函数，不碰文件系统）。
 *
 * 存在的原因：界面要说"引擎数据未勾选时会留在哪"，而宿主给的 `engine.path` 是
 * `…/runtimes/manga-translator`，要说明的是它的父目录 `…/runtimes`。这层换算不能靠
 * 字符串截断散在组件里 —— 截错一个字符，用户就会去翻一个不存在的目录。
 */

/** `…\runtimes\manga-translator` ⇒ `…\runtimes`；形态不符时原样返回（不猜） */
export function runtimesRoot(enginePath: string): string {
  const hit = /^(.*)[\\/]manga-translator[\\/]?$/.exec(enginePath);
  return hit && hit[1] ? hit[1] : enginePath;
}
