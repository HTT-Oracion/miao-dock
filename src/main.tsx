import React from 'react';
import { createRoot } from 'react-dom/client';

// 设计字体随应用分发（《02》§5）：不依赖用户系统是否装了这三款字体。
// 每个包按 unicode-range 切片，运行时只加载页面真正用到的分片。
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';

// 随仓字体（`public/assets/fonts/<dir>/font.css`）由**入口 HTML**（`templates/index.html`）
// 用 `<link>` 加载，不在这里 import —— 它们是**不经过构建**的公共资源，Vite 原样复制到
// `dist/assets/fonts/`，走构建只会多拿一份带指纹的副本。
// 🔴 也不许改回 `styles/index.scss` 的 `@use`：Sass 对带 `.css` 后缀的 `@use` 是**静默丢弃**
//    的（不报错、不产出、不改 `url()`），字体全部不进构建而构建照常成功。
//    两条都由 `e2e/settings-media-check.mjs` 的 FONT 组钉着，别改回去。

// ① 标题/强调与纯数字「狮尾圆体（Swei Gothic CJK SC）」—— 思源黑体拔脚加圆的简体圆体，
// 随仓分发的 **woff2** + 清单放在 `public/assets/fonts/swei-gothic/`。
// ✅ 它有**原生 Bold**（不像霞鹜文楷 / 悠哉字体没有）⇒ 清单里 400 → Regular、700 → Bold，都是真字重。
// 🔴 族名必须写 TypoFamily 的 `Swei Gothic CJK SC`：狮尾**每字重一个独立 family**
//    （Family(1) 是 `… SC Regular` / `… SC Bold`），用错名字就取不到加粗那条 face。

// ② 正文「悠哉字体（Yozai）」—— lxgw 基于日文手写体 Y.OzFont 改造，繁简全覆盖、手写 Q 感；
// 随仓分发的单体 TTF + @font-face 清单放在 `public/assets/fonts/yozai-font/`。
// ⚠️ release v0.868 无 Bold ⇒ 清单里 700 映射到 Medium（真字重，避免浏览器合成加粗发糊）。

// ③ 回退位「霞鹜文楷 GB（LXGW WenKai GB）」—— 简体全覆盖的楷体（同时是**漫画译文**的渲染字体，
// 引擎侧见 D-105）；随仓分发的单体 TTF（Medium 档，无 Bold）+ 清单放在
// `public/assets/fonts/lxgw-wenkai-gb/`。

// 样式**只经 index.scss 一个入口**（《09》§2.4）：分片清单、层叠顺序与新增模块的规矩
// 都写在那个文件里，这里不再逐个 import —— 绕过入口就绕过了顺序约定。
import '@/styles/index.scss';

import { AppRouter } from '@/router';
import { useMusicStore } from '@music/store';

// 启动即水合音乐偏好：设置页「播放·媒体」要在**不打开音乐屏**的情况下显示上次存的值，
// 而完整 init（拉登录态/首屏数据）只在音乐屏挂载时跑。这一步只读 localStorage。
useMusicStore.getState().hydratePrefs();

/**
 * 桌面应用守卫：禁掉刷新/查找/查看源码/开发者工具快捷键，并取消默认右键菜单。
 *
 * 为什么装在入口：这是"这个程序是桌面应用、不是网页"的唯一收口处 —— 装在某个屏里，
 * 换一屏就失效；装在 App 里则每一次渲染都要重挂。入口只跑一次，语义也对。
 *
 * 🔴 **开发态放行**（`import.meta.env.DEV`）：Ctrl+R 刷新、F5、右键 inspect 都是排障手段，
 * 在 dev 里禁掉只会让人以为"我改的代码没生效"。要验这条守卫，跑的是**打包后的程序**。
 *
 * 右键菜单的例外是**可编辑元素**（input / textarea / contenteditable）：那里的原生菜单是
 * "剪切/复制/粘贴"，是桌面应用该有的样子；一刀切禁掉会让粘贴只剩快捷键一条路。
 */
function installDesktopGuards(): void {
  if (import.meta.env.DEV) return;
  const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
  const key = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  window.addEventListener(
    'keydown',
    (e) => {
      // F5 / F12 不带修饰键；其余都要 Ctrl 或 Cmd
      const bare = key(e) === 'F5' || key(e) === 'F12';
      const k = key(e);
      const combo =
        mod(e) &&
        (k === 'r' || // 刷新 / 硬刷新（Ctrl+Shift+R 一并覆盖）
          k === 'f' || // 页内查找
          k === 'u' || // 查看源码
          (e.shiftKey && (k === 'i' || k === 'j' || k === 'c'))); // 开发者工具
      if (bare || combo) e.preventDefault();
    },
    { capture: true },
  );
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
}
installDesktopGuards();

/**
 * 挂载前先取桌面平台：桌面歌词入口（播放条 / 展开播放器两处按钮）按它决定渲染与否，
 * 挂载后再补就会先画一帧不该出现的按钮再消失。
 * 平台取不到时按"不支持"兜底（见 `hydratePlatform`），取平台失败不阻断启动。
 */
async function bootstrap(): Promise<void> {
  await useMusicStore.getState().hydratePlatform();
  const el = document.getElementById('root');
  if (!el) throw new Error('缺少 #root 挂载点');
  createRoot(el).render(
    <React.StrictMode>
      <AppRouter />
    </React.StrictMode>,
  );
}
bootstrap();
