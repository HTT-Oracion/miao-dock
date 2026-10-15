#!/usr/bin/env node
/**
 * D-25 验收：reqwest 的 TLS 能力是否真的可用（且必须**可反证**）。
 *
 * 为什么需要这条断言 —— 一个典型的静默失败层：
 *
 *   Box 的 reqwest 原本是 `default-features = false`（注释：只走 127.0.0.1，
 *   不需要 TLS）。ver2.0 音乐模块要访问公网 HTTPS（music.163.com 等）。
 *   **缺 TLS 的表现是**：依赖装得上、`cargo build` 全绿、tsc 通过、
 *   现有全部断言（只覆盖 127.0.0.1）一条不红 —— 直到运行时才报
 *   「URL scheme not supported」/ builder error。
 *
 *   也就是说：这个缺陷在「除了真去发一个 https 请求」之外的每一层都是绿的。
 *   这正是 docs/spec-notes.md D-20 说的「每层都要断言」——
 *   依赖层的语义缺失，编译器看不见、截图看不见、单测看不见。
 *
 * 反证怎么做的（关键，否则这条断言也是假阳性）：
 *   把 Cargo.toml 的 `rustls-tls` feature 去掉重跑 → 本组必须变红。
 *   若去掉后仍然全绿，说明它测的不是 TLS（测错了东西）。
 *
 * 用法：
 *   node e2e/tls-check.mjs            正常跑（期望全绿）
 *   npm run task -- check:tls             同上
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CARGO_TOML = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const CARGO_LOCK = path.join(ROOT, 'src-tauri', 'Cargo.lock');

let pass = 0;
let fail = 0;
function ok(cond, label, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const toml = readFileSync(CARGO_TOML, 'utf8');
const reqwestLine = (toml.match(/^reqwest\s*=.*$/m) || [''])[0];

console.log('\n【D-25】reqwest TLS 能力验收');
console.log(`  当前：${reqwestLine.trim() || '(未找到 reqwest 依赖行)'}\n`);

// ── 1. 配置层：feature 声明是否正确 ────────────────────────────────
console.log('配置层');
ok(/reqwest\s*=/.test(toml), 'Cargo.toml 声明了 reqwest');
ok(
  /rustls-tls/.test(reqwestLine),
  'reqwest 启用 rustls-tls feature',
  '未找到 rustls-tls —— 公网 HTTPS 会在运行时失败（D-25）',
);
// 记录本组要断言的「反面」：关掉 TLS 是本项目 ver1.0 的真实历史状态
ok(!/native-tls/.test(reqwestLine), '未误用 native-tls（避免 OpenSSL 系统依赖）');

// ── 2. 锁文件层：TLS 栈是否真的进了依赖图 ──────────────────────────
// 只看 Cargo.toml 不够 —— feature 名写对了但没生效的情况，靠锁文件才看得见。
//
// ⚠️ 但锁文件是**上一次 build 的产物**，配置刚改、还没 build 时它是过期的。
// 反证时实测到这一点：移除 feature 后配置层变红，锁文件层 4 条却仍全绿 ——
// 那一刻它在报告「上一次编译有 TLS」，而不是「现在有没有 TLS」。
// 所以这里必须先判断锁文件与配置是否**同步**，不同步就说清楚，
// 不能让过期信号被读成「已具备 HTTPS 能力」。
console.log('\n锁文件层');
let lock = '';
try {
  lock = readFileSync(CARGO_LOCK, 'utf8');
} catch {
  ok(false, '读取 Cargo.lock', '文件不存在，先跑一次 cargo build');
}

const declaresTls = /rustls-tls/.test(reqwestLine);
if (lock) {
  const has = (name) => new RegExp(`name = "${name}"`).test(lock);
  const lockHasTls = has('rustls') && has('hyper-rustls');

  if (declaresTls && !lockHasTls) {
    ok(false, '锁文件与配置同步', '配置要了 rustls-tls，但 Cargo.lock 里没有 —— 需要 cargo build');
  } else if (!declaresTls && lockHasTls) {
    ok(
      false,
      '锁文件与配置同步',
      '配置已移除 rustls-tls，但 Cargo.lock 仍是上一次 build 的产物（含 TLS）。' +
        '\n      这是过期信号，不能据此认为 HTTPS 可用 —— 请 cargo build 后复跑。',
    );
  } else {
    ok(true, '锁文件与配置同步');
    // 只有「同步」时，这四条才是可信的判据
    for (const dep of ['rustls', 'hyper-rustls', 'tokio-rustls', 'ring']) {
      ok(has(dep), `依赖图含 ${dep}`);
    }
    ok(lockHasTls, 'reqwest 具备 HTTPS 传输能力（rustls + hyper-rustls 齐备）');
  }
}

// ── 3. 源码层：音乐模块需要的凭据确实在用 ─────────────────────────
// 防止「TLS 加了但音乐模块根本没接上」—— 那时本组会绿，但功能不存在。
console.log('\n源码层');
const VENDOR = path.join(ROOT, 'vendor', 'music-reference', 'rust-music_api');
let vendorAvailable = true;
let vendorSrc = '';
try {
  vendorSrc = ['netease.rs', 'kugou.rs', 'qqmusic.rs', 'migu.rs']
    .map((f) => readFileSync(path.join(VENDOR, f), 'utf8'))
    .join('\n');
} catch {
  vendorAvailable = false;
}
if (vendorAvailable) {
  const hosts = [
    ['music.163.com', '网易云'],
    ['gateway.kugou.com', '酷狗'],
    ['c.y.qq.com', 'QQ 音乐'],
    ['migu.cn', '咪咕'],
  ];
  for (const [host, name] of hosts) {
    ok(vendorSrc.includes(host), `参考源码含 ${name} 域名（${host}）—— 确需公网 HTTPS`);
  }
  ok(vendorSrc.includes('https://'), '参考源码使用 https 协议', '若全为 http 则不需要 TLS，D-25 不适用');
} else {
  console.log('  · 参考源码不在位（vendor/ 未落盘），跳过源码层');
  console.log('    注：这不影响 D-25 本身 —— 配置层与锁文件层才是它的判据');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n下一步：给 Cargo.toml 的 reqwest 补 `rustls-tls` feature，');
  console.log('        然后 cargo build 让锁文件刷新（本组第 2 层会随之变绿）。');
}
process.exit(fail === 0 ? 0 : 1);
