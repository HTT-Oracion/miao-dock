import React from 'react';
import { createRoot } from 'react-dom/client';

// 设计字体随应用分发（《02》§5）：不依赖用户系统是否装了这三款字体。
// 每个包按 unicode-range 切片，运行时只加载页面真正用到的分片。
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';

// 正文首选「源柔ゴシックP Medium」—— 没有可用的 npm 包（`@fontsource/genjyuu-gothic`
// 只含 latin 子集、不含汉字），故按**随仓分发**处理：120 片 woff2 + 一份 @font-face 清单
// 放在 `src/assets/fonts/genjyuu-gothic-p-medium/`，在这里引它的 `font.css`。
//
// ⚠️ 必须从**这里**（JS 侧）引，不能写进 `styles/index.scss` 的 `@use`：
//    Sass 对「带 `.css` 后缀的 `@use`」是**静默丢弃**的 —— 不报错、不产出、也不改 `url()`，
//    于是 120 片字体会全部不进构建（`dist/` 里 0 个 GenJyuu 分片），
//    而 `npm run build` 照样成功、页面照样渲染（只是回落到 Noto Sans SC）。
//    走 JS 侧的 CSS 模块引用，Vite 才会处理 `url()` 并把 woff2 落进 `dist/assets/`。
//    这一条已钉在 `e2e/settings-media-check.mjs` 的 FONT 组，别改回去。
import '@/assets/fonts/genjyuu-gothic-p-medium/font.css';

// 样式**只经 index.scss 一个入口**（《09》§2.4）：分片清单、层叠顺序与新增模块的规矩
// 都写在那个文件里，这里不再逐个 import —— 绕过入口就绕过了顺序约定。
import '@/styles/index.scss';

import { App } from '@/App';
import { useMusicStore } from '@music/store';

// 启动即水合音乐偏好：设置页「播放·媒体」要在**不打开音乐屏**的情况下显示上次存的值，
// 而完整 init（拉登录态/首屏数据）只在音乐屏挂载时跑。这一步只读 localStorage。
useMusicStore.getState().hydratePrefs();

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
