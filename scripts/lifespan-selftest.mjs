#!/usr/bin/env node
/**
 * M3 生命周期验收（B1–B3）—— 把「跑一次」变成一条命令。
 *
 * B1–B3 原本只能靠人点（关窗、看托盘、点退出菜单）。本机没有授予「自动化」权限
 * （osascript 被 TCC 以 -10004 拒绝，非沙箱同样如此），所以验收由应用自身的
 * `MIAO_SELFTEST=1` 模式程序化完成 —— 它触发的正是点关闭按钮那条 `CloseRequested` 路径。
 *
 * 用法：
 *   node scripts/lifespan-selftest.mjs            正常跑（期望全绿）
 *   node scripts/lifespan-selftest.mjs --refute   反证跑（期望**拿不到结果**）
 *
 * 为什么要 --refute：跑了绿不等于测对了。它把「关窗」换成真退出，如果这组断言
 * 此时仍然全绿，就说明它测的不是「关窗仅隐藏」。反向那轮必须失败，正向才算数。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ensureDevServer, portOpen } from './_devserver.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'app');
const BIN = path.join(APP, 'src-tauri', 'target', 'debug', 'miao-dock');
/// 落盘根目录与状态目录都指到仓库内的临时目录：既别碰用户的 ~/Pictures/Box 漫画，
/// 也让每次自检从空目录开始（否则续做/编号会受上一轮残留影响）。
const TMP = path.join(ROOT, '.tmp-selftest');
/// 服务端口段（契约 §1）+ 引擎默认端口
const SERVICE_PORTS = Array.from({ length: 11 }, (_, i) => 5180 + i);
const ENGINE_PORT = 5003;

const refute = process.argv.includes('--refute');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runApp() {
  return new Promise((resolve) => {
    if (!existsSync(BIN)) {
      console.error(`找不到二进制：${BIN}\n先在 app/src-tauri 下 cargo build`);
      process.exit(2);
    }
    const child = spawn(BIN, [], {
      cwd: path.join(APP, 'src-tauri'),
      env: {
        ...process.env,
        MIAO_SELFTEST: '1',
        MIAO_ROOT: path.join(TMP, 'root'),
        MIAO_STATE_DIR: path.join(TMP, 'state'),
        ...(refute ? { MIAO_CLOSE_QUITS: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (out += b.toString('utf8')));
    // 自检最长约 12s；再留一点余量就要能收工
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function parseResult(out) {
  const line = out.split('\n').find((l) => l.includes('MIAO_SELFTEST_RESULT'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf('{')));
  } catch {
    return null;
  }
}

/**
 * 谁占着这个端口 —— 只在 B4 判红时调用，用来把「仍被占用：5180」变成可行动的线索。
 *
 * 加它的直接原因：一次验收里 5180 报红，实际坐的是**上一轮截图失败留下的 service 残留**
 * （所以 M3 自己的 service 才升到 5181）。光看「5180 被占」会怀疑本轮代码；
 * 报出占用者是谁、什么进程，就不用再查一轮。取不到就算了，绝不让它影响断言本身。
 */
function whoHolds(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcn'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = /^p(\d+)/m.exec(out)?.[1];
    const cmd = /^c(.+)$/m.exec(out)?.[1];
    return pid ? `${cmd || '?'}(pid ${pid})` : null;
  } catch {
    return null;
  }
}

/** 等这些端口全部释放（B4：退出后不留孤儿占着 5180 / 5003） */
async function waitPortsFreed(ports, timeoutMs = 12_000) {
  const busyNow = async () => {
    const busy = [];
    for (const p of ports) if (await portOpen(p, 200)) busy.push(p);
    return busy;
  };
  const until = Date.now() + timeoutMs;
  let busy = await busyNow();
  while (busy.length && Date.now() < until) {
    await sleep(400);
    busy = await busyNow();
  }
  return { ok: busy.length === 0, busy };
}

const startedVite = await ensureDevServer({ root: ROOT });
let failed = 0;
try {
  const { out } = await runApp();
  const result = parseResult(out);
  // B4：退出后端口必须释放。这条只能从**外面**看 —— 应用自己已经在收尾了，
  // 没法再自证「我退干净了」。
  const freed = await waitPortsFreed([...SERVICE_PORTS, ENGINE_PORT]);
  const freedDetail = freed.ok
    ? '5180–5190 / 5003 均已释放，无孤儿进程'
    : `仍被占用：${freed.busy
        .map((p) => {
          const holder = whoHolds(p);
          return holder ? `${p}（${holder}）` : String(p);
        })
        .join('、')}`;

  if (refute) {
    // 反证：关窗即退进程 ⇒ 自检根本走不到打印那一步
    if (result) {
      console.log('✗ 反证失败：关掉看守后断言**仍然**出了结果 —— 说明这组断言没测到「关窗仅隐藏」');
      console.log(JSON.stringify(result, null, 2));
      failed = 1;
    } else {
      console.log('✓ 反证成立：关窗即退进程时自检拿不到结果，断言确实作用在「关窗仅隐藏」上');
    }
    console.log(`  ${freed.ok ? '✓' : '✗'} B4（反证轮）退出后端口释放 — ${freedDetail}`);
    if (!freed.ok) failed = 1;
  } else if (!result) {
    console.log('✗ 未拿到自检结果：');
    console.log(out.split('\n').slice(-12).join('\n'));
    failed = 1;
  } else {
    console.log(`M3 生命周期验收\n\n关窗与托盘（B1–B3）：${result.passed} / ${result.total} 通过`);
    for (const c of result.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id} — ${c.detail}`);
    failed = result.checks.filter((c) => !c.ok).length;

    console.log('\n退出清理（B4）：');
    console.log(`  ${freed.ok ? '✓' : '✗'} 应用退出后端口释放 — ${freedDetail}`);
    if (!freed.ok) failed += 1;
  }
} finally {
  if (startedVite) startedVite.kill('SIGTERM');
}

process.exit(failed ? 1 : 0);
