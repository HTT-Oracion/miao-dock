#!/usr/bin/env node
/**
 * 组装「单文件安装器」—— 本地分发件，不写进版本库。
 *
 * 产物（`release/`）**只有一份**：
 *   MiaoDock-Setup.exe   安装器（自带界面 + 内嵌载荷：主程序 / 资源 / 卸载器）
 *
 * 🔴 落点是仓库根的 `release/`（已 gitignore），**不是** `.tmp/`：
 *    `.tmp/` 是"跑完就能删的中间件"，而这份是**要交给人的成品** ——
 *    混在一起时，清理临时目录会顺手把交付物一起删掉。
 *
 * ## 顺序是硬约束：载荷必须先于安装器产出
 *   ① 卸载器宿主（`uninstaller/`：Tauri CLI，前端内嵌）
 *   ② 载荷（`scripts/pack-install-payload.mjs`：主程序 exe + 资源 + 卸载器 exe → payload.zip）
 *   ③ 安装器宿主（`installer/`：Tauri CLI，`include_bytes!` 把载荷嵌进 exe）
 *   ④ 复制成 `MiaoDock-Setup.exe`
 * ②→③ 反了会嵌进上一次的旧载荷（甚至编译不过：载荷缺失时 `build.rs` 只补占位）。
 *
 * ## 🔴 必须走 Tauri CLI，不能直接 `cargo build`
 * 实测（2026-10-18）：`cargo build --release` 出来的宿主 exe 只有 7.5 MB，**没内嵌前端**，
 * 起来会去连 dev 服务 ⇒ 没有 dev 服务就是一片空白。只有 `tauri build`
 * （本脚本调用的那条）才会把 `dist/` 打进 exe。所以这套件**只做 release**。
 *
 * ## 主程序 exe 从哪来
 * `npm run app:build`（主工程 `tauri build`）产出的 `src-tauri/target/release/miao-dock.exe`。
 * 本脚本**不代跑**它（几分钟起步），缺了直接报错点名 —— 载荷里少了主程序，
 * 装出来的就是"有快捷方式但打不开"的空壳。
 *
 * 用法：node scripts/package-install-ui.mjs
 * 🔴 子进程一律异步 spawn：本环境同步 spawn 直接 EBUSY（AGENTS.md §5）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const OUT = path.join(ROOT, 'release');

/** 交付文件名（唯一分发物） */
const DELIVERABLE = 'MiaoDock-Setup.exe';

const APP_EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'miao-dock.exe');
const UNINSTALLER_EXE = path.join(ROOT, 'uninstaller', 'src-tauri', 'target', 'release', 'miaodock-uninstaller.exe');
const INSTALLER_EXE = path.join(ROOT, 'installer', 'src-tauri', 'target', 'release', 'miaodock-installer.exe');

/** 上一代套件留下的文件名（`miao-installer` 时代 + NSIS 安装包），顺手清掉免得混淆 */
const LEGACY = ['miao-installer.exe', 'miao-uninstaller.exe'];

function run(node, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(node, args, { cwd, stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`✗ 起不了子进程：${e.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 覆盖复制。目标可能正被**运行中的程序**占用（用户开着安装器窗口看界面），
 * 那种占用会持续到用户关窗为止 —— 重试几次再报一句人话，而不是甩一个 EBUSY 栈。
 */
async function copyInto(from, to) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.copyFileSync(from, to);
      return true;
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      await sleep(400);
    }
  }
  return false;
}

function mustExist(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺构建产物：${path.relative(ROOT, file)}\n  ${hint}`);
    process.exit(1);
  }
  return file;
}

if (!fs.existsSync(TAURI_CLI)) {
  console.error(`✗ 没装 Tauri CLI：${path.relative(ROOT, TAURI_CLI)}\n先 npm install`);
  process.exit(1);
}

mustExist(APP_EXE, '先跑 `npm run app:build`（主工程 Tauri CLI 构建）');

// ① 卸载器宿主（同时把 dist 打进 exe；它的 exe 是载荷的一部分）
console.log('→ ① 构建卸载器宿主（release，前端内嵌）');
if ((await run(process.execPath, [TAURI_CLI, 'build'], path.join(ROOT, 'uninstaller'))) !== 0) {
  console.error('✗ 卸载器宿主构建失败');
  process.exit(1);
}
mustExist(UNINSTALLER_EXE, '卸载器宿主构建产物不在（见上一步日志）');

// ② 载荷（必须在安装器之前）
console.log('→ ② 打载荷（主程序 + 资源 + 卸载器 → payload.zip）');
if ((await run(process.execPath, [path.join(ROOT, 'scripts', 'pack-install-payload.mjs')], ROOT)) !== 0) {
  console.error('✗ 载荷打包失败');
  process.exit(1);
}

// ③ 安装器宿主（include_bytes! 在这一步把载荷嵌进去）
console.log('→ ③ 构建安装器宿主（release，载荷编译期内嵌）');
if ((await run(process.execPath, [TAURI_CLI, 'build'], path.join(ROOT, 'installer'))) !== 0) {
  console.error('✗ 安装器宿主构建失败');
  process.exit(1);
}
mustExist(INSTALLER_EXE, '安装器宿主构建产物不在（见上一步日志）');

// ④ 交付
// 🔴 不整目录删除：本机的安全删除垫会拦「批量删除目录」并直接抛错（实测），
//    这里只按文件名清掉旧件，再覆盖同名文件。
fs.mkdirSync(OUT, { recursive: true });

const stale = [...LEGACY, ...fs.readdirSync(OUT).filter((f) => /\.old\.exe$/i.test(f) || /-setup\.exe$/i.test(f))];
for (const name of new Set(stale)) {
  if (name === DELIVERABLE) continue;
  try {
    fs.rmSync(path.join(OUT, name), { force: true });
  } catch {
    console.warn(`⚠ ${name} 仍被占用（关掉那个窗口后可手动删）`);
  }
}

const locked = [];
if (await copyInto(INSTALLER_EXE, path.join(OUT, DELIVERABLE))) {
  const mb = (fs.statSync(INSTALLER_EXE).size / 1048576).toFixed(1);
  console.log(`✓ ${DELIVERABLE}（${mb} MB）`);
} else {
  console.warn(`⚠ ${DELIVERABLE} 正在运行，跳过复制`);
  locked.push(DELIVERABLE);
}

console.log(`\n套件在 ${path.relative(ROOT, OUT)}`);
console.log(`用法：把 ${DELIVERABLE} 单独交给用户，双击即装（管理员授权一次）。`);

if (locked.length) {
  console.error(`\n✗ 有 ${locked.length} 个文件没更新（${locked.join('、')}）：`);
  console.error('  它们正被运行中的窗口占用 —— 关掉安装器窗口后重跑本命令。');
  process.exitCode = 1;
}
