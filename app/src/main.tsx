import React from 'react';
import { createRoot } from 'react-dom/client';

// 设计字体随应用分发（《02》§5）：不依赖用户系统是否装了这三款字体。
// 每个包按 unicode-range 切片，运行时只加载页面真正用到的分片。
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';

import './styles/base.css';
import './styles/app.css';

import { App } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
