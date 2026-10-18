#!/usr/bin/env node
/**
 * 构建安装向导 / 卸载页 —— 两个**各自独立**的安装器 / 卸载器程序的前端部分。
 *
 * 为什么不在主工程的 `vite.config.ts` 里登记：那两个程序与主应用各自构建、各自分发
 * （`installer/` · `uninstaller/` 自带 vite 配置与产物目录），合到一个工程里只会让两边互相牵连。
 *
 * ## 每步做什么
 *   ① 字体注入：把 `public/assets/fonts/` 复制进 `<app>/public/fonts/`（该目录已 gitignore）。
 *      为什么运行时才注入：三份字体合计约 65 MB，两个程序各存一份就是 130 MB 的仓库重复。
 *      字体到位后 `node node_modules/vite/bin/vite.js --config <app>/vite.config.ts`（dev）也能拿到同一套字。
 *   ② 类型检查：`tsc -p <app>/tsconfig.json --noEmit`（独立工程，编译选项与主工程隔离）。
 *   ③ 打包：在**该程序自己的目录**里跑 `vite build` ⇒ 产物落 `<app>/dist/`。
 *
 * 用法：node scripts/build-install-ui.mjs <installer|uninstaller>
 * 🔴 子进程一律**异步 spawn**（本环境同步 spawn 直接 EBUSY，见 AGENTS.md §5），
 *    且不套 shell：直接用 `node <包内 js 入口>` 起，避开 Windows 上 .cmd 必须 shell 的坑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_SRC = path.join(ROOT, 'public', 'assets', 'fonts');
const APPS = ['installer', 'uninstaller'];

const which = process.argv[2];
if (!APPS.includes(which)) {
  console.error(`✗ 用法：node scripts/build-install-ui.mjs <${APPS.join('|')}>`);
  process.exit(2);
}
const appDir = path.join(ROOT, which);

if (!fs.existsSync(path.join(appDir, 'index.html'))) {
  console.error(`✗ ${which}/index.html 不在 —— 这个目录不是独立的界面程序`);
  process.exit(1);
}

/** 递归拷贝（字体目录不大；目标先清掉，防止旧文件残留） */
function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** 起一个子进程并等它结束；返回退出码（0 = 成功）。cwd 默认落在被构建的程序目录里 */
function run(node, args, cwd = appDir) {
  return new Promise((resolve) => {
    const child = spawn(node, args, { cwd, stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`✗ 起不了子进程：${e.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// ① 字体注入
copyDir(FONTS_SRC, path.join(appDir, 'public', 'fonts'));
console.log(`✓ 字体已注入 ${which}/public/fonts/`);

// `--fonts-only`：给各自 package.json 的 predev 用（起 dev 前先把字体摆好），不跑类型与打包
if (process.argv.includes('--fonts-only')) process.exit(0);

// ② 类型检查（独立 tsconfig）
const tsc = await run(process.execPath, [
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p',
  'tsconfig.json',
  '--noEmit',
]);
if (tsc !== 0) {
  console.error(`✗ ${which} 类型检查未通过`);
  process.exit(1);
}
console.log(`✓ ${which} 类型检查通过`);

// ③ 打包（root = 该程序自己的目录，Vite 自动找到它的 vite.config.ts）
const built = await run(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
if (built !== 0) {
  console.error(`✗ ${which} 构建失败`);
  process.exit(1);
}
console.log(`✓ ${which} 产物在 ${which}/dist/`);
