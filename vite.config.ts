import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 路径别名 —— 必须与 tsconfig.json 的 paths **双处同步**（少一处会出现
// 「dev 能跑 build 报错」或反过来的静默漂移）。规则与记因见《09》§2.3、spec-notes D-40。
// 求绝对路径不引 node:path —— 本工程未装 @types/node，为零依赖场景引包不划算；
// URL 是标准 Web API，tsc 直接可查；decodeURIComponent 兜住含空格/中文的仓库路径。
const aliasPath = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

// Tauri 约定的开发端口：固定 1420，避免与其它 vite 工程撞端口后 Tauri 找不到页面
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 键顺序无关：Vite 按「精确相等 或 前缀后紧跟 /」匹配，
      // 因此 '@tauri' 不会误伤 '@tauri-apps/*' 包，'@' 不会吃掉 '@/components' 以外的专属别名
      '@tauri': aliasPath('./src-tauri'),
      '@components': aliasPath('./src/components'),
      '@screens': aliasPath('./src/screens'),
      '@music': aliasPath('./src/music'),
      '@hooks': aliasPath('./src/hooks'),
      '@tools': aliasPath('./src/tools'),
      '@': aliasPath('./src'),
    },
  },
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
    rollupOptions: {
      // 多入口：桌面歌词是**独立窗口**，有自己的 HTML（`templates/lyrics.html`）。
      // 单入口时它无法被单独加载 —— 只能靠主页面里判 URL 再切换，那是"在一个窗口里假装两个窗口"，
      // 既做不到置顶，也做不到跟随播放。
      // ⚠️ 两个入口必须落在**同一 origin**（同一 dist 目录）—— 跨 origin 会让 localStorage 隔离，
      // 歌词窗就读不到主窗写的偏好（实测结论见 spec-notes D-47）。
      // ⚠️ 入口 HTML 住在 `templates/`（**不是** `public/`）：`public/` 是"原样拷贝、不参与构建"，
      // 放进去不会被打进 dist 的同一 origin，也不会做资源改写。`templates/` 在 root 之内，
      // 入口里的 `/src/...` 照常解析；代价是产物落在 `dist/templates/{index,lyrics}.html`，
      // 故 `tauri.conf.json` 的主窗 `url` 与 `lyrics_window.rs` 的 `WebviewUrl::App` 都指向该子路径。
      input: {
        main: new URL('./templates/index.html', import.meta.url).pathname,
        lyrics: new URL('./templates/lyrics.html', import.meta.url).pathname,
      },
    },
  },
});
