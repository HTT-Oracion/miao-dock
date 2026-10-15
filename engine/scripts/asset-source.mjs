/**
 * asset-source.mjs —— **资产来源的唯一收口**（G2 · 裁定 ⑤「托管只用方案 A」）。
 *
 * ## 为什么要有这个文件
 * 裁定 ⑤ 之前，同一件事（"这个归档从哪下"）在**五处**各写了一遍：
 *   ① `engine/VERSIONS.lock` §1/§2 的 commit 与 url（人读的锁）
 *   ② `engine/scripts/setup-engine.mjs` 的 `PY_URL` / `SRC_URL`
 *   ③ `engine/scripts/install-engine-deps.mjs` 的 `mirrorUrls()`（ghfast 硬编码）
 *   ④ 同一文件里的 `PYPI` 常量（清华镜像硬编码）
 *   ⑤ 换源只能靠 `MIAO_PY_URL` / `MIAO_SRC_URL` 两个**互不相干**的环境变量
 * ⇒ 加一条资产要改五个地方，漏一处就是"清单说的和实际下的不是一个东西"。
 *
 * 现在的事实源只有一处：`engine/runtime.manifest.json`（字段与 `models.manifest.json` 同构）。
 * 本模块负责：读清单、按平台选条目、拼通道前缀、镜像回退、校验 sha256。
 *
 * ## 通道语义（与 Rust 侧 `paths::asset_base()` **逐字一致**）
 *   · `MIAO_ASSET_BASE` **留空** ⇒ 用清单里的 `url`（= 今天的行为，逐字节等价）
 *   · `MIAO_ASSET_BASE` = http(s) 前缀 ⇒ 换成 `<前缀>/<url 的最后一段>`
 *   · `MIAO_ASSET_BASE` 格式非法 ⇒ **抛错**（不静默回落）：静默回落的表现是
 *     "以为配好了、实际流量全跑公网"，内网用户根本看不出来。
 *
 * ## 为什么不做"必须有前缀"
 * A 方案就是零自建：默认全部走公网现成源。强制前缀等于逼每个用户都先建一个通道。
 * 对象存储（方案 C）将来开放时接的就是这一个变量，代码与清单都不用动。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（从本文件位置推导 ⇒ 与 cwd 无关）。 */
export const ROOT = path.resolve(HERE, '..', '..');

/** 运行时清单（`MIAO_RUNTIME_MANIFEST` 是验收夹具接缝，与 Rust 侧同名同义）。 */
export const RUNTIME_MANIFEST =
  process.env.MIAO_RUNTIME_MANIFEST || path.join(ROOT, 'engine', 'runtime.manifest.json');

/** PyPI 索引（收口原 `install-engine-deps.mjs` 里硬编码的清华镜像）。 */
export const PYPI_INDEX = process.env.MIAO_PY_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple';

// ------------------------------------------------------------------ 通道前缀

/**
 * 生效的通道前缀。
 * @returns {string|null} `null` = 没配（正常，走清单默认 url）
 * @throws 配了但不是 http(s) 前缀 —— 配置错误必须当场说清，不能静默回落。
 */
export function assetBase() {
  const raw = (process.env.MIAO_ASSET_BASE || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      `MIAO_ASSET_BASE 必须是 http(s) 前缀（不带 scheme 的值在不同平台上语义不同，拼出来的 URL 验不了），收到「${raw}」`,
    );
  }
  return raw.replace(/\/+$/, '');
}

/** 清单 url → 生效 url（有前缀就换源，没有就原样）。 */
export function resolveUrl(manifestUrl) {
  const base = assetBase();
  if (!base) return manifestUrl;
  const name = manifestUrl.slice(manifestUrl.lastIndexOf('/') + 1);
  return `${base}/${name}`;
}

// ------------------------------------------------------------------ 清单

let cached = null;

/** 读运行时清单（进程内缓存一次；测试可用 `clearManifestCache()` 重置）。 */
export function readRuntimeManifest() {
  if (cached) return cached;
  const m = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'));
  if (!m || !Array.isArray(m.files) || m.files.length === 0) {
    throw new Error(`运行时清单格式不对（files 为空）：${RUNTIME_MANIFEST}`);
  }
  cached = m;
  return m;
}

export function clearManifestCache() {
  cached = null;
}

/**
 * 取一条资产（按 `id`）。
 * @throws 找不到 ⇒ 报出**清单里有哪几条**，否则调用方只能看到一句"缺 xxx"，
 *   而多平台条目时真正的原因往往是"这条只对 mac 生效"。
 */
export function runtimeAsset(id) {
  const m = readRuntimeManifest();
  const hit = m.files.find((f) => f.id === id);
  if (hit) return hit;
  throw new Error(`运行时清单里没有 ${id}；现有条目：${m.files.map((f) => f.id).join('、')}`);
}

/**
 * 取一条**适用于本平台**的资产：优先精确匹配 `platform`，其次取无 `platform` 的通用条目。
 *
 * 🔴 与 Rust 侧 `model_store::platform_matches` 同语义（不区分大小写）。
 * 两边必须给出同一个答案 —— 检测说"这条适用"、下载说"那条适用"是最难查的一类分叉。
 */
export function runtimeAssetForPlatform(set, plat = process.platform, arch = process.arch) {
  const key = platformKey(plat, arch);
  const m = readRuntimeManifest();
  const inSet = m.files.filter((f) => f.set === set);
  const exact = inSet.find((f) => String(f.platform || '').toLowerCase() === key);
  if (exact) return exact;
  const any = inSet.find((f) => !f.platform);
  if (any) return any;
  throw new Error(
    `运行时清单里没有适用于 ${key} 的 ${set} 条目；现有：${inSet.map((f) => `${f.id}(${f.platform ?? '通用'})`).join('、')}`,
  );
}

/** 平台键（与 `models.manifest.json` 的 `platform` 字段同一口径）。 */
export function platformKey(plat = process.platform, arch = process.arch) {
  if (plat === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (plat === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

// ------------------------------------------------------------------ 镜像回退

/**
 * 带镜像回退的下载顺序（收口原两处 `mirrorUrls()` 的硬编码规则）。
 *
 * 顺序：**通道前缀 → 清单原 url → ghfast 前缀 → gh-proxy 前缀**。
 * 前缀存在时不再混入公网源（配了通道就是要走通道，混进去等于把内网流量漏到公网）。
 *
 * 🔴 匹配范围含 `codeload.github.com`：原实现只匹配 `github.com`，而**引擎源码归档正是从
 * codeload 下的** ⇒ "有镜像回退"这件事在两个文件里各写了一半，漏的正好是最常失败的那个源。
 *
 * ⚠️ **2026-10-16 实测（D-217）：ghfast 不代理 codeload** —— `ghfast.top/https://codeload.github.com/…`
 *    一律 403（gh-proxy 同形态则 200）。所以对 codeload 那条 url 而言，`ghfast` 这条回退是**废的**；
 *    能兜住的只有"原 url 优先"（本函数返回的第一个就是它）与 gh-proxy。
 *    ⇒ 别把镜像当主力：真正的兜底是**原 url**，以及产品侧"`sources` 不许挤掉原 url"（`sourceCandidates`）。
 *    给 codeload 造一条真能用的镜像要换成 `github.com/<owner>/<repo>/archive/<commit>.tar.gz` 形态，
 *    那是 URL 变换（release 资产与归档形态不同），本轮刻意不做 —— 代价只是废镜像白试 4 次，
 *    而"装不成"这个后果已经由原 url 优先消除了。
 */
export function mirrorUrls(manifestUrl) {
  const base = assetBase();
  if (base) return [resolveUrl(manifestUrl)];
  const list = [manifestUrl];
  if (/^https:\/\/(github\.com|codeload\.github\.com)\//.test(manifestUrl)) {
    list.push(`https://ghfast.top/${manifestUrl}`);
    list.push(`https://gh-proxy.com/${manifestUrl}`);
  }
  return list;
}

// ------------------------------------------------------------------ 校验

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 校验归档的 sha256。
 *
 * 🔴 `engine_source` 有**性质上的例外**（清单 note 里写明了）：它走 codeload 的按需打包，
 * 字节会随上游重新打包而变（内容不变、gzip 变了）⇒ 不符时**不能**报"被篡改"，
 * 要报"上游重新打包了"并给处置（`MIAO_ASSET_BASE` 指向自备归档 / 改用 release zip）。
 * 报错了方向，用户会去查错的东西 —— 这比报错本身更贵。
 */
export function verifyArchive(file, expected, id) {
  if (!expected) return { ok: true, skipped: true };
  const got = sha256File(file);
  if (got === expected) return { ok: true, got };
  const volatileEntry = /source/i.test(id || '');
  const e = new Error(
    volatileEntry
      ? `${id}：归档字节与清单实测值不符（${got.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…）。` +
        '这一条来自 codeload 的按需打包归档，**内容相同但字节会变**，通常不是被篡改。' +
        '处置：用 MIAO_ASSET_BASE 指向一份固定归档，或改用上游的 release/commit zip。'
      : `${id}：sha256 不符（${got.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…）—— 已装的东西不可信，请重下。`,
  );
  e.code = volatileEntry ? 'RUNTIME_SOURCE_TARBALL_CHANGED' : 'RUNTIME_SHA256_MISMATCH';
  throw e;
}
