#!/usr/bin/env node
/**
 * 为引擎 venv 安装 requirements.txt（Windows 适配版）。
 *
 * 三个必须绕开的坑：
 *   1. `pydensecrf` 在 PyPI 上**没有 Windows wheel**（只有 sdist + GitHub 直链），
 *      必须用本机 MSVC（Visual Studio 2022 生成工具）从源码编译。
 *   2. pip 是「先全部收集、最后统一安装」的事务：只要 pydensecrf 编译失败，
 *      整批 50+ 依赖会一起回滚 ⇒ 全白装。所以必须**拆两批**：
 *        批 A：除 pydensecrf 外的全部依赖（纯 wheel，秒装）
 *        批 B：单独用 --no-build-isolation 编译 pydensecrf
 *   3. 本环境 sandbox **拦截 reg.exe**，而 `vcvars64.bat` 依赖 reg.exe 去查注册表
 *      定位 Windows SDK ⇒ 直接 call 它会得到一份**缺 ucrt/um 头目录的残缺 INCLUDE**。
 *      故这里**不用 vcvars**，改为手动拼 INCLUDE/LIB/PATH，并设 DISTUTILS_USE_SDK=1，
 *      让 setuptools/distutils 跳过调用 vcvarsall、直接吃我们给的环境。
 *
 * 用法：
 *   node engine/scripts/install-engine-deps.mjs            # 两步都跑
 *   node engine/scripts/install-engine-deps.mjs --main     # 只跑批 A
 *   node engine/scripts/install-engine-deps.mjs --crf      # 只跑批 B
 *   node engine/scripts/install-engine-deps.mjs --print-env # 只打印探测到的 MSVC/SDK 环境（不装）
 *
 * 环境变量：
 *   MIAO_VC_ROOT    MSVC 工具集根（默认按候选表探测，见 msvcVcRoots()）
 *   MIAO_SDK_ROOT   Windows SDK 根（默认 `C:/Program Files (x86)/Windows Kits/10`）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runtimesDir } from './runtime-root.mjs';

// G2：资产来源的唯一收口（url 前缀 / 镜像回退 / PyPI 索引）—— 与 setup-engine.mjs、清单同源。
import { PYPI_INDEX, mirrorUrls as assetMirrorUrls } from './asset-source.mjs';

/** 本脚本所在目录 —— B4 的 wheel 清单按它推出**入库**的那一份（与 cwd 无关）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 取证接缝 + **平台闸门**（D7 验收②）。
 *
 * 本脚本是**Windows 专用**：pydensecrf 走 MSVC 现场编译、INCLUDE/LIB 手工拼
 * （见文件头三条坑）。macOS 上跑它的结局是几十分钟后一句 `ENOENT python.exe` ——
 * 那个报错指向"我没找到解释器"，而真正的原因是"这个平台压根不该跑这个脚本"。
 * 所以在**任何 fs / spawn 之前**就拒绝，并把正确做法（手动 pip）说出来。
 *
 * `MIAO_PLATFORM` 是**取证专用**接缝（与 Rust `model_store::platform_key` 同一个键）：
 * 跨平台真机只有一台，"非 Windows 时拒绝"这支分支在 Windows 上跑不到 ⇒ 有了它，
 * 这条拒绝逻辑能在**任何**平台被真实执行到（`MIAO_PLATFORM=darwin-arm64`）。
 * 产品路径不得设置它。
 */
const PLATFORM = ((process.env.MIAO_PLATFORM || '').trim() || process.platform).toLowerCase();

/**
 * **只读模式不受平台闸门限制**：它们只读清单 / 算哈希、打印一行结论，不装任何东西、
 * 不碰 venv、不联网、**不需要编译器**。
 *
 * 🔴 macOS 用户同样需要这两个（"有没有本平台的预编译 wheel" / "这颗 whl 的哈希与条目长什么样"）
 *    —— 而这台机器上跑不到那些分支，只能靠这个旁路 + `MIAO_PLATFORM` 接缝把它验出来
 *    （见 `pydensecrf-wheel-check` 的 WB.W9 / WB.W11）。
 * ⚠️ `--build-wheel` **不在此列**：它要 MSVC 的环境探测，在非 Windows 上必须被拒（那就是闸门的本意）。
 */
const READONLY_MODES = ['--print-plan', '--wheel-entry'];
const ONLY_READONLY = process.argv.slice(2).some((a) => READONLY_MODES.includes(a));
if (!PLATFORM.startsWith('win32') && !ONLY_READONLY) {
  console.error(
    `✗ [PLATFORM_UNSUPPORTED] install-engine-deps.mjs 仅支持 Windows（当前平台 ${PLATFORM}）。\n` +
      '  macOS 请按 docs/install-guide-macos.md 手动装依赖（pip -r requirements.txt + pydensecrf 兼容补丁），\n' +
      '  不要调用本脚本：它按 MSVC 的 INCLUDE/LIB 现场编译 pydensecrf，在 macOS 上必然失败。',
  );
  process.exit(2);
}

// 🔴 B1：落点与产品同源（`<appData>/runtimes/manga-translator`），不再锚仓库根。
const RT = process.env.MIAO_MODEL_ROOT || runtimesDir();
const VENV_PY = path.join(RT, 'venv', 'Scripts', 'python.exe');
const SRC = path.join(RT, 'src');
const REQ = path.join(SRC, 'requirements.txt');
// G2：PyPI 索引地址收口到 asset-source.mjs（可用 `MIAO_PY_INDEX` 覆盖；换源不再改代码）
const PYPI = PYPI_INDEX;

const CRF_RE = /^pydensecrf\s*@\s*(\S+)/im;

function log(...a) {
  console.log('[deps]', ...a);
}

/** 取目录下「版本号最大」的子目录名。 */
function newestDir(parent) {
  try {
    const vers = fs.readdirSync(parent).filter((n) => /^\d/.test(n));
    if (!vers.length) return null;
    vers.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return vers[vers.length - 1];
  } catch {
    return null;
  }
}

/** MSVC 工具集（`…/VC/Tools/MSVC`）根的候选表 —— VS 安装路径不固定，逐个探测第一个存在的。 */
function msvcVcRoots() {
  return [
    process.env.MIAO_VC_ROOT,
    'C:/VS2022BT/VC/Tools/MSVC', // 本机实测落点（非默认路径）
    'C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC', // 官方默认：生成工具
    'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC',
    'C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC',
    'C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/MSVC',
    'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC',
  ].filter(Boolean);
}

function msvcSdkRoot() {
  return process.env.MIAO_SDK_ROOT || 'C:/Program Files (x86)/Windows Kits/10';
}

/** 手动拼 MSVC + Windows SDK 的 INCLUDE/LIB/PATH（不依赖 vcvars/reg.exe）。 */
function msvcEnv() {
  const KITS = msvcSdkRoot();

  let VC_ROOT = null;
  let msvcVer = null;
  for (const r of msvcVcRoots()) {
    const v = newestDir(r);
    if (v) {
      VC_ROOT = r;
      msvcVer = v;
      break;
    }
  }
  if (!VC_ROOT) {
    throw new Error(
      `找不到 MSVC 工具集（候选：${msvcVcRoots().join(' | ')}；可用 MIAO_VC_ROOT 指向你的 VC/Tools/MSVC）`,
    );
  }
  const sdkVer = newestDir(path.join(KITS, 'Include'));
  if (!sdkVer) throw new Error(`找不到 Windows SDK Include：${KITS}/Include（可用 MIAO_SDK_ROOT 覆盖）`);

  const msvcBase = `${VC_ROOT}/${msvcVer}`;
  const incBase = `${KITS}/Include/${sdkVer}`;
  const libBase = `${KITS}/Lib/${sdkVer}`;
  const msvcBin = `${msvcBase}/bin/Hostx64/x64`;
  // 🔴 `rc.exe`（资源编译器）在 **Windows SDK 的 bin/x64**，不在 MSVC 目录。
  //    链接阶段（link.exe /MANIFEST）要调它，漏了会得到 `LNK1158: 无法运行"rc.exe"`，
  //    而报错发生在 link 一步、离"PATH 缺了个 SDK bin"这个根因很远。
  const sdkBin = `${KITS}/bin/${sdkVer}/x64`;
  // `<VS>/VC/Auxiliary/VS/include` —— 由 `<VS>/VC/Tools/MSVC/<ver>` 上跳三级得到 `<VS>/VC`。
  const auxInclude = path.resolve(msvcBase, '..', '..', '..', 'Auxiliary', 'VS', 'include').replace(/\\/g, '/');

  const INCLUDE = [
    `${msvcBase}/include`,
    `${incBase}/ucrt`,
    `${incBase}/shared`,
    `${incBase}/um`,
    `${incBase}/winrt`,
    `${incBase}/cppwinrt`,
    auxInclude,
  ].join(';');
  const LIB = [`${msvcBase}/lib/x64`, `${libBase}/ucrt/x64`, `${libBase}/um/x64`].join(';');

  log(`MSVC ${msvcVer} · SDK ${sdkVer}`);
  log(`  VC 根：${VC_ROOT}`);
  return {
    ...process.env,
    INCLUDE,
    LIB,
    PATH: `${msvcBin};${sdkBin};${process.env.PATH || ''}`,
    DISTUTILS_USE_SDK: '1',
    MSSdk: '1',
  };
}

/** 直接在 MSVC 环境下 spawn python（不经 cmd，彻底避开引号/reg.exe）。 */
function runPip(env, pyArgs, label) {
  log(`▶ ${label}`);
  const r = spawnSync(VENV_PY, pyArgs, { stdio: 'inherit', cwd: SRC, env });
  return r.status ?? 1;
}

/**
 * pydensecrf API 兼容补丁（幂等）。
 *
 * 引擎的 requirements 指向 pydensecrf 的 **master 分支**（移动靶）。上游把旧的
 * **模块级常量**迁进了枚举：
 *   旧（引擎源码 text_mask_utils.py:84-90 用的）：`dcrf.DIAG_KERNEL` / `dcrf.NO_NORMALIZATION`
 *   新（master 实际导出）：`dcrf.KernelType.DIAG_KERNEL` / `dcrf.NormalizationType.NO_NORMALIZATION`
 * ⇒ 真机实测报 `AttributeError: module 'pydensecrf.densecrf' has no attribute 'DIAG_KERNEL'`。
 * 这里把枚举成员回填成模块级同名常量，让新旧两种写法都能用。写在 `__init__.py` 里，
 * 因为任何 `import pydensecrf.densecrf` 都会先跑它。
 */
function patchPydensecrfCompat() {
  const initPy = path.join(RT, 'venv', 'Lib', 'site-packages', 'pydensecrf', '__init__.py');
  if (!fs.existsSync(initPy)) {
    log('⚠ 找不到 pydensecrf/__init__.py，跳过兼容补丁');
    return;
  }
  const MARK = '# >>> miao-dock: pydensecrf 旧常量兼容补丁';
  const shim = [
    '',
    MARK,
    'from . import densecrf as _dcrf',
    'for _n in ("CONST_KERNEL", "DIAG_KERNEL", "FULL_KERNEL"):',
    '    if not hasattr(_dcrf, _n) and hasattr(_dcrf.KernelType, _n):',
    '        setattr(_dcrf, _n, getattr(_dcrf.KernelType, _n))',
    'for _n in ("NO_NORMALIZATION", "NORMALIZE_BEFORE", "NORMALIZE_AFTER", "NORMALIZE_SYMMETRIC"):',
    '    if not hasattr(_dcrf, _n) and hasattr(_dcrf.NormalizationType, _n):',
    '        setattr(_dcrf, _n, getattr(_dcrf.NormalizationType, _n))',
    '# <<< miao-dock: pydensecrf 旧常量兼容补丁',
    '',
  ].join('\n');
  const cur = fs.readFileSync(initPy, 'utf8');
  if (cur.includes(MARK)) {
    log('pydensecrf 兼容补丁已在');
    return;
  }
  fs.writeFileSync(initPy, cur + shim, 'utf8');
  log('已写入 pydensecrf 旧常量兼容补丁');
}

// ------------------------------------------------------------------ pydensecrf 预编译 wheel（B4）

/**
 * wheel 清单（B4）。`MIAO_WHEELS_MANIFEST` 是**验收夹具接缝**；产品路径永远用入库的那一份。
 *
 * 🔴 「清单里没有 ⇒ 源码编译」是这套设计的**前提**，不是降级：wheel 只是便利，
 *    不能让"清单空了"变成"装不上了"。
 */
const WHEELS_MANIFEST = process.env.MIAO_WHEELS_MANIFEST || path.resolve(HERE, '..', 'wheels.manifest.json');

/** wheel 落地目录（镜像通道下载到这里；与 sdist 缓存同源，都在 `runtimes/` 下、不入库）。 */
function wheelDir() {
  return process.env.MIAO_WHEEL_DIR || path.join(RT, '.download-cache', 'wheels');
}

/**
 * **随包分发**的 wheel 绝对路径（G3）—— `path` 相对 `engine/`（本文件在 `engine/scripts/`）。
 *
 * 🔴 为什么随包优先：打包后的用户机上既没有 `.download-cache`、也没有编译器，
 *    包内那一份是**唯一**能命中的来源。顺序反了会表现为「装得上但走的是源码编译」——
 *    症状是安装耗时几分钟且在没有 MSVC 的机器上直接失败，离"清单里明明有 wheel"极远。
 */
function bundledWheelPath(w) {
  if (!w || w.bundled !== true || typeof w.path !== 'string' || w.path.length === 0) return null;
  return path.resolve(HERE, '..', w.path);
}

/**
 * 与 `engine/models.manifest.json` 的 `platform` 字段同一口径（win32-x64 / darwin-arm64）。
 *
 * 🔴 `MIAO_PLATFORM` 是**取证专用**接缝，语义与 Rust `model_store::platform_key()` **逐字对齐**
 * （值原样透传、不改写）：两侧若各有一套"假平台"的写法，双靶对拍会在设了它的时候分叉，
 * 而那正是 R1 那类"两边都看起来在工作"的偏差。产品路径**不得**设置它。
 */
function platformKey() {
  const forced = (process.env.MIAO_PLATFORM || '').trim();
  if (forced) return forced;
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return a === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

/** 当前 venv 的 ABI tag（`engine/VERSIONS.lock` §2 钉的是 3.11.17）。 */
function pythonTag() {
  const m = /(\d+)\.(\d+)/.exec(process.env.MIAO_PY_VERSION || '3.11');
  return `cp${m ? m[1] + m[2] : '311'}`;
}

function readWheelsManifest() {
  try {
    const j = JSON.parse(fs.readFileSync(WHEELS_MANIFEST, 'utf8'));
    return { manifest: j, wheels: Array.isArray(j.wheels) ? j.wheels : [], error: null };
  } catch (e) {
    return { manifest: null, wheels: [], error: e.message };
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * 决定 pydensecrf 走哪条路。**纯函数式的决策**，供 `--print-plan` 与批 B 共用
 * —— 两处各判一次必然漂移（"打好计划却走了另一条路"是最难查的一类）。
 *
 * 返回 `{ route: 'wheel'|'source', reason, wheel?, abs?, from? }`。
 * 🔴 顺序即优先级：平台匹配 → 文件在位 → **sha256 对得上** → 才走 wheel。
 *    哈希对不上时必须退回源码编译（宁可慢，也不要装一个不是我们验过的东西）。
 * 🔴 文件来源也有优先级：**包内**（`bundled` + `path`，G3）> 本机通道目录。
 *    包内那一份是零编译器机器上唯一能命中的来源，顺序反了会静默退化成源码编译。
 */
function planCrf() {
  const { manifest, wheels, error } = readWheelsManifest();
  const key = platformKey();
  const tag = pythonTag();
  if (error)
    return { route: 'source', reason: `wheel 清单读不到（${String(error).slice(0, 60)}）⇒ 走源码编译`, key, tag };
  if (!Array.isArray(manifest.wheels) || manifest.wheels.length === 0) {
    return { route: 'source', reason: 'wheel 清单里还没有任何条目 ⇒ 走源码编译', key, tag };
  }
  const mine = wheels.filter((w) => w && w.platform === key && w.pythonTag === tag);
  if (mine.length === 0) {
    return { route: 'source', reason: `清单里没有本平台（${key} / ${tag}）的条目 ⇒ 走源码编译`, key, tag };
  }
  const w = mine[0];
  // 优先级：**包内**（G3）> 本机通道目录（`--build-wheel` / 镜像下载的落点）。
  const bundled = bundledWheelPath(w);
  const abs = bundled && fs.existsSync(bundled) ? bundled : path.join(wheelDir(), String(w.file || ''));
  if (!w.file || !fs.existsSync(abs)) {
    return { route: 'source', reason: `清单有本平台条目但 wheel 不在盘上（${abs}）⇒ 走源码编译`, key, tag, wheel: w };
  }
  if (!SHA256_RE.test(String(w.sha256 || ''))) {
    return {
      route: 'source',
      reason: `清单条目的 sha256 形态不对（不是 64 位十六进制）⇒ 拒绝使用，走源码编译`,
      key,
      tag,
      wheel: w,
    };
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (got !== w.sha256) {
    return {
      route: 'source',
      reason: `wheel 的 sha256 与清单不符（清单 ${String(w.sha256).slice(0, 12)}… / 实际 ${got.slice(0, 12)}…）⇒ 拒绝使用，走源码编译`,
      key,
      tag,
      wheel: w,
    };
  }
  const from = bundled && abs === bundled ? '包内' : '本机目录';
  return {
    route: 'wheel',
    reason: `命中清单条目 ${w.id || w.file}（平台 ${key} / ${tag}，来源 ${from}，sha256 已核对）`,
    key,
    tag,
    wheel: w,
    abs,
    from,
  };
}

/**
 * 把 sdist 抓到本地缓存（带镜像回退，绕开 pip 直连 github 的 502）。
 *
 * 缓存目录与 `setup-engine.mjs` 同源（`RT/.download-cache`）—— 它在 gitignore 的 `runtimes/` 下，不入库。
 * 抽出来是因为**两条路都要它**：源码编译（批 B 的回退）与 `--build-wheel`（B4 造 wheel）。
 * 两处各写一遍"先下再判大小"必然会漂移（一处判 1024、一处不判）。
 */
async function ensureCrfSdist(crfUrl) {
  const cacheDir = path.join(RT, '.download-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const crfZip = path.join(cacheDir, 'pydensecrf-master.zip');
  if (!fs.existsSync(crfZip) || fs.statSync(crfZip).size < 1024) {
    await download(crfUrl, crfZip);
  } else {
    log(`使用已缓存的 sdist：${crfZip}`);
  }
  return crfZip;
}

/**
 * 「给我一个 whl，我把**清单条目**打印出来」—— B4 的 `fillHowTo` 第②③步机器化。
 *
 * 🔴 为什么值得单做一个子命令：清单里那个 `sha256` **不允许凭记忆写**
 * （写一个假的比不写更坏：它会拦下真 wheel，或者更糟 —— 拦不住假的）。
 * 而"手工算 sha256 再抄进 JSON"这件事，抄错一位是**静默**的：条目光看着没问题，
 * 直到有人装的时候被 `planCrf` 拒绝，而那时人只会觉得"这个通道不好使"。
 * 所以宁可让它由**同一个脚本**算出来，并打印成可直接粘贴的条目。
 *
 * 秒级、**不需要编译器**（只是读文件 + 算哈希）⇒ 也能被 e2e 钉住。
 */
function wheelEntryOf(file) {
  const abs = path.resolve(file);
  const buf = fs.readFileSync(abs);
  return {
    id: `pydensecrf-${platformKey()}`,
    platform: platformKey(),
    pythonTag: pythonTag(),
    file: path.basename(abs),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.length,
    url: null,
    sources: [],
  };
}

/**
 * 源码编译 pydensecrf（B4 之后的**回退路线**，也是今天在用的那条）。
 *
 * 为什么留成独立函数：`--print-plan` 与批 B 都要"说得清走哪条路"，而回退这件事
 * 在两个地方发生（计划里没有 wheel / wheel 装失败）—— 收在一处才不会两边行为不同。
 */
async function buildFromSource(env, crfUrl) {
  const crfZip = await ensureCrfSdist(crfUrl);
  const code = runPip(env, ['-m', 'pip', 'install', '--no-build-isolation', crfZip], '批 B：编译 pydensecrf');
  if (code !== 0) {
    log('✗ pydensecrf 编译失败。排查：cython/numpy 是否已装、MSVC 组件是否完整、rc.exe 是否在 PATH。');
    log('  → 若不想装编译器，可改用预编译 wheel 通道：见 engine/wheels.manifest.json 的 fillHowTo。');
    throw new Error(`批 B 失败，exit=${code}`);
  }
  log('✓ 批 B 完成（源码编译）');
}

/**
 * 带镜像回退的 url 列表 —— **G2 起收口到 `asset-source.mjs`**（与 `setup-engine.mjs` 同一处）。
 *
 * 保留本函数作为薄壳而不是直接改调用点：调用点有多处，包一层比逐处改更不容易漏，
 * 而"规则只有一处"这件事仍然成立（规则在 asset-source 里）。
 */
function mirrorUrls(url) {
  return assetMirrorUrls(url);
}

/** 带镜像回退的下载（绕开 pip 直连 github 的脆弱性）。 */
async function download(url, dest) {
  let lastErr;
  for (const u of mirrorUrls(url)) {
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`响应过小(${buf.length}B)`);
      fs.writeFileSync(dest, buf);
      log(`  下载成功 ${(buf.length / 1048576).toFixed(1)}MB ← ${u.slice(0, 64)}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`  通道失败：${String(e.message).slice(0, 60)} ← ${u.slice(0, 64)}`);
    }
  }
  throw new Error(`所有通道都失败：${lastErr && lastErr.message}`);
}

async function main() {
  const args = process.argv.slice(2);

  // `--print-env`：只打印探测到的 MSVC/SDK 环境（排障 / 换机确认路径用），不碰 venv、不联网。
  if (args.includes('--print-env')) {
    const env = msvcEnv();
    log(`INCLUDE = ${env.INCLUDE}`);
    log(`LIB     = ${env.LIB}`);
    log(`PATH 前两段 = ${env.PATH.split(path.delimiter).slice(0, 2).join('  ;  ')}`);
    return 0;
  }

  /*
   * `--print-plan`：**只回答"pydensecrf 会走哪条路"**，不碰 venv、不联网、不需要编译器。
   *
   * 为什么要有它：wheel 通道是"有条件才走"的（清单里得真有本平台、且 sha256 对得上），
   * 而"到底走了哪条"此前只体现在几十行日志里。把它做成一个可被断言的出口，
   * 才谈得上"我验证过它会优先用 wheel" —— 否则只能靠读代码相信。
   * 🔴 与批 B **共用 `planCrf()`**：两处各判一次必然漂移。
   */
  if (args.includes('--print-plan')) {
    const plan = planCrf();
    console.log(
      JSON.stringify(
        {
          route: plan.route,
          reason: plan.reason,
          platform: plan.key,
          pythonTag: plan.tag,
          wheel: plan.wheel
            ? { id: plan.wheel.id ?? null, file: plan.wheel.file ?? null, sha256: plan.wheel.sha256 ?? null }
            : null,
          wheelAbs: plan.abs ?? null,
          manifest: WHEELS_MANIFEST,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  /*
   * `--wheel-entry <file.whl>`：只算 sha256/体积并打印**可粘贴的清单条目**（秒级、不需要编译器）。
   * 与 `--print-plan` 同理放在 venv 检查之前 —— 造清单条目这件事与"venv 装没装"无关。
   */
  if (args.includes('--wheel-entry')) {
    const i = args.indexOf('--wheel-entry');
    const file = args[i + 1];
    if (!file || file.startsWith('--')) {
      console.error('✗ 用法：install-engine-deps.mjs --wheel-entry <path/to/x.whl>');
      return 2;
    }
    if (!fs.existsSync(file)) {
      console.error(`✗ 找不到 wheel：${path.resolve(file)}`);
      return 2;
    }
    console.log(JSON.stringify(wheelEntryOf(file), null, 2));
    console.log(
      '⚠ 把上面这条粘进 engine/wheels.manifest.json 的 wheels[]，并补上 url / sources（上传镜像通道之后）——' +
        ' `check:pydensecrf-wheel` 的 WB.W1 要求每条都有 url。',
    );
    return 0;
  }

  if (!fs.existsSync(VENV_PY)) throw new Error(`venv 不存在：${VENV_PY}（先跑 setup-engine.mjs --venv）`);
  if (!fs.existsSync(REQ)) throw new Error(`requirements.txt 不存在：${REQ}`);

  const onlyMain = args.includes('--main');
  const onlyCrf = args.includes('--crf');

  const env = msvcEnv();

  const reqText = fs.readFileSync(REQ, 'utf8');
  const crfMatch = CRF_RE.exec(reqText);
  if (!crfMatch) throw new Error('requirements.txt 里没找到 pydensecrf 直链行');
  const crfUrl = crfMatch[1].trim();
  log(`pydensecrf 直链: ${crfUrl}`);

  /*
   * `--build-wheel [--out <dir>]`：**在目标平台真构建一次**（B4 的 `fillHowTo` 第①步）。
   *
   * 为什么需要它：wheel 通道的每一环都能在本机跑，唯独"产出一个 wheel"要在
   * **有编译器的目标平台**上做一次。把这件事收进同一脚本，是为了复用**同一份**
   * MSVC 环境探测与**同一份** sdist 缓存（`RT/.download-cache`）——
   * `vcvars` 那套坑（sandbox 拦 `reg.exe`、INCLUDE 残缺）在这里已经踩平了，
   * 另写一个脚本必然再踩一遍。
   *
   * ⚠️ 产物落 `<out>`（缺省 = wheel 通道目录 `RT/.download-cache/wheels/`）：那是 `planCrf`
   *    找 wheel 的地方 ⇒ 本机构建一次之后，同一台机器上的重装就会**走 wheel 不编译**。
   *    但要让**别人**也用得上，还得把 wheel 传到镜像通道并登记清单（见打印出来的条目）。
   */
  if (args.includes('--build-wheel')) {
    const oi = args.indexOf('--out');
    const outDir = oi >= 0 && args[oi + 1] && !args[oi + 1].startsWith('--') ? args[oi + 1] : wheelDir();
    fs.mkdirSync(outDir, { recursive: true });
    const crfZip = await ensureCrfSdist(crfUrl);
    log(`构建 wheel → ${outDir}（MSVC ${process.env.MIAO_VC_ROOT ?? '自动探测'}）`);
    const code = runPip(
      env,
      ['-m', 'pip', 'wheel', '--no-build-isolation', '--no-deps', '-w', outDir, crfZip],
      '构建 pydensecrf wheel',
    );
    if (code !== 0) {
      log('✗ 构建失败。这条命令**需要编译器**（本机无 MSVC/SDK 时属预期失败 —— 那就去有编译器的机器上跑）。');
      throw new Error(`--build-wheel 失败，exit=${code}`);
    }
    const built = fs.readdirSync(outDir).filter((n) => n.endsWith('.whl'));
    if (built.length === 0) throw new Error(`构建命令退出 0，但 ${outDir} 里没有 .whl`);
    const newest = built
      .map((n) => ({ n, t: fs.statSync(path.join(outDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].n;
    const abs = path.join(outDir, newest);
    log(`✓ 产出 ${abs}`);
    console.log('\n把下面这条粘进 engine/wheels.manifest.json 的 wheels[]：\n');
    console.log(JSON.stringify(wheelEntryOf(abs), null, 2));
    console.log(
      '\n⚠ `url` / `sources` 要等你把 wheel 传到镜像通道之后再补 —— 清单里每条都必须有 url（WB.W1 会检查）。',
    );
    return 0;
  }

  // ---------- 批 A：除 pydensecrf 外的全部依赖 ----------
  if (!onlyCrf) {
    const tmpReq = path.join(os.tmpdir(), 'miao-engine-req-nocrf.txt');
    const filtered = reqText
      .split(/\r?\n/)
      .filter((l) => !CRF_RE.test(l))
      .join('\n');
    fs.writeFileSync(tmpReq, filtered, 'utf8');
    const code = runPip(env, ['-m', 'pip', 'install', '-r', tmpReq, '-i', PYPI], '批 A：安装主依赖');
    if (code !== 0) throw new Error(`批 A 安装失败，exit=${code}`);
    log('✓ 批 A 完成');
  }

  // ---------- 批 B：pydensecrf —— 优先用清单里的预编译 wheel，否则源码编译 ----------
  if (!onlyMain) {
    const plan = planCrf();
    log(`pydensecrf 路线：${plan.route} —— ${plan.reason}`);
    if (plan.route === 'wheel') {
      /*
       * 预编译 wheel（B4）：**不编译**，所以没有 MSVC / Xcode CLT 的机器也能装上
       * (这是本任务存在的唯一理由)。`--no-deps`：它的依赖（cython/numpy）已由批 A 装齐。
       */
      const code = runPip(env, ['-m', 'pip', 'install', '--no-deps', plan.abs], '批 B：装预编译 wheel');
      if (code !== 0) {
        log('✗ 预编译 wheel 安装失败 —— 回退到源码编译（wheel 只是便利，不该让装配整体失败）');
        return await buildFromSource(env, crfUrl);
      }
      log('✓ 批 B 完成（预编译 wheel，未编译）');
    } else {
      await buildFromSource(env, crfUrl);
    }
  }

  // ---------- 安装后：pydensecrf 旧常量兼容补丁（幂等） ----------
  patchPydensecrfCompat();

  // ---------- 校验 ----------
  log('▶ 导入自检');
  spawnSync(
    VENV_PY,
    [
      '-c',
      'import pydensecrf.densecrf as d; assert hasattr(d, "DIAG_KERNEL") and hasattr(d, "NO_NORMALIZATION"); import pydensecrf.utils, torch, torchvision; from manga_translator.mask_refinement import dispatch; print("torch", torch.__version__, "cuda", torch.cuda.is_available()); print("import ok")',
    ],
    { stdio: 'inherit', cwd: SRC, env },
  );
  log('全部完成');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[deps] 失败：', e.message);
    process.exit(1);
  });
