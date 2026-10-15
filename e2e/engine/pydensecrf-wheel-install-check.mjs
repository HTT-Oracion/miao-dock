#!/usr/bin/env node
/**
 * B4 · 「预编译 wheel **真的装得上、真的能用**」钉子（nightly 层）
 * =============================================================================
 * 对应 B4 的验收①：「无编译器的机器按文档 + 该 wheel 装成功」。
 *
 * ## 为什么这一条能在**本机**验，而不需要"一台没有编译器的机器"
 * 验收①真正要排除的是「装这个 wheel 会不会仍然去编译」。而这件事有**比"换台机器"更强的判据**：
 *
 *   `pip install --no-index --no-deps <whl>`
 *
 * `--no-index` 断掉所有索引 ⇒ 任何"顺手去下 sdist 重编一次"的行为都会**立刻失败**；
 * 装成功就说明**这颗 wheel 自足**（二进制已经在里面）。再 `import` 它、构造一次
 * `DenseCRF` ⇒ "能用"也有了硬证据。所以本条不需要真机，只需要**一颗真构建出来的 wheel**。
 * （"在裸机上走一遍文档"仍归人工验收；本条证明的是它的**充分条件**。）
 *
 * ## 前置（硬前置，不软跳过）
 * 盘上得有一颗 wheel：`node engine/scripts/install-engine-deps.mjs --build-wheel`
 * 产出到 `<RT>/.download-cache/wheels/`（`MIAO_WHEEL_DIR` 可覆盖）。
 * 没有 ⇒ **失败并点名该命令** —— "跳过 ≠ 通过"，这一层不允许静默缺席。
 *
 * ## 断言
 *   W1 找到 wheel（否则失败并给出构建命令）
 *   W2 `--target` 安装：`pip install --no-index --no-deps` 成功 ⇒ **自足，不联网、不编译**
 *   W3 装出来的 `pydensecrf` 里有一个真的二进制扩展（PE/ELF/Mach-O 魔术头，不是 `.py` 冒充）
 *   W4 `import` + 构造 `DenseCRF(10,10)` 成功，且枚举成员在（`KernelType.DIAG_KERNEL` /
 *      `NormalizationType.NO_NORMALIZATION`）⇒ 产品那条兼容补丁（回填模块级常量）在
 *      wheel 产物上**同样成立**
 *   W5 wheel 的文件名 tag 与产品 `--print-plan` 报的 `platform` / `pythonTag` 一致
 *      （构建出来的 wheel 与清单里登记的口径对不上 = 通道装了个差一档的二进制）
 *
 * 用法：node e2e/engine/pydensecrf-wheel-install-check.mjs
 * （慢：约 20s；不进 static/service 层）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const RT =
  process.env.MIAO_MODEL_ROOT ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'runtimes', 'manga-translator')
    : path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'runtimes',
        'manga-translator',
      ));
const WHEEL_DIR = process.env.MIAO_WHEEL_DIR || path.join(RT, '.download-cache', 'wheels');
const VENV_PY = path.join(
  RT,
  'venv',
  process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'),
);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}

if (!fs.existsSync(VENV_PY)) {
  console.error(`✗ 找不到引擎 venv：${VENV_PY}\n先跑 npm run setup:engine`);
  process.exit(1);
}

const wheels = fs.existsSync(WHEEL_DIR)
  ? fs
      .readdirSync(WHEEL_DIR)
      .filter((n) => n.endsWith('.whl'))
      .map((n) => path.join(WHEEL_DIR, n))
  : [];
check('W1 盘上有一颗真构建出来的 wheel（否则本条无法进行 —— 这不是"跳过"，是硬前置）', wheels.length > 0, {
  wheelDir: WHEEL_DIR,
  hint: '先跑：node engine/scripts/install-engine-deps.mjs --build-wheel',
});
if (wheels.length === 0) {
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(1);
}
const whl = wheels.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
console.log(`  · 使用 ${whl}`);

// ---- W2：--no-index --no-deps 装进一个空 target（自足性：不联网、不编译）----
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-whl-'));

const install = spawnSync(VENV_PY, ['-m', 'pip', 'install', '--no-index', '--no-deps', '--target', target, whl], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
const installOut = `${install.stdout ?? ''}${install.stderr ?? ''}`;
check(
  'W2 `pip install --no-index --no-deps <whl>` 成功 ⇒ 这颗 wheel **自足**：不联网、不触发任何编译' +
    '（`--no-index` 让"顺手去下 sdist 重编"这类行为必然失败，比"换一台没有编译器的机器"更强）',
  install.status === 0,
  { status: install.status, tail: installOut.slice(-300) },
);

// ---- W3：装出来的是**真二进制**扩展，不是 .py 冒充 ----
const pkgDir = path.join(target, 'pydensecrf');
const binFiles = fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir).filter((n) => /\.(pyd|so|dylib)$/.test(n)) : [];
const magic = binFiles.length > 0 ? fs.readFileSync(path.join(pkgDir, binFiles[0])).subarray(0, 4) : Buffer.alloc(0);
const isBinary =
  (magic[0] === 0x4d && magic[1] === 0x5a) || // MZ (PE)
  (magic[0] === 0x7f && magic[1] === 0x45) || // ELF
  (magic[0] === 0xcf && magic[1] === 0xfa) || // Mach-O 64
  (magic[0] === 0xca && magic[1] === 0xfe); // Mach-O 32
check('W3 装出来的扩展是**真二进制**（PE / ELF / Mach-O 魔术头，不是 `.py` 冒充）', binFiles.length > 0 && isBinary, {
  binFiles,
  magic: [...magic].map((b) => b.toString(16)).join(' '),
});

// ---- W4：import + 构造 DenseCRF + 枚举成员在（产品那条兼容补丁在 wheel 产物上同样成立）----
const probe = [
  'import sys',
  `sys.path.insert(0, r"${target}")`,
  'import pydensecrf.densecrf as d',
  'assert hasattr(d.KernelType, "DIAG_KERNEL"), "KernelType.DIAG_KERNEL 不在"',
  'assert hasattr(d.NormalizationType, "NO_NORMALIZATION"), "NormalizationType.NO_NORMALIZATION 不在"',
  'crf = d.DenseCRF(10, 10)',
  'print("OK", d.KernelType.DIAG_KERNEL, d.NormalizationType.NO_NORMALIZATION, type(crf).__name__)',
].join('\n');
const run = spawnSync(VENV_PY, ['-c', probe], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
check(
  'W4 `import pydensecrf.densecrf` + 构造 `DenseCRF(10,10)` 成功，且枚举成员在 ⇒ 产品的兼容补丁' +
    '（把枚举回填成模块级常量）在 wheel 产物上**同样成立**',
  run.status === 0 && /^OK /.test(String(run.stdout ?? '').trim()),
  {
    status: run.status,
    out: String(run.stdout ?? '')
      .trim()
      .slice(0, 200),
    err: String(run.stderr ?? '').slice(-300),
  },
);

// ---- W5：wheel 的文件名 tag 与产品自报的 platform/pythonTag 一致 ----
const plan = spawnSync(
  process.execPath,
  [path.join(ROOT, 'engine', 'scripts', 'install-engine-deps.mjs'), '--print-plan'],
  { cwd: ROOT, encoding: 'utf8' },
);
let planObj = {};
try {
  planObj = JSON.parse(String(plan.stdout ?? ''));
} catch {
  /* 下面判据会红 */
}
const base = path.basename(whl);
const tagOk =
  base.includes(String(planObj.pythonTag ?? '\u0000')) &&
  (planObj.platform === 'win32-x64' ? base.includes('win_amd64') : true) &&
  (planObj.platform === 'darwin-arm64' ? /(arm64|universal2)/.test(base) : true);
check(
  'W5 wheel 的文件名 tag 与产品自报的 `platform` / `pythonTag` 一致（登记的通道口径与产物对不上 = 装了个差一档的二进制）',
  tagOk,
  { file: base, platform: planObj.platform, pythonTag: planObj.pythonTag },
);

fs.rmSync(target, { recursive: true, force: true });
// ⚠️ 只删临时 target：**不动** wheel 与 venv 里的东西（那是用户装好的资产）

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
