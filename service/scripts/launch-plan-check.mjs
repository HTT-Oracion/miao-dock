#!/usr/bin/env node
/**
 * S2 启动配方契约断言 —— `service/scripts/print-launch-plan.mjs` 的输出**形状**。
 *
 * 为什么单独一套：S2 起，Rust 的 `ServiceManager` 不再自己拼命令，而是**问 JS 要配方**
 * （`print-launch-plan.mjs` → JSON）。也就是说这个 JSON 成了 Rust 与引擎侧之间的**新契约面**：
 * 字段名写错、探针少一条、cwd 指错目录，Rust 那边都会以「起不来 / 起错东西」的形式表现，
 * 且**报错信息离根因很远**。所以契约面本身要有断言。
 *
 * 只断言**结构与同源关系**，不断言"文件在不在"（那属于环境就绪，归 S0/E1 管，
 * 且 `runtimes/` 在仓库外 —— 在这里断言存在会把"环境没装"伪装成"代码有 bug"）。
 *
 * 用法：node service/scripts/launch-plan-check.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'service', 'scripts', 'print-launch-plan.mjs');

const results = [];
const check = (id, ok, detail) => results.push({ id, ok: !!ok, detail: String(detail ?? '') });

function plan(mode) {
  const out = execFileSync(process.execPath, [SCRIPT, mode], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(out);
}

const mock = plan('mock');
const real = plan('real');

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

// ---------------------------------------------------------------- real 专属
check(
  'P-real-9 engine 是 `python main.py`（cwd=src/server，平级 import 决定不能写成 -m server.main）',
  /python$/.test(real.engine.cmd[0]) && real.engine.cmd[1] === 'main.py',
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
  real.llm.cmd[0].endsWith('llama-server')
    && real.serviceEnv?.SAKURA_API_BASE === `http://127.0.0.1:${real.llm.probes[0].port}/v1`,
  `${real.llm.cmd[0]} | ${real.serviceEnv?.SAKURA_API_BASE}`,
);
check(
  'P-real-14 三种进程类型齐备：node(服务由 Rust 拼) / python 可执行 / llama-server',
  /python$/.test(real.engine.cmd[0]) && real.llm.cmd[0].endsWith('llama-server'),
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

// 顺带确认：打印配方**不该**顺手写 state/token（只读操作不该有落盘副作用）。
// 用一个**全新的空 state 目录**取证：若脚本真的去 ensureToken()，那里就会多出 token 文件。
// （目录建在系统临时区，不落仓库、不需要清理代码。）
const probeState = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-launch-plan-'));
execFileSync(process.execPath, [SCRIPT, 'mock'], {
  encoding: 'utf8',
  timeout: 30_000,
  env: { ...process.env, MIAO_STATE_DIR: probeState },
});
const strayFiles = fs.readdirSync(probeState);
check(
  'P-15 打印配方无落盘副作用（不写 state/token）',
  !strayFiles.includes('token'),
  strayFiles.length ? `意外产物：${strayFiles.join(',')}` : 'state 目录仍为空',
);

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log('S2 启动配方契约断言（print-launch-plan.mjs → Rust ServiceManager）\n');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} — ${r.detail}`);
console.log(`\n通过 ${results.length - failed.length} / 失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
