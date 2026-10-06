#!/usr/bin/env node
/**
 * M5 的截图取证 —— 让应用自己把四个屏各截一张。
 *
 * M5 的 DoD 里写着「截图取证」。本机**有**屏幕录制权限，但拿不到窗口位置：
 * `osascript` 被 TCC 以 -10004 拒绝（自动化/辅助功能未授权），系统 `python3` 又没有 pyobjc。
 * 而窗口位置这件事，应用自己最清楚 —— 所以由应用算好区域后调 `screencapture -R`，
 * 只截自己那一块。
 *
 * 截图用的落盘目录是端到端那一轮的真实产物（默认 `.tmp-e2e/root`，可用 `MIAO_E2E_TMP` 覆盖，
 * 与 `scripts/e2e.mjs` 共用同一变量），所以漫画库里看到的是真数据、对照页里是真题，不是摆拍。
 * **先跑 `npm run e2e` 再跑这个。**
 *
 * 两道闸，都为了同一件事：**别把假图当证据收进仓**。
 *   ① 开跑前问系统是否锁屏 —— 锁屏时截到的是壁纸，尺寸和体积却都「正常」；
 *   ② 各屏先落暂存区，**互不相同**且齐全才整批搬进 `docs/refs/e2e/`。
 * 任一不过就整批丢弃，仓里保持上一轮已验证的版本，不会被坏运行覆盖。
 *
 * 用法：node scripts/capture.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { ensureDevServer } from './_devserver.mjs';
import { describeE2eTmp, e2eRoot, e2eState } from './_e2e-paths.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'app', 'src-tauri', 'target', 'debug', 'miao-dock');
const OUT = path.join(ROOT, 'docs', 'refs', 'e2e');

/** 取证图的文件名与它们各自该拍到什么（缺失或重复都算这一张没截到） */
const SHOTS = [
  ['01-queue.png', '任务队列'],
  ['02-library.png', '本地漫画库'],
  ['03-compare.png', '原译对照'],
  ['04-settings-dark.png', '设置页（深色）'],
  // S6 取证：②翻译服务（十项 / 三小节 / 引擎诊断）。04 停在「通用」，
  // 单靠它看不出 S6 到底交付了什么 —— 而这一屏正是 S6 的唯一出口。
  ['05-settings-engine.png', '设置 ②翻译服务（服务与配对 / 推理引擎 / 模型与诊断）'],
  ['06-settings-diag.png', '设置 ②翻译服务 · 引擎诊断面板（滚到底）'],
];

/**
 * 截图**先落到暂存区**，SHOTS 全部齐且互不相同，才整批搬进 `docs/refs/e2e/`。
 *
 * 为什么不是直接截进仓：坏运行会把好证据原地覆盖掉（已经吃过一次 —— 一次锁屏运行，
 * 四张真图被同一张壁纸替换，而壁纸尺寸、体积都「正常」，肉眼和体积校验都拦不住）。
 * 改成暂存后，仓里任何时刻要么是上一轮**已验证**的全套，要么什么都没变。
 */
const STAGE = path.join(os.tmpdir(), 'miao-capture');

/**
 * 锁屏探测。
 *
 * 锁屏时 `screencapture -R` 会**成功**返回窗口大小的一张图 —— 内容是锁屏壁纸，
 * 因为应用窗口被挡在后面。这类失败最危险：尺寸对、体积大、四张还长得一模一样。
 * 应用侧那道「字节数下限」闸拦不住它，所以在这里先问系统一句。
 *
 * 返回 `null` 表示问不出来（非 macOS / ioreg 不可用），此时不阻断，交给下面的重复检测兜底。
 */
function screenLocked() {
  try {
    const out = execFileSync('ioreg', ['-n', 'Root', '-d1'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /CGSSessionScreenIsLocked\D{0,4}Yes/.test(out);
  } catch {
    return null;
  }
}

const rootDir = e2eRoot();
const stateDir = e2eState();
if (!existsSync(rootDir)) {
  console.error(`没有可截的漫画库数据：${describeE2eTmp()}/root 不存在。\n先跑一次 npm run e2e。`);
  process.exit(2);
}
if (!existsSync(BIN)) {
  console.error(`找不到二进制：${BIN}\n先在 app/src-tauri 下 cargo build`);
  process.exit(2);
}

const locked = screenLocked();
if (locked === true) {
  console.error(
    '屏幕现在是锁屏状态，截不到界面 —— 截出来会是锁屏壁纸，尺寸和体积却都「正常」。\n'
    + '请先解锁屏幕（保持亮着、停在桌面上），再重跑这个脚本。\n'
    + '（应用侧对空屏有检测，但对锁屏壁纸无效：壁纸不是空屏。这道闸只能在这里拦。）',
  );
  process.exit(2);
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const startedVite = await ensureDevServer({ root: ROOT });

// 显示器睡眠时 `screencapture -R` 会直接失败；更坏的是 `-x`（全屏）会「成功」却只截到纯黑。
// 应用侧已经加了空屏检测，但那是**事后**报警 —— 这里先把显示器顶住，让取证一开始就有条件跑成。
// `-u` 声明用户活动（唤醒）、`-d` 阻止显示器再睡，超时略长于整轮截图。
const caffeinate = spawn('caffeinate', ['-d', '-u', '-t', '120'], { stdio: 'ignore' });
caffeinate.on('error', () => {
  // 非 macOS 或没有 caffeinate：不阻断，交给应用侧的空屏检测兜底
});

const child = spawn(BIN, [], {
  cwd: path.join(ROOT, 'app', 'src-tauri'),
  env: {
    ...process.env,
    // 截图是**表现层**取证，不该被引擎栈拖住：不显式声明时 Rust 侧默认 `real`，
    // 会去起 Python + 几 GB 权重（分钟级），截图任务会因此超时/失败。
    MIAO_ENGINE_PROTOCOL: 'mock',
    MIAO_CAPTURE_DIR: STAGE,
    MIAO_ROOT: rootDir,
    MIAO_STATE_DIR: stateDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (b) => (out += b.toString('utf8')));
child.stderr.on('data', (b) => (out += b.toString('utf8')));

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  child.once('exit', (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});

if (startedVite) startedVite.kill('SIGTERM');
if (caffeinate.exitCode === null) caffeinate.kill('SIGTERM');

const lines = out
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('✓') || l.startsWith('✗'));

console.log('M5 截图取证');
console.log(`\n暂存目录：${STAGE}`);
console.log(`入库目录：${path.relative(ROOT, OUT)}\n`);

if (lines.length === 0) {
  console.log('未产出一张截图（应用可能没走到截图那一步）：');
  console.log(out.split('\n').slice(-14).join('\n'));
  process.exit(1);
}
for (const l of lines) console.log(`  ${l}`);

// ---- 校验：全部齐、且互不相同。任一条不过就整批不入库，仓里保持原样。 ----

const absent = SHOTS.filter(([f]) => !existsSync(path.join(STAGE, f)));
if (absent.length) {
  console.error(
    `\n${absent.length} 张没截到：${absent.map(([f, label]) => `${f}（${label}）`).join('、')}\n`
    + '整批不入库 —— 仓里仍是上一轮验证过的版本。',
  );
  process.exit(1);
}

const digests = SHOTS.map(([f]) => [
  f,
  createHash('sha1').update(readFileSync(path.join(STAGE, f))).digest('hex'),
]);
const dupes = digests.filter(([, d], i) => digests.findIndex(([, d2]) => d2 === d) !== i);
if (dupes.length) {
  console.error(
    `\n有截图内容完全一样（${dupes.map(([f]) => f).join('、')}）—— 界面没变，说明截到的不是这个应用。\n`
    + '最常见的原因就是屏幕锁了 / 睡着了，截到的是锁屏壁纸或桌面。\n'
    + '整批不入库 —— 仓里仍是上一轮验证过的版本。',
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
for (const [f] of SHOTS) copyFileSync(path.join(STAGE, f), path.join(OUT, f));
console.log(`\n${SHOTS.length} 张互不相同，已入库 ${SHOTS.length} 张。`);

// 应用侧自己报的成败：全绿才返回 0，与入库与否分开汇报
const bad = lines.filter((l) => l.startsWith('✗')).length;
process.exit(bad || code !== 0 ? 1 : 0);
