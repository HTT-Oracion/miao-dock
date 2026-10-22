import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 字号随视口宽度分档（对齐设计稿的 `--ui-scale`）。档位值只写在一处
 * （`src/styles/base.scss` 的 `:root`），**换算发生在构建期**。
 *
 * ## 为什么不把 400 多处 `font-size` 直接写成 `calc()`
 * 设计稿那份是每处都写 `calc(9.5px * var(--ui-scale))` —— 把**一件事重复 434 遍**：
 * 新写样式的人会忘，忘了就静默不跟随，而静态检查看不出谁漏了。改成编译期统一换算后：
 *  ① 源码里仍是设计稿的原始像素，「字号阶梯 1:1」的逐条比对判据照旧读源码；
 *  ② 不会漏 —— 换算不依赖写样式的人记得套模板；
 *  ③ 档位与实现各只有一处可改。
 *
 * ## 边界（三条都是刻意的）
 *  - 只换算 `font-size: <数字>px`。`clamp(...)`（工具条大标题，本身已随视口变，再乘是双重放大）
 *    与 `var(--…)`（用户可设的歌词字号，「17–48 px」是对用户的字面承诺）一律不动。
 *  - **番剧不跟随**：不在这里按文件排除 —— 所有分片最终合并进同一个 CSS 产物，
 *    到那时已经没有"哪条规则来自哪个分片"的信息了（实测：按文件排除在 build 阶段失效，
 *    55 条 `.an-*` 照样被换算）。改由隔离作用域关掉：`base.scss` 的 `.an-root { --ui-scale: 1 }`，
 *    番剧整棵子树就地取到 1。这样 dev 与 build 走的是同一套文本，不产生第二种行为。
 *  - 只作用于字号，不碰间距与圆角 —— 与设计稿同口径。
 *
 * ## ⚠️ 代价与取证
 * 产物里的字号与源码不再逐字相同 ⇒ **取证要看浏览器里的 computed `font-size`**，
 * 只看源码或只看 CSS 文本都会骗人。而且 dev 与 build 取自不同阶段，**两侧都要各验一次**：
 * 只挂 `transform` 时 dev 正常、产物里 530 条字号仍是纯 px —— 那正是最坏的静默分叉。
 * （探针：`.tmp/ver3-audit/probe-ui-scale.mjs`，五个视口量同一批锚点的计算值。）
 */
const FONT_PX = /font-size:\s*(\d+(?:\.\d+)?)px/g;

const scaleFonts = (code: string) =>
  code.replace(FONT_PX, (_all, n: string) => `font-size: calc(${n}px * var(--ui-scale))`);

function uiScaleFonts(): Plugin {
  return {
    name: 'miaodock:ui-scale-fonts',
    enforce: 'post',
    // **dev**：`.scss` 编译后的模块代码里带着 CSS 串，在这里换。
    transform(code, id) {
      if (!/\.s[ac]ss/.test(id) || /node_modules/.test(id)) return null;
      if (!code.includes('font-size:')) return null;
      const out = scaleFonts(code);
      return out === code ? null : { code: out, map: null };
    },
    // **build**：Vite 把提取后的 CSS 作为 **asset** 产出，不再经过 transform 链，
    // 所以同一个函数要在产物阶段再挂一次。两个钩子共用 `scaleFonts` 这一份规则 ——
    // 分叉的是"CSS 在哪一阶段能被拿到"，不是"换算有两套"。
    generateBundle(_options, bundle) {
      for (const [file, item] of Object.entries(bundle)) {
        if (!file.endsWith('.css') || item.type !== 'asset') continue;
        const src = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
        if (!src.includes('font-size:')) continue;
        item.source = scaleFonts(src);
      }
    },
  };
}

// 路径别名 —— 必须与 tsconfig.json 的 paths **双处同步**（少一处会出现
// 「dev 能跑 build 报错」或反过来的静默漂移）。规则与记因见《09》§2.3、spec-notes D-40。
// 求绝对路径不引 node:path —— 本工程未装 @types/node，为零依赖场景引包不划算；
// URL 是标准 Web API，tsc 直接可查；decodeURIComponent 兜住含空格/中文的仓库路径。
const aliasPath = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

// Tauri 约定的开发端口：固定 1420，避免与其它 vite 工程撞端口后 Tauri 找不到页面
export default defineConfig({
  plugins: [react(), uiScaleFonts()],
  resolve: {
    alias: {
      // 键顺序无关：Vite 按「精确相等 或 前缀后紧跟 /」匹配，
      // 因此 '@tauri' 不会误伤 '@tauri-apps/*' 包，'@' 不会吃掉 '@/components' 以外的专属别名
      '@tauri': aliasPath('./src-tauri'),
      '@components': aliasPath('./src/components'),
      '@screens': aliasPath('./src/screens'),
      '@music': aliasPath('./src/modules/music'),
      '@anime': aliasPath('./src/modules/anime'),
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
      //
      // 🔴 安装向导与卸载页**不在这里登记**：它们是各自独立的安装器 / 卸载器程序
      //    （`installer/` · `uninstaller/`，自带 vite 配置与产物目录），
      //    与主应用各自构建、各自分发 —— 合并成一个工程只会让两边互相牵连。
      //    构建它们：`npm run task -- installer:build` / `uninstaller:build`。
      input: {
        main: new URL('./templates/index.html', import.meta.url).pathname,
        lyrics: new URL('./templates/lyrics.html', import.meta.url).pathname,
      },
    },
  },
});
