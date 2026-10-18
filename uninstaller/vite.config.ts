import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 卸载页的**独立**构建配置。
 *
 * 它是一个独立卸载器程序的前端部分：自己的入口、自己的产物目录（`uninstaller/dist`），
 * 不登记在主工程的 `vite.config.ts` 里 —— 与安装向导同样，各自构建、各自分发。
 * `root` 不用显式写：Vite 默认取配置文件所在目录。
 *
 * 别名一概不设：这个应用自给自足，引用只有同目录相对路径，
 * 既不指向主工程，也不指向 `installer/`（两个程序不许互相引用）。
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // 与主窗取同一档：卸载页将来跑在 WebView2（Chromium）里，这一档保守但一致
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
  },
});
