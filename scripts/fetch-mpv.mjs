#!/usr/bin/env node
/**
 * 内核轨的 mpv 二进制获取器（开发 / 打包前用，**不是运行期**）。
 * =============================================================================
 * 为什么单独一条：mpv 是 ~115 MB 的第三方可执行，**不入库**（.gitignore 里
 * `src-tauri/resources/mpv/`）。用户机要么随包、要么首启下载；开发机则跑这条把
 * 二进制放到 `locate_mpv()` 找得到的位置：`src-tauri/resources/mpv/<平台>/`。
 *
 * 用法：
 *   npm run task -- fetch:mpv              # 下载 + 解包到 resources/mpv/<平台>/
 *   npm run task -- fetch:mpv --check      # 只在位检查（缺则非零退出并点名）
 *   npm run task -- fetch:mpv --print-url  # 只打印会去下哪个地址（零网络）
 *
 * 🔴 镜像：官方 release 直连在本机被挡（`curl: (52) Empty reply`），所以按
 *    「直连 → ghfast.top → gh-proxy.com」顺序试；镜像只用于**开发期取二进制**，
 *    不进产品、不写进任何运行期路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '..');
const WIN = process.platform === 'win32';

/** 固定的 mpv 构建（换版本要同时改 `VERSION` 与两个 URL 片段，属人工动作）。 */
const MPV = {
  tag: '20261020',
  file: 'mpv-x86_64-20261020-git-6a262d11f6.7z',
  size: 34_014_613,
};

/** 平台目录名：与 `animesvc/kernel/mpv.rs::platform_tag()` 逐字一致。 */
function platformTag() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin') return 'darwin-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

const MIRRORS = [
  'https://github.com',
  'https://ghfast.top/https://github.com',
  'https://gh-proxy.com/https://github.com',
];

const releaseUrl = (base) => `${base}/shinchiro/mpv-winbuild-cmake/releases/download/${MPV.tag}/${MPV.file}`;
const SEVEN_ZIP = { tag: '25.01', file: '7zr.exe' };
const sevenZipUrl = (base) => `${base}/ip7z/7zip/releases/download/${SEVEN_ZIP.tag}/${SEVEN_ZIP.file}`;

const DEST_DIR = path.join(REPO, 'src-tauri', 'resources', 'mpv', platformTag());
const EXE = WIN ? 'mpv.exe' : 'mpv';
const DEST_EXE = path.join(DEST_DIR, EXE);
const TMP = path.join(REPO, '.tmp', 'mpv');

const say = (msg) => console.log(`[fetch-mpv] ${msg}`);

function printUrl() {
  for (const base of MIRRORS) say(releaseUrl(base));
}

function check() {
  const exists = fs.existsSync(DEST_EXE);
  if (exists) {
    const size = fs.statSync(DEST_EXE).size;
    say(`在位：${DEST_EXE}（${(size / 1024 / 1024).toFixed(1)} MB）`);
    return 0;
  }
  say(`缺：${DEST_EXE}`);
  say('跑 `npm run task -- fetch:mpv` 获取，或把 mpv 放到该路径 / 用 MIAO_MPV_BIN 指过去');
  return 1;
}

/** 依次试镜像，第一个成功的留下。`dest` 是落盘路径。 */
function download(urls, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const url of urls) {
    say(`下载 ${url}`);
    const r = spawnSync(WIN ? 'curl.exe' : 'curl', ['-sL', '--max-time', '600', '-o', dest, url], {
      stdio: 'inherit',
    });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      say(`完成：${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB`);
      return true;
    }
    say('这个镜像不行，换下一个');
  }
  return false;
}

/** 解包：优先用 7zr（7z 的 LZMA 在 Windows 自带 bsdtar 上不支持）。 */
function extract(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const sevenZip = path.join(TMP, SEVEN_ZIP.file);
  if (!fs.existsSync(sevenZip)) {
    if (!download(MIRRORS.map(sevenZipUrl), sevenZip)) {
      throw new Error('拿不到 7zr.exe（解包 7z 需要它）');
    }
  }
  const r = spawnSync(sevenZip, ['x', archive, `-o${outDir}`, '-y'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`解包失败（7zr 退出 ${r.status}）`);
}

function fetchMpv() {
  fs.mkdirSync(TMP, { recursive: true });
  const archive = path.join(TMP, MPV.file);
  if (!fs.existsSync(archive) || fs.statSync(archive).size < MPV.size * 0.9) {
    if (!download(MIRRORS.map(releaseUrl), archive)) {
      throw new Error('所有镜像都失败：这台机器的网络到不了 GitHub release');
    }
  }
  const out = path.join(TMP, 'unpacked');
  extract(archive, out);
  fs.mkdirSync(DEST_DIR, { recursive: true });
  const files = WIN ? ['mpv.exe', 'mpv.com'] : ['mpv'];
  for (const f of files) {
    const src = path.join(out, f);
    if (!fs.existsSync(src)) {
      say(`⚠ 归档里没有 ${f}（跳过）`);
      continue;
    }
    fs.copyFileSync(src, path.join(DEST_DIR, f));
  }
  const ok = fs.existsSync(DEST_EXE);
  say(ok ? `就位：${DEST_EXE}` : '失败：解包后仍找不到可执行文件');
  return ok ? 0 : 1;
}

if (process.argv.includes('--print-url')) {
  printUrl();
} else if (process.argv.includes('--check')) {
  process.exitCode = check();
} else {
  process.exitCode = fetchMpv();
}
