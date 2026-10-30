import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

/**
 * 当前构建版本号（`null` = 还没读到 / 读不到）。
 *
 * 工具条上的 `v2.2.1` 与设置页「关于」那一行必须是**同一个事实源**：版本号只由宿主
 * （`env!("CARGO_PKG_VERSION")` → Tauri `getVersion()`）注入，界面里没有任何字面量副本。
 *
 * 读不到时返回 `null`，由调用方**整枚隐藏**而不是退回硬编码字符串 —— 一个与当前包无关的
 * 版本号比没有版本号更糟：它让人以为看的就是这个包。
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await getVersion();
        if (alive) setVersion(v);
      } catch {
        // 非 Tauri 环境（浏览器预览）或未授权：保持 null，界面上不出现版本徽标
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return version;
}
