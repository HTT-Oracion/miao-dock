import React from 'react';
import { createRoot } from 'react-dom/client';

// 设计字体随应用分发（《02》§5）：不依赖用户系统是否装了这三款字体。
// 每个包按 unicode-range 切片，运行时只加载页面真正用到的分片。
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';

import '@/styles/base.css';
import '@/styles/app.css';

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
