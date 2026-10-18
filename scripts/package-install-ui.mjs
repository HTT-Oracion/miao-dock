#!/usr/bin/env node
/**
 * 组装"安装器套件" —— 本地分发件，不写进版本库。
 *
 * 产物（默认 `.tmp/install-kit/`）：
 *   miao-installer.exe     安装向导（与 `*-setup.exe` **同目录**运行）
 *   miao-uninstaller.exe   卸载器（安装成功后由安装器复制到 `%LOCALAPPDATA%\喵坞卸载器\`）
 *   <name>-setup.exe       主应用安装包（由 `npm run app:build` 产出；缺了只提示、不算失败）
 *
 * ## 🔴 必须走 Tauri CLI，不能直接 `cargo build`
 * 实测（2026-10-18）：`cargo build --release` 出来的 exe 只有 7.5 MB，**没内嵌前端**，
 * 起来会去连 `http://localhost:1444`（dev 模式）⇒ 没有 dev 服务就是一片空白。
 * 只有 `tauri build`（本脚本调用的那条）才会把 `dist/` 打进 exe（安装器 46 MB，
 * 其中大头是随包字体）。debug 档同理需要 dev 服务，所以这套件**只做 release**。
 *
 * 为什么这三个文件必须凑在一起：
 *   · 安装器只认"与自己同目录的 `*-setup.exe`"，没有它就没有可装的东西；
 *   · 安装器自己不会把自己或卸载器装进安装目录（卸载时那两处会被跳过、留成孤儿）。
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
const OUT = path.join(ROOT, '.tmp', 'install-kit');

const APPS = [
  { dir: 'installer', exe: 'miao-installer.exe' },
  { dir: 'uninstaller', exe: 'miao-uninstaller.exe' },
];

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
 * 覆盖复制。目标可能正被**运行中的程序**占用（用户开着安装器/卸载器窗口看界面），
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

if (!fs.existsSync(TAURI_CLI)) {
  console.error(`✗ 没装 Tauri CLI：${path.relative(ROOT, TAURI_CLI)}\n先 npm install`);
  process.exit(1);
}

// ① 用 Tauri CLI 构建两个宿主（各自工程、各自 target；会把 dist 打进 exe）
for (const app of APPS) {
  const appDir = path.join(ROOT, app.dir);
  console.log(`→ 构建 ${app.dir} 宿主（release，前端内嵌）`);
  const code = await run(process.execPath, [TAURI_CLI, 'build'], appDir);
  if (code !== 0) {
    console.error(`✗ ${app.dir} 宿主构建失败`);
    process.exit(1);
  }
}

// ② 组装
// 🔴 不整目录删除：本机的安全删除垫会拦「批量删除目录」并直接抛错（实测），
//    而套件里就三个文件 —— 覆盖同名文件即可，旧版本安装包单独按文件清掉。
fs.mkdirSync(OUT, { recursive: true });

// 清掉上一次"运行中改名"留下的 `*.old.exe`（当时删不掉，现在多半可以了；删不掉就跳过）
for (const stale of fs.readdirSync(OUT).filter((f) => /\.old\.exe$/i.test(f))) {
  try {
    fs.rmSync(path.join(OUT, stale), { force: true });
  } catch {
    console.warn(`⚠ ${stale} 仍被占用（关掉那个窗口后可手动删）`);
  }
}

const locked = [];
for (const app of APPS) {
  const from = path.join(ROOT, app.dir, 'src-tauri', 'target', 'release', app.exe);
  if (!fs.existsSync(from)) {
    console.error(`✗ 构建产物不在：${path.relative(ROOT, from)}`);
    process.exit(1);
  }
  if (!(await copyInto(from, path.join(OUT, app.exe)))) {
    // 不中断其余文件的组装：另一个程序往往是好的，能更新一个是一个
    console.warn(`⚠ ${app.exe} 正在运行，跳过复制`);
    locked.push(app.exe);
    continue;
  }
  const mb = (fs.statSync(from).size / 1048576).toFixed(1);
  console.log(`✓ ${app.exe}（${mb} MB）`);
}

// ③ 主应用安装包（`npm run app:build` 的产物）
const nsisDir = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const setup = fs.existsSync(nsisDir)
  ? fs
      .readdirSync(nsisDir)
      .filter((f) => /-setup\.exe$/i.test(f))
      .sort()
      .at(-1)
  : undefined;
// 清掉上一个版本留下的安装包（同一次组装只应留一份，否则安装器按名字排序会挑到旧的）
for (const stale of fs.readdirSync(OUT).filter((f) => /-setup\.exe$/i.test(f))) {
  if (stale === setup) continue;
  try {
    fs.rmSync(path.join(OUT, stale), { force: true });
  } catch {
    console.warn(`⚠ 旧安装包删不掉，请手动清理：${stale}`);
  }
}
if (setup) {
  fs.copyFileSync(path.join(nsisDir, setup), path.join(OUT, setup));
  console.log(`✓ ${setup}`);
} else {
  console.warn(
    '⚠ 没找到主应用安装包（src-tauri/target/release/bundle/nsis/*-setup.exe）——\n' +
      '  套件里缺它时，安装器会报"没找到安装包"。先跑 `npm run app:build` 再重新组装。',
  );
}

console.log(`\n套件在 ${path.relative(ROOT, OUT)}`);
console.log('用法：把整个目录交给用户，双击 miao-installer.exe（它会在同目录找 *-setup.exe）。');

if (locked.length) {
  console.error(`\n✗ 有 ${locked.length} 个文件没更新（${locked.join('、')}）：`);
  console.error('  它们正被运行中的窗口占用 —— 关掉安装器 / 卸载器窗口后重跑本命令。');
  process.exitCode = 1;
}
