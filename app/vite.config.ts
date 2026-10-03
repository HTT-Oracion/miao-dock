import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 约定的开发端口：固定 1420，避免与其它 vite 工程撞端口后 Tauri 找不到页面
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 使用固定版本的 WebView，可按其支持的语法输出
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
  },
});
