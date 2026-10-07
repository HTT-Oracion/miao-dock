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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RT = path.join(ROOT, 'runtimes', 'manga-translator');
const VENV_PY = path.join(RT, 'venv', 'Scripts', 'python.exe');
const SRC = path.join(RT, 'src');
const REQ = path.join(SRC, 'requirements.txt');
const PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple';

const CRF_RE = /^pydensecrf\s*@\s*(\S+)/im;

function log(...a) { console.log('[deps]', ...a); }

/** 取目录下「版本号最大」的子目录名。 */
function newestDir(parent) {
  try {
    const vers = fs.readdirSync(parent).filter((n) => /^\d/.test(n));
    if (!vers.length) return null;
    vers.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return vers[vers.length - 1];
  } catch { return null; }
}

/** MSVC 工具集（`…/VC/Tools/MSVC`）根的候选表 —— VS 安装路径不固定，逐个探测第一个存在的。 */
function msvcVcRoots() {
  return [
    process.env.MIAO_VC_ROOT,
    'C:/VS2022BT/VC/Tools/MSVC',                                                        // 本机实测落点（非默认路径）
    'C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC',           // 官方默认：生成工具
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

  let VC_ROOT = null; let msvcVer = null;
  for (const r of msvcVcRoots()) {
    const v = newestDir(r);
    if (v) { VC_ROOT = r; msvcVer = v; break; }
  }
  if (!VC_ROOT) {
    throw new Error(`找不到 MSVC 工具集（候选：${msvcVcRoots().join(' | ')}；可用 MIAO_VC_ROOT 指向你的 VC/Tools/MSVC）`);
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
  const LIB = [
    `${msvcBase}/lib/x64`,
    `${libBase}/ucrt/x64`,
    `${libBase}/um/x64`,
  ].join(';');

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
  if (!fs.existsSync(initPy)) { log('⚠ 找不到 pydensecrf/__init__.py，跳过兼容补丁'); return; }
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
  if (cur.includes(MARK)) { log('pydensecrf 兼容补丁已在'); return; }
  fs.writeFileSync(initPy, cur + shim, 'utf8');
  log('已写入 pydensecrf 旧常量兼容补丁');
}

/** github 直连本机常被代理拦（502），备用镜像前缀（实测 ghfast/gh-proxy 可通）。 */
function mirrorUrls(url) {
  const list = [url];
  if (/^https:\/\/github\.com\//.test(url)) {
    list.push('https://ghfast.top/' + url);
    list.push('https://gh-proxy.com/' + url);
  }
  return list;
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

  // ---------- 批 A：除 pydensecrf 外的全部依赖 ----------
  if (!onlyCrf) {
    const tmpReq = path.join(os.tmpdir(), 'miao-engine-req-nocrf.txt');
    const filtered = reqText.split(/\r?\n/).filter((l) => !CRF_RE.test(l)).join('\n');
    fs.writeFileSync(tmpReq, filtered, 'utf8');
    const code = runPip(env,
      ['-m', 'pip', 'install', '-r', tmpReq, '-i', PYPI], '批 A：安装主依赖');
    if (code !== 0) throw new Error(`批 A 安装失败，exit=${code}`);
    log('✓ 批 A 完成');
  }

  // ---------- 批 B：源码编译 pydensecrf ----------
  if (!onlyMain) {
    // 先带镜像回退把 sdist zip 抓到本地（绕开 pip 直连 github 的 502），再用本地文件装。
    // 缓存目录与 setup-engine.mjs 同源（RT/.download-cache）—— 它在 gitignore 的 runtimes/ 下，不入库。
    const cacheDir = path.join(RT, '.download-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const crfZip = path.join(cacheDir, 'pydensecrf-master.zip');
    if (!fs.existsSync(crfZip) || fs.statSync(crfZip).size < 1024) {
      await download(crfUrl, crfZip);
    } else {
      log(`使用已缓存的 sdist：${crfZip}`);
    }
    const code = runPip(env,
      ['-m', 'pip', 'install', '--no-build-isolation', crfZip], '批 B：编译 pydensecrf');
    if (code !== 0) {
      log('✗ pydensecrf 编译失败。排查：cython/numpy 是否已装、MSVC 组件是否完整、rc.exe 是否在 PATH。');
      throw new Error(`批 B 失败，exit=${code}`);
    }
    log('✓ 批 B 完成');
  }

  // ---------- 安装后：pydensecrf 旧常量兼容补丁（幂等） ----------
  patchPydensecrfCompat();

  // ---------- 校验 ----------
  log('▶ 导入自检');
  spawnSync(VENV_PY,
    ['-c', 'import pydensecrf.densecrf as d; assert hasattr(d, "DIAG_KERNEL") and hasattr(d, "NO_NORMALIZATION"); import pydensecrf.utils, torch, torchvision; from manga_translator.mask_refinement import dispatch; print("torch", torch.__version__, "cuda", torch.cuda.is_available()); print("import ok")'],
    { stdio: 'inherit', cwd: SRC, env });
  log('全部完成');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('[deps] 失败：', e.message); process.exit(1); });
