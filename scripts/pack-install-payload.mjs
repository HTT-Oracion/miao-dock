#!/usr/bin/env node
/**
 * 打安装器载荷 —— 把「主程序 exe + 主程序资源 + 卸载器 exe」压成 `payload.zip`，
 * 交给 `installer/src-tauri` 用 `include_bytes!` **编译期**嵌进安装器 exe。
 *
 * 产物：`installer/src-tauri/payload/payload.zip`（构建期产物，已 gitignore）
 *
 * ## 载荷布局 = 安装目录布局（一条硬约束）
 * zip 里的相对路径**就是**装完之后在安装目录里的相对路径：
 *   `miao-dock.exe`                 ← 主程序
 *   `engine/models.manifest.json`   ← Tauri `bundle.resources` 的落点
 *   `MiaoDock-Uninstaller.exe`      ← 卸载器
 * 所以不许再套一层 `app/` 前缀 —— 主程序必须和资源同层，产品侧就是这么找资源的。
 *
 * ## 输入从哪来
 *   · 主程序 exe：`src-tauri/target/release/miao-dock.exe`（`npm run app:build` 的产物）
 *   · 资源清单：`src-tauri/tauri.conf.json` 的 `bundle.resources`（键相对 `src-tauri/`，值即落点）
 *   · 卸载器 exe：`uninstaller/src-tauri/target/release/miaodock-uninstaller.exe`
 * 缺任何一个都**报错并点名**，不静默跳过 —— 载荷缺件装出来就是坏程序。
 *
 * ## 为什么自己写 zip
 * Node 内置没有 zip 打包器，而这里只需要「存储 / deflate + 中央目录」这一小块；
 * 引一个 npm 依赖来做这件事，代价（体积、供应链面）大于收益。
 * 目录项一个都不写：解包侧按文件路径按需建目录。
 *
 * 用法：node scripts/pack-install-payload.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const APP_EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'miao-dock.exe');
/**
 * 服务本体 `mangasvc.exe` —— **必须随包**。
 *
 * 🔴 主程序启动时按「与自身**同目录**」找它（`service/mod.rs::resolve_mangasvc()`），
 *    漏了它的表现不是"服务起不来"，而是**一启动就报「找不到 mangasvc.exe」**
 *    （2026-10-18 用户实测：单文件安装器第一版漏了它，装完点开就报这个）。
 * 🔴 它与 `miao-dock.exe` 同属同一个 crate 的第二个 bin，不在 `bundle.resources` 里 ——
 *    所以"照抄 resources 清单"永远漏它，必须在这里显式列一条。
 */
const SERVICE_EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'mangasvc.exe');
/**
 * 动漫服务 `animesvc.exe` —— 同样**必须随包**（D-242）。
 *
 * 本轮桌面壳还不拉起它（壳层仍只跟踪 ①），但它是独立 exe：产品后续接动漫时
 * 按"与主程序同目录"寻址，装完再补就等于让用户重装一次。
 */
const ANIME_SERVICE_EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'animesvc.exe');
const UNINSTALLER_EXE = path.join(ROOT, 'uninstaller', 'src-tauri', 'target', 'release', 'miaodock-uninstaller.exe');
const PAYLOAD_DIR = path.join(ROOT, 'installer', 'src-tauri', 'payload');
const PAYLOAD_ZIP = path.join(PAYLOAD_DIR, 'payload.zip');

/** 卸载器装进安装目录后的文件名（`manifest.json` 与卸载项都按它找） */
const UNINSTALLER_NAME = 'MiaoDock-Uninstaller.exe';
const PUBLISHER = '喵坞';
const SCHEMA = 1;

// ------------------------------------------------------------------ zip 写入

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 写一个 zip：`entries` 是 `{ name, data }`（name 用 `/` 分隔、相对路径）。
 * 能压就压（deflate），压不小就存储 —— 已压缩的 exe 常常压不动。
 */
function writeZip(target, entries) {
  const chases = [];
  const central = [];
  let offset = 0;
  // 固定 1980-01-01：同输入产出同字节，便于比对"是不是同一份载荷"
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const DOS_TIME = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chases.push(local, name, payload);
    central.push({ name, crc, method, csize: payload.length, usize: entry.data.length, offset });
    offset += local.length + name.length + payload.length;
  }

  const centralChunks = [];
  let centralSize = 0;
  for (const item of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0, 8); // flags
    head.writeUInt16LE(item.method, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(item.crc, 16);
    head.writeUInt32LE(item.csize, 20);
    head.writeUInt32LE(item.usize, 24);
    head.writeUInt16LE(item.name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk
    head.writeUInt16LE(0, 36); // internal attrs
    head.writeUInt32LE(0, 38); // external attrs
    head.writeUInt32LE(item.offset, 42);
    centralChunks.push(head, item.name);
    centralSize += head.length + item.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([...chases, ...centralChunks, end]));
}

// ------------------------------------------------------------------ 收集输入

/** 相对仓库根的可读路径（报错用；绝对路径对人不友好） */
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

function readText(file) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺文件：${rel(file)}`);
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8');
}

function mustExist(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺构建产物：${rel(file)}\n  ${hint}`);
    process.exit(1);
  }
  return fs.readFileSync(file);
}

const conf = JSON.parse(readText(TAURI_CONF));
const resources = conf.bundle?.resources ?? {};
if (typeof resources !== 'object' || Array.isArray(resources)) {
  console.error('✗ tauri.conf.json 的 bundle.resources 必须是从源文件到落点的映射');
  process.exit(1);
}

const entries = [];
const appResources = [];

const appData = mustExist(APP_EXE, '先跑 `npm run app:build` 产出主程序 exe');
entries.push({ name: 'miao-dock.exe', data: appData });

// 服务本体：与主程序同目录（`resolve_mangasvc()` 的判据），不属于 `bundle.resources`
const serviceData = mustExist(SERVICE_EXE, '先跑 `npm run app:build` 产出 mangasvc.exe');
entries.push({ name: 'mangasvc.exe', data: serviceData });
appResources.push('mangasvc.exe');

// 动漫服务：同一 crate 的第三个 bin，同样不在 `bundle.resources` 里
const animeServiceData = mustExist(ANIME_SERVICE_EXE, '先跑 `npm run app:build` 产出 animesvc.exe');
entries.push({ name: 'animesvc.exe', data: animeServiceData });
appResources.push('animesvc.exe');

for (const [from, to] of Object.entries(resources)) {
  const source = path.resolve(ROOT, 'src-tauri', from);
  const name = String(to).replaceAll('\\', '/');
  entries.push({ name, data: mustExist(source, '资源由 `npm run app:build` 一并准备') });
  appResources.push(name);
}

const uninstallerData = mustExist(UNINSTALLER_EXE, '先在 uninstaller/ 里 `npm run tauri -- build` 产出卸载器 exe');
entries.push({ name: UNINSTALLER_NAME, data: uninstallerData });

const manifest = {
  schema: SCHEMA,
  version: String(conf.version),
  appExe: 'miao-dock.exe',
  appResources,
  uninstallerExe: UNINSTALLER_NAME,
  publisher: PUBLISHER,
};

// manifest 放最前：解包侧读它只要碰第一个条目，不必扫全表
writeZip(PAYLOAD_ZIP, [
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
  ...entries,
]);

const mb = (n) => (n / 1048576).toFixed(1);
const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
const size = fs.statSync(PAYLOAD_ZIP).size;
console.log(`✓ 载荷 ${entries.length + 1} 个条目，原始 ${mb(total)} MB → 压缩 ${mb(size)} MB`);
console.log(`✓ ${rel(PAYLOAD_ZIP)}（版本 ${manifest.version}）`);
console.log('下一步：在 installer/ 里 `npm run tauri -- build`，载荷会在编译期嵌进安装器 exe');
