#!/usr/bin/env node
/**
 * S2 启动配方契约断言 —— **Rust 侧** `--print-launch-plan` 的输出**形状**。
 *
 * 为什么单独一套：Rust 的 `ServiceManager` 不自己拼命令，而是取一份**启动配方**。
 * 字段名写错、探针少一条、cwd 指错目录，Rust 那边都会以「起不来 / 起错东西」的形式表现，
 * 且**报错信息离根因很远**。所以契约面本身要有断言。
 *
 * ## A3b：被测对象从 node 脚本换成 Rust 二进制
 * 原来这里跑 `service/scripts/print-launch-plan.mjs`（S2 时"引擎侧细节的唯一来源"住在 JS）。
 * A3b 把配方逻辑 Rust 化后，那个脚本**退役**：它是打包后必然失败的那条 node 依赖
 * （A3「node 随包」已作废），而它的报错停在「无法执行 node 打印启动配方」，离根因很远。
 *
 * ⚠️ **24 条断言一条没少，只是换了被测对象** —— 退役脚本 ≠ 退役契约面。
 *    「把断言一起删掉」会让这块覆盖**静默消失**：配方字段写错时没有任何东西会红。
 *
 * 只断言**结构与同源关系**，不断言"文件在不在"（那属于环境就绪，归 S0/E1 管，
 * 且 `runtimes/` 在仓库外 —— 在这里断言存在会把"环境没装"伪装成"代码有 bug"）。
 *
 * 用法：node e2e/service/launch-plan-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUST_BIN } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const results = [];
const check = (id, ok, detail) => results.push({ id, ok: !!ok, detail: String(detail ?? '') });

/** 起一个子进程、收 stdout（🔴 异步 spawn：本机 execFileSync 会 EBUSY，同 `paths-parity-check`）。 */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}：${err.slice(0, 800)}`)),
    );
  });
}

/**
 * 取一份配方。
 *
 * ⚠️ `MIAO_NODE_EXEC` 必须显式给 `process.execPath`：mock 档的命令是「node 解释器 + 替身脚本」，
 *    Node 版用 `process.execPath`（绝对路径），Rust 版读 `MIAO_NODE_EXEC`（缺省 `node`）。
 *    不对齐的话 `engine.cmd[0]` / `llm.cmd[0]` 会差一个"绝对 vs 裸名"—— 那是**两端约定不同**，
 *    不是配方缺陷；断言命令形状时必须先把这个约定消掉，否则会在 Windows 上假红。
 */
async function plan(mode) {
  return JSON.parse(await run(RUST_BIN, ['--print-launch-plan', mode], { MIAO_NODE_EXEC: process.execPath }));
}

const mock = await plan('mock');
const real = await plan('real');

// ---------------------------------------------------------------- 通用形状
for (const [name, p] of [['mock', mock], ['real', real]]) {
  check(
    `P-${name}-1 mode 字段与子进程齐备`,
    p.mode === name && p.engine && p.llm && p.engine.cmd?.length && p.llm.cmd?.length,
    `mode=${p.mode} engine.cmd[0]=${p.engine.cmd?.[0]} llm.cmd[0]=${p.llm.cmd?.[0]}`,
  );
  check(
    `P-${name}-2 每个子进程都有 label 与非空 probes（否则 Rust 无从判就绪）`,
    ['engine', 'llm'].every((k) => p[k].label && Array.isArray(p[k].probes) && p[k].probes.length > 0),
    ['engine', 'llm'].map((k) => `${k}.probes=${p[k].probes?.length}`).join(' '),
  );
  check(
    `P-${name}-3 探针里的端口都是正整数（Rust 侧 u16 反序列化拒绝非法值）`,
    ['engine', 'llm'].every((k) =>
      p[k].probes.every((pr) => Number.isInteger(pr.port) && pr.port > 0 && pr.port < 65536),
    ),
    JSON.stringify(p.engine.probes.map((x) => x.port)),
  );
  check(
    `P-${name}-4 cmd 里的可执行/脚本路径都是**绝对路径**（Rust 的 cwd 是 src-tauri，相对路径必错）`,
    [...p.engine.cmd, ...p.llm.cmd].filter((a) => a.includes('/')).every((a) => path.isAbsolute(a)),
    p.engine.cmd[0],
  );
}

// ---------------------------------------------------------------- mock 专属
check(
  'P-mock-5 engine 指向仓内模拟引擎（engine/src/server.mjs）',
  mock.engine.cmd.some((a) => a.endsWith(path.join('engine', 'src', 'server.mjs'))),
  mock.engine.cmd.join(' '),
);
check(
  'P-mock-6 llm 指向仓内模拟 LLM（engine/src/mock-llm.mjs）—— 保证 mock 下也是**三进程**',
  mock.llm.cmd.some((a) => a.endsWith(path.join('engine', 'src', 'mock-llm.mjs'))),
  mock.llm.cmd.join(' '),
);
check(
  'P-mock-7 engine 探针用 GET /ready（模拟引擎的就绪面），不是真引擎的 POST /queue-size',
  mock.engine.probes.some((p) => p.kind === 'http' && p.method === 'GET' && p.path === '/ready'),
  JSON.stringify(mock.engine.probes),
);
check(
  'P-mock-8 serviceEnv 显式声明 mock 协议（否则适配层拿 real 协议打替身 —— 探测恒 starting）',
  mock.serviceEnv?.MIAO_ENGINE_PROTOCOL === 'mock',
  JSON.stringify(mock.serviceEnv),
);
// 🔴 mock 档**不得**下发 `SAKURA_API_BASE`：mock 下没有真 ③，这个键指向 8080 是个**假地址**
//    （真档才有 ③）。发了它，mock 下调引擎适配层会去连一个没人监听的端口 —— 症状是探测恒
//    `starting`，而报错离根因极远。本条是 R4 变异的作用点：**先有这条断言，才谈得上"它能变红"**。
check(
  'P-mock-8b mock 档**不下发** `SAKURA_API_BASE`（没有真 ③ ⇒ 那是个没人监听的假地址）',
  !('SAKURA_API_BASE' in (mock.serviceEnv || {})) && 'SAKURA_API_BASE' in (real.serviceEnv || {}),
  `mock 键=[${Object.keys(mock.serviceEnv || {}).join(',')}] real 键=[${Object.keys(real.serviceEnv || {}).join(',')}]`,
);

// ---------------------------------------------------------------- real 专属
check(
  'P-real-9 engine 是 `python main.py`（cwd=src/server，平级 import 决定不能写成 -m server.main）',
  // 认 `.exe`：Windows 上 venv 的可执行是 `python.exe`（`config.enginePython`），POSIX 才是 `python`。
  // 写死 `/python$/` 会在 Windows 假红（本机即踩），而它要表达的其实是"可执行属于 python 家族"。
  /python(\.exe)?$/.test(real.engine.cmd[0]) && real.engine.cmd[1] === 'main.py',
  real.engine.cmd.slice(0, 2).join(' '),
);
check(
  'P-real-10 engine.cwd 就是 config.engineServerDir（src/server），且与 src/ 不是同一个目录',
  real.engine.cwd?.endsWith(path.join('src', 'server')) && real.engine.cwd !== path.resolve(real.engine.cwd, '..'),
  real.engine.cwd,
);
check(
  'P-real-11 engine 的三重判定与 `probeEngine()` 同源：tcp(port) + POST /queue-size + tcp(port+1)',
  JSON.stringify(real.engine.probes.map((p) => (p.kind === 'tcp' ? `tcp:${p.port}` : `${p.method} ${p.path}`)))
    === JSON.stringify([
      `tcp:${real.engine.probes[0].port}`,
      'POST /queue-size',
      `tcp:${real.engine.probes[0].port + 1}`,
    ]),
  JSON.stringify(real.engine.probes),
);
check(
  'P-real-12 env 打的是**差量**（不含 process.env 复制品）—— Rust 只该设这几个键',
  !('PATH' in real.engine.env) && !('HOME' in real.engine.env) && 'SAKURA_API_BASE' in real.engine.env,
  JSON.stringify(real.engine.env),
);
check(
  'P-real-13 llm 是 llama-server，且 `--port` 与 serviceEnv 的 SAKURA_API_BASE 端口一致（否则引擎找不到 ③）',
  // 认 `.exe`：Windows 上 `defaultLlmServerBin()` 给的是 `llama-server.exe`，POSIX 是 `llama-server`。
  /llama-server(\.exe)?$/.test(real.llm.cmd[0])
    && real.serviceEnv?.SAKURA_API_BASE === `http://127.0.0.1:${real.llm.probes[0].port}/v1`,
  `${real.llm.cmd[0]} | ${real.serviceEnv?.SAKURA_API_BASE}`,
);
check(
  'P-real-14 三种进程类型齐备：node(服务由 Rust 拼) / python 可执行 / llama-server',
  /python(\.exe)?$/.test(real.engine.cmd[0]) && /llama-server(\.exe)?$/.test(real.llm.cmd[0]),
  `engine=${path.basename(real.engine.cmd[0])} llm=${path.basename(real.llm.cmd[0])}`,
);
check(
  'P-real-15 外部二进制标了 watch（要经 child-watch 包一层）—— 否则主进程被强杀后它们变孤儿（E11）',
  real.engine.watch === true && real.llm.watch === true,
  `engine.watch=${real.engine.watch} llm.watch=${real.llm.watch}`,
);
check(
  'P-mock-15b mock 侧**不**标 watch：那两个替身是我们自己的 Node 进程，内部已装父死看管（少一层进程）',
  !mock.engine.watch && !mock.llm.watch,
  `engine.watch=${mock.engine.watch} llm.watch=${mock.llm.watch}`,
);
check(
  'P-real-16 真引擎探针预算 ≥ 120s（python import torch + 读权重远超默认 20s，否则"还在加载"被误判成"起不来"）',
  real.engine.probe_timeout_ms >= 120_000 && real.llm.probe_timeout_ms >= 120_000,
  `engine=${real.engine.probe_timeout_ms}ms llm=${real.llm.probe_timeout_ms}ms`,
);

// ---------------------------------------------------------------- S4：③ 的归属权
//
// S4 起 ③ 由 box-service 拉起（《04》§9.1：Tier1 空闲卸载的实现方是 box-service）。
// 配方里仍带着 ③ 的完整命令（供 E1 打印快照），但**归属字段必须是 service** ——
// 若它退回 `manager`/缺省，Rust 会照旧 spawn，于是两个 llama-server 抢同一个 8080。
check(
  'P-llm-1 ③ 的 `owner` 是 `service`（两种模式都是）—— 退回 manager 会让 Rust 与 box-service 抢 8080',
  mock.llm.owner === 'service' && real.llm.owner === 'service',
  `mock=${mock.llm.owner} real=${real.llm.owner}`,
);
check(
  'P-llm-2 归属虽是 service，**配方本身仍完整**（cmd/probes/watch 一个不少）—— 少了它 E1 快照会悄悄缩水',
  mock.llm.cmd?.length >= 2 && mock.llm.probes?.length >= 2
    && real.llm.cmd?.length >= 2 && real.llm.probes?.length >= 2
    && typeof real.llm.watch === 'boolean' && typeof mock.llm.watch === 'boolean',
  `mock.cmd=${mock.llm.cmd?.length} mock.probes=${mock.llm.probes?.length} real.watch=${real.llm.watch}`,
);

// 顺带确认：取配方**不该**顺手写 state/token（只读操作不该有落盘副作用）。
// 用一个**全新的空 state 目录**取证：若真去 ensureToken()，那里就会多出 token 文件。
// （目录建在系统临时区，不落仓库、不需要清理代码。）
// 🔴 A3b 之前这条验的是「node 脚本 import config.mjs 会不会触发 ensureToken()」；
//    Rust 侧压根不读 state 目录，所以这条现在验的是「Rust 取配方不落盘」—— 同一条断言，
//    **换了一个真正需要它的人**：若日后有人图省事在 `build_launch_plan` 里读设置文件，
//    这条会立刻红。
const probeState = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-launch-plan-'));
await run(RUST_BIN, ['--print-launch-plan', 'mock'], {
  MIAO_STATE_DIR: probeState,
  MIAO_NODE_EXEC: process.execPath,
});
const strayFiles = fs.readdirSync(probeState);
check(
  'P-15 打印配方无落盘副作用（不写 state/token）',
  !strayFiles.includes('token'),
  strayFiles.length ? `意外产物：${strayFiles.join(',')}` : 'state 目录仍为空',
);

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);

// ------------------------------------------------------------------ 反证轮（`--refute`）
//
// 🔴 为什么必须有：上面 24 条全是**只绿可红**的断言（读一份 JSON、比对字段）。
//    没有反证轮就无法回答"它们真的在盯着东西吗" —— 改坏实现后全绿，是这类断言最常见的失效。
//    做法：把 Rust 源码按变异改坏 → 重跑 → 对应断言**必须变红** → 按字节还原。
const REFUTE = process.argv.includes('--refute');
const ENGINE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine.rs');

const MUTATIONS = [
  {
    id: 'R1',
    name: 'mock 档的 ③ 改回真档（resolve_llm_launch_for 的分支传反）⇒ P-mock-6 红',
    find: '    if real {\n        resolve_real_llm_launch(o)\n    } else {\n        Ok(resolve_mock_llm_launch(o))\n    }',
    replace: '    if real {\n        Ok(resolve_mock_llm_launch(o))\n    } else {\n        resolve_real_llm_launch(o)\n    }',
    // ⚠️ 只有 P-mock-6 会红：结构类断言（P-mock-1「字段齐备」）**照样通过** ——
    //    返回的仍是一份"完整"的配方，只是内容成了真档。这正是本仓库反复吃的那类教训：
    //    **形状断言抓不到"内容错了但形状对"**，必须有一条直接查产物路径/标记的断言。
    expect: ['P-mock-6'],
  },
  {
    id: 'R2',
    name: 'env 不压差量（退化成整份进程环境）⇒ P-real-12 红',
    find: '            !(same && same_ci)\n',
    replace: '            let _ = (same, same_ci);\n            true\n',
    expect: ['P-real-12'],
  },
  {
    id: 'R3',
    name: '真档不再标 watch（E11 的包层消失）⇒ P-real-15 红',
    find: '        watch: if real { Some(true) } else { None },\n        probe_timeout_ms: if real { Some(REAL_PROBE_TIMEOUT_MS) } else { None },',
    replace: '        watch: None,\n        probe_timeout_ms: if real { Some(REAL_PROBE_TIMEOUT_MS) } else { None },',
    expect: ['P-real-15'],
  },
  {
    id: 'R4',
    name: 'mock 档也下发 SAKURA_API_BASE（指向没有真 ③ 的假地址）⇒ P-mock-8b 红',
    find: '    if real {\n        service_env.insert(\n            "SAKURA_API_BASE".to_string(),',
    replace: '    if true {\n        service_env.insert(\n            "SAKURA_API_BASE".to_string(),',
    expect: ['P-mock-8b'],
  },
  {
    id: 'R5',
    name: '③ 的归属退回 manager（Rust 会与 box-service 抢同一个 8080）⇒ P-llm-1 红',
    find: '            owner: LLM_OWNER,',
    replace: '            owner: "manager",',
    expect: ['P-llm-1'],
  },
  {
    id: 'R6',
    name: 'mock 档的探针预算压回默认 20s（"还在加载"被误判成"起不来"）⇒ P-real-16 红',
    find: 'const REAL_PROBE_TIMEOUT_MS: u64 = 240_000;',
    replace: 'const REAL_PROBE_TIMEOUT_MS: u64 = 20_000;',
    expect: ['P-real-16'],
  },
];

/** CRLF 工作区：锚点按 LF 写，落盘前折算成目标文件实际的换行。 */
function eolOf(t) {
  return t.includes('\r\n') ? '\r\n' : '\n';
}
function locate(txt, find) {
  if (txt.includes(find)) return find;
  const alt = find.split('\n').join(eolOf(txt));
  return txt.includes(alt) ? alt : null;
}

if (REFUTE) {
  const original = fs.readFileSync(ENGINE_RS, 'utf8');
  let allRed = true;
  const greens = new Map(results.filter((r) => r.ok).map((r) => [r.id, r.ok]));
  for (const m of MUTATIONS) {
    const anchor = locate(original, m.find);
    if (!anchor) {
      console.log(`  ✗ ${m.id} 变异锚没找到（源码已变形，先更新本变异）`);
      allRed = false;
      continue;
    }
    fs.writeFileSync(ENGINE_RS, original.replace(anchor, m.replace));
    // 重编译并重跑（只取失败集合；子进程用异步 spawn，EBUSY 安全）
    const out = await new Promise((resolve, reject) => {
      const c = spawn('cargo', ['build', '--bin', 'boxsvc'], {
        cwd: path.join(ROOT, 'app', 'src-tauri'),
        env: { ...process.env, CARGO_INCREMENTAL: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let so = '';
      let se = '';
      c.stdout.on('data', (d) => (so += d));
      c.stderr.on('data', (d) => (se += d));
      c.on('error', reject);
      c.on('close', () => resolve(so + se));
    });
    if (/^error(\[|:)/m.test(out)) {
      console.log(`  ✗ ${m.id} 变异后**编译失败**（这不算"变红"，是变异写坏了代码）`);
      allRed = false;
      fs.writeFileSync(ENGINE_RS, original);
      continue;
    }
    const rerun = await new Promise((resolve) => {
      const c = spawn(process.execPath, [import.meta.filename], {
        env: { ...process.env, MIAO_NODE_EXEC: process.execPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let so = '';
      c.stdout.on('data', (d) => (so += d));
      c.stderr.on('data', () => {});
      c.on('close', () => resolve(so));
    });
    const reds = m.expect.filter((id) => new RegExp(`✗ ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(rerun));
    const ok = reds.length === m.expect.length;
    if (!ok) allRed = false;
    console.log(`  ${ok ? '✓' : '✗'} ${m.id} ${m.name} → ${ok ? '按预期变红' : `**没红**（只红了 ${reds.length}/${m.expect.length}）`}`);
    fs.writeFileSync(ENGINE_RS, original);
  }
  // 还原校验：字节一致才算收工
  const after = fs.readFileSync(ENGINE_RS, 'utf8');
  const restored = after === original;
  console.log(`\n还原校验：${restored ? '✓ engine.rs 字节一致' : '✗ engine.rs **已被改坏**'}`);
  // 🔴 还原后**必须重编译**：否则 `target/debug/boxsvc.exe` 还是最后一个变异（R6）编译出来的，
  //    下一轮正向跑就会读到 `probe_timeout_ms=20_000` 的坏产物而假红。
  //    「源码已还原」与「产物已还原」是两件事 —— 字节校验只能证明前者。
  if (restored) {
    await new Promise((resolve, reject) => {
      const c = spawn('cargo', ['build', '--bin', 'boxsvc'], {
        cwd: path.join(ROOT, 'app', 'src-tauri'),
        env: { ...process.env, CARGO_INCREMENTAL: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let se = '';
      c.stderr.on('data', (d) => (se += d));
      c.on('error', reject);
      c.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`还原后重编译失败（产物仍是坏的）：${se.slice(0, 400)}`)),
      );
    });
    console.log('还原重编译：✓ 产物已与源码同步');
  }
  console.log(`\nREFUTE: ${MUTATIONS.filter(() => allRed).length}/${MUTATIONS.length} 条变异按预期变红${allRed ? '' : '（有不红的）'}`);
  process.exit(allRed && restored ? 0 : 1);
}

console.log('S2 启动配方契约断言（Rust --print-launch-plan → ServiceManager）\n');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} — ${r.detail}`);
console.log(`\n通过 ${results.length - failed.length} / 失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
