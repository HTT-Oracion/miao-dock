import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 安装向导的**独立**构建配置。
 *
 * 它是一个独立安装器程序的前端部分：自己的入口、自己的产物目录（`installer/dist`），
 * 不登记在主工程的 `vite.config.ts` 里 —— 两边各自构建、各自分发，互不牵连。
 * `root` 不用显式写：Vite 默认取配置文件所在目录。
 *
 * 别名一概不设：这个应用自给自足（自己的令牌、自己的工具函数），
 * 引用只有同目录相对路径，不指向主工程任何源码。
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // 与主窗取同一档：安装向导将来跑在 WebView2（Chromium）里，这一档保守但一致
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
  },
  server: {
    port: 1444,
    strictPort: true,
  },
});
