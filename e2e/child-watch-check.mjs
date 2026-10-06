#!/usr/bin/env node
/**
 * `engine/scripts/child-watch.mjs` 的**双向**取证。
 *
 * 为什么值得单列一条：真模式下 ② python / ③ llama-server 是**外部二进制**，改不了它们，
 * E11（主进程被 SIGKILL 后不留孤儿）**完全押在这个看手上**。而真模式 E11 要跑分钟级、
 * 几 GB 权重、还依赖本机 runtimes 就绪 —— 不适合当每轮回归的判据。
 * 这里用一个可心跳的假目标进程，把「父死 ⇒ 子树被带走」在**秒级**钉死；真模式 E11 只作
 * 端到端的补充证据，不是唯一证据。
 *
 * 判据不是"进程还在不在"（`pgrep -f` 连看守自己也一起匹配，会分不清是哪个没死），
 * 而是**目标进程是否还在写心跳文件** —— 只由被看守的那个进程写，指向唯一。
 *
 * 用法：
 *   node e2e/child-watch-check.mjs            正向：父死 ⇒ 心跳停
 *   node e2e/child-watch-check.mjs --refute   反证：关掉看守（MIAO_NO_PARENT_WATCH=1）⇒ 心跳继续
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH = path.join(ROOT, 'engine', 'scripts', 'child-watch.mjs');
const refute = process.argv.includes('--refute');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(WATCH)) {
  console.error(`找不到看守脚本：${WATCH}`);
  process.exit(2);
}

const beat = path.join(os.tmpdir(), `miao-cw-beat-${process.pid}-${Date.now()}.txt`);

/** 每 150ms 写一次心跳；它自己的 pid 也写进去，方便反证轮清理 */
const TARGET_JS = `
const fs = require('fs');
const p = process.argv[1];
fs.writeFileSync(p + '.pid', String(process.pid));
setInterval(() => fs.writeFileSync(p, String(Date.now())), 150);
`;

/// 父进程存活时长：必须**明显长于**一次心跳采样窗口（`beating()` 约 1.3s），
/// 否则"目标曾经在跳"这一步会与"父已死、目标被杀"重叠 —— 实测正是这样误报成
/// 「目标根本没在跳」（两次采样都落在冻结之后 ⇒ 相同 ⇒ 被判成没起来）。
const PARENT_ALIVE_MS = 4000;

/**
 * 造一个"父进程"：它起 child-watch（= 看守），看守再起心跳目标，活一会儿后退出。
 * 这就是 E11 的场景缩影 —— 父进程没了，剩下的进程只能自救。
 *
 * 返回 `{ exit }`：`exit` 在父进程真正退出后 resolve。调用方要**先**在父进程还活着时
 * 采样心跳（证明目标确实在跑），再 `await exit`，然后再采样。
 */
function spawnDyingParent() {
  const inner = JSON.stringify([WATCH, '--', process.execPath, '-e', TARGET_JS, beat]);
  // 两点都不能省：
  //  ① `unref()` —— 否则这个"父进程"会**等着子进程退出**才退，"父进程已死"这个前提就不成立
  //     （实测：整条脚本卡住 90s+，什么都没测到）。
  //  ② 活够 `PARENT_ALIVE_MS` —— 让看守完成启动并记下 `bootPpid`（走"ppid 变化"这条主路径，
  //     而不是"出生即孤儿"那条兜底分支）。
  const src =
    `const c = require('child_process').spawn(${JSON.stringify(process.execPath)}, ${inner}, ` +
    `{ stdio: 'ignore', env: process.env }); c.unref(); ` +
    `setTimeout(() => process.exit(0), ${PARENT_ALIVE_MS});`;
  const env = { ...process.env };
  if (refute) env.MIAO_NO_PARENT_WATCH = '1';
  const p = spawn(process.execPath, ['-e', src], { stdio: 'ignore', env });
  return { exit: new Promise((r) => p.once('exit', () => r(p))) };
}

const readBeat = () => {
  try {
    return fs.readFileSync(beat, 'utf8');
  } catch {
    return '';
  }
};

/** 连续两次采样是否**不同** ⇒ 心跳还在跳 ⇒ 目标进程还活着 */
async function beating(windowMs = 1200) {
  const a = readBeat();
  await sleep(windowMs);
  const b = readBeat();
  return { alive: Boolean(a) && Boolean(b) && a !== b, a, b };
}

/**
 * 收干净。**只杀目标进程是不够的** —— 上一轮实测就漏掉了"父进程"与看守，
 * 它们带着同一个心跳路径继续赖着，下一轮的 `ps` 线索里混进上一轮的进程，
 * 把"本轮为什么失败"这件事直接搅浑（这正是本文件要防的那类噪声）。
 * 心跳路径是每次运行唯一的，按它 `pkill -f` 既精确又不会误伤别的进程。
 */
function cleanup() {
  try {
    const pid = Number(fs.readFileSync(`${beat}.pid`, 'utf8'));
    if (Number.isFinite(pid) && pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    execFileSync('pkill', ['-f', beat], { stdio: 'ignore' });
  } catch {
    /* 没有匹配即退出码 1，属正常 */
  }
  for (const f of [beat, `${beat}.pid`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

console.log(`child-watch 双向取证（${refute ? '反证轮' : '正向轮'}）\n`);
let failed = 0;
try {
  const parent = spawnDyingParent();
  await sleep(1100); // 让看守与目标起来

  // ① 先在**父进程还活着**时采样：证明目标确实在跳（否则后面的"停了"什么都证明不了）
  const before = await beating();
  if (!before.alive) {
    console.log('✗ 前置失败：目标进程根本没在跳（看守或目标没起来），本轮结论无效');
    try {
      const lines = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.includes('child-watch.mjs'));
      console.log(lines.join('\n') || '(没有看守进程)');
    } catch {
      /* ignore */
    }
    failed = 1;
  } else {
    // ② 父进程退出，再看目标
    await parent.exit;
    await sleep(1600); // 看守每 1s 巡一次，留一轮余量
    const after = await beating(1500);
    if (refute) {
      // 关掉看守：没人负责带走目标 ⇒ 心跳必须**继续跳**（孤儿）。若它停了，说明带走它的另有其人。
      if (after.alive) {
        console.log(`✓ 反证成立：关掉父死看守 ⇒ 目标进程活了下来（心跳仍在跳：${after.a} → ${after.b}）`);
      } else {
        console.log('✗ 反证失败：关掉看守后目标**仍然**死了 —— 说明它不是被看守带走的');
        failed = 1;
      }
    } else if (!after.alive) {
      console.log(
        `✓ 父进程退出后，被看守的目标进程被带走（心跳停止于 ${after.b || after.a || '(空)'}；` +
          `此前在跳：${before.a} → ${before.b}）`,
      );
    } else {
      console.log(`✗ 父进程退出后目标**仍在跳**（${after.a} → ${after.b}）—— 看守没生效，真模式 E11 会留孤儿`);
      failed = 1;
    }
  }
  await parent.exit;
} finally {
  cleanup();
}

process.exit(failed ? 1 : 0);
