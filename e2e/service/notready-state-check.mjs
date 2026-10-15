#!/usr/bin/env node
/**
 * D1 · 「运行时未装配」独立成态钉子 —— 「缺引擎时说人话，而不是让人对着 L1 转圈」
 * =============================================================================
 * 对应计划文档 D1：`GET /engine/status` 与 `service_status` 各带一个 `runtime` 块；
 * `NotReadyScreen.tsx` 增一条与 L1–L4 **并列**的分支（**不混进 L1 失败**）。
 *
 * ## 它钉的是什么
 * ① 服务侧真的把运行时就绪检测发出去了（`/engine/status` 的 `runtime` 块 + Tauri 命令的
 *    `ServiceStatus.runtime`）—— **两条链路都要有**：HTTP 那条在"服务起来了但引擎没装"时
 *    能用，进程内那条在"一个子进程都没起"（D6 闸门）时仍能答；
 * ② 界面上那四句 L1–L4 文案**逐字未改**（冻结字面量，取自《02》§3 /《09》§6.1）；
 * ③ 新分支与 L1–L4 **并列而不是混进去**：`summaryOf` 里不许出现新分支的措辞，
 *    且它必须在时间线之前 `return`（否则用户还是先看到一条走到 L1 就停的进度条）；
 * ④ 「约 X GB」的数字**不是写死的**：界面读数必须来自服务端的 `requiredBytes`
 *    （写死的话，清单加一条权重就会让界面开始撒谎，且没人会发现）。
 *
 * ## 反证轮（--refute）
 * - M1 改 L1 一句文案 ⇒ G4 红（"逐字未改"是钉的，不是口号）。
 * - M2 把新分支的条件改成 `if (false)` ⇒ G5 红（分支在，但永远不会走）。
 * - M3 把新分支的标题塞进 `summaryOf` ⇒ G6 红（这就是"混进 L1 失败"）。
 * - M4 把 GB 数字写死 ⇒ G8 红。
 * - M5 删 `service.rs` 里 `runtime` 的赋值 ⇒ G2 红（CLI 有、产品没接上）。
 * 全部改源码、跑完**按字节还原**（无 Rust 变异 ⇒ 不需要重编译）。
 *
 * 用法：node e2e/service/notready-state-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { killTree, RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
const TOKEN = 'a'.repeat(64);
const SELF = fileURLToPath(import.meta.url);
const SERVICE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'service', 'mod.rs');
const STATE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'state.rs');
const IPC_TS = path.join(REPO_ROOT, 'src', 'ipc.ts');
const NOTREADY_TSX = path.join(REPO_ROOT, 'src', 'screens', 'NotReadyScreen.tsx');
const APP_TSX = path.join(REPO_ROOT, 'src', 'App.tsx');

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

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

/** 起一个 mangasvc（mock 档）并等 `MIAO_READY`。 */
function startService(extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-notready-'));
  const child = spawn(RUST_BIN, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_ROOT: path.join(tmp, 'root'),
      MIAO_STATE_DIR: path.join(tmp, 'state'),
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => {
      killTree(child);
      reject(new Error('mangasvc 15s 内未就绪'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({ port: JSON.parse(m[1]).port, kill: () => killTree(child) });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`mangasvc 退出 ${code}：${buf.slice(0, 500)}`));
    });
  });
}

/** 从 `sig` 起截到**顶格的 `}`**（函数体结束）—— 用来把某个函数的源码单独拿出来看。 */
function sliceFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const rest = src.slice(i);
  const m = /\n\}\r?\n/.exec(rest);
  return m ? rest.slice(0, m.index + m[0].length) : rest;
}

// ------------------------------------------------------------------ G0：HTTP 链路（真起一次服务）
{
  const svc = await startService({});
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/v1/engine/status`, { headers: { 'x-box-token': TOKEN } });
    const body = await res.json();
    check(
      'G0 GET /engine/status 带 `runtime` 块（五项 + requiredBytes）与 `models.files`（D8 逐条）',
      res.status === 200 &&
        Array.isArray(body?.runtime?.items) &&
        body.runtime.items.length === 5 &&
        typeof body.runtime.requiredBytes === 'number' &&
        Array.isArray(body?.models?.files) &&
        body.models.files.length > 0,
      {
        status: res.status,
        runtimeItems: body?.runtime?.items?.length,
        requiredBytes: body?.runtime?.requiredBytes,
        files: body?.models?.files?.length,
      },
    );
    // 运行时就绪检测的每一项仍带绝对路径（B2 的验收在**新出口**上同样成立）
    const badPath = (body?.runtime?.items ?? []).filter((i) => !i.path || !i.detail.includes(i.path)).map((i) => i.id);
    check('G0b 新出口上的五项判据仍带绝对路径（不是"另写一套"）', badPath.length === 0, badPath);
  } finally {
    svc.kill();
  }
}

// ------------------------------------------------------------------ G1~G3：两条链路都接了线
{
  const svc = fs.readFileSync(SERVICE_RS, 'utf8');
  const state = fs.readFileSync(STATE_RS, 'utf8');
  const ipc = fs.readFileSync(IPC_TS, 'utf8');

  check(
    'G1 `service.rs::StatusView` 有 `runtime` 字段（进程内那条链路的载体）',
    /pub\s+runtime:\s*serde_json::Value/.test(svc),
    null,
  );

  check(
    'G2 `view_of` 里给 `runtime` 赋了 `runtime_probe::runtime_view()`（同一个 probe，不是另算一份）',
    /runtime:\s*mangasvc::engine::runtime_probe::runtime_view\(\)/.test(svc),
    null,
  );

  check(
    'G3 `ipc.ts::ServiceStatus` 有 `runtime: RuntimeProbe`（TS 侧没漏同步）',
    /runtime:\s*RuntimeProbe;/.test(ipc),
    null,
  );

  check(
    'G3b `/engine/status`（state.rs）也带 `runtime`，且用的是同一个 `runtime_view()`',
    /"runtime":\s*super::runtime_probe::runtime_view\(\)/.test(state),
    null,
  );
}

// ------------------------------------------------------------------ G4~G9：界面
const tsx = fs.readFileSync(NOTREADY_TSX, 'utf8');
{
  // G4：L1–L4 四句**逐字**（冻结字面量 —— 取自《02》§3 /《09》§6.1，不是从源码抄的）
  const L_TEXT = [
    ['L1', '正在检查运行环境'],
    ['L2', '正在准备翻译模型'],
    ['L3', '正在预热'],
    ['L4', '首张稍慢，后续加快'],
  ];
  const wrong = L_TEXT.filter(([id, text]) => !tsx.includes(`{ id: '${id}', text: '${text}' }`));
  check('G4 L1–L4 四句文案逐字未改（冻结字面量）', wrong.length === 0, wrong);

  // G5：新分支的**判据**与**标题**都在，且是真的会走（不是 `if (false)`）
  check(
    'G5 「运行时未装配」分支存在且判据可走（real 档 + 未就绪 + 非 running）',
    /const runtimeUnready = status\?\.mode === 'real' && !!rt && !rt\.ready;/.test(tsx) &&
      /if \(runtimeUnready && rt && state !== 'running'\) \{/.test(tsx) &&
      tsx.includes('需要先安装翻译引擎'),
    null,
  );

  // G6：**不混进 L1 失败** —— `summaryOf`（L1 那条链路的措辞源）里不许出现新分支的话
  const sum = sliceFn(tsx, 'function summaryOf(');
  check(
    'G6 新分支的措辞不在 `summaryOf` 里（与 L1–L4 并列，不混进 L1 失败）',
    sum.length > 0 && !sum.includes('需要先安装翻译引擎'),
    { summaryLen: sum.length },
  );

  // G7：它必须在**时间线之前** return —— 否则用户仍会先看到一条走到 L1 就停的进度条
  const atBranch = tsx.indexOf("if (runtimeUnready && rt && state !== 'running')");
  const atTimeline = tsx.indexOf('{STAGES.map((s, i) =>');
  check(
    'G7 新分支在时间线渲染之前 return（用户不会先看到卡住的进度条）',
    atBranch > 0 && atTimeline > 0 && atBranch < atTimeline,
    { atBranch, atTimeline },
  );

  // G8：数字**不是写死的** —— 读数来自服务端 `requiredBytes`，且**代码里**不许出现字面量 GB。
  // ⚠️ 只查代码、不查注释：`STAGES` 上方那句注释里举例写了「2.1/4.6 GB」（说明为什么
  //    不显示字节进度），那是**说明**不是**值** —— 把注释一起算进来就成了误报。
  const code = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gbLiteral = /(?<![\w.$])\d+(\.\d+)?\s*GB/.test(code);
  check(
    'G8 「约 X GB」来自服务端 requiredBytes，代码里没有写死的 GB 数字',
    tsx.includes('rt.requiredBytes') && !gbLiteral,
    { gbLiteral, usesServer: tsx.includes('rt.requiredBytes') },
  );

  // G9：缺项**逐项**列出来（detail 带绝对路径、fix 给装法）—— 不是一句"缺东西"
  check(
    'G9 缺项逐项渲染（`it.detail` + `it.fix`），不是笼统一句话',
    tsx.includes('{it.detail}') && tsx.includes('{it.fix}'),
    null,
  );
}

// ------------------------------------------------------------------ G10：入口接上
{
  const app = fs.readFileSync(APP_TSX, 'utf8');
  check(
    'G10 `App.tsx` 把指引入口传给未就绪屏（onOpenGuide → 设置页）',
    /onOpenGuide=\{\(\) => setScreen\('settings'\)\}/.test(app),
    null,
  );
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  function mutateFile(file, from, to) {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：${file}\n  ${from.slice(0, 80)}`);
    fs.writeFileSync(file, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(file, original);
  }

  const runForward = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        out += d;
      });
      c.on('error', () => resolve({ code: -1, out }));
      c.on('close', (code) => resolve({ code, out }));
    });

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const red = (r, name) => r.code !== 0 && hasRed(r.out, name);

  const cases = [
    {
      id: 'M1',
      what: 'L1 文案被改了一个字',
      mutate: () => mutateFile(NOTREADY_TSX, "text: '正在检查运行环境'", "text: '正在检查运行环境…'"),
      expect: 'G4',
    },
    {
      id: 'M2',
      what: '新分支条件改成 if (false)（分支在，但永远不走）',
      mutate: () => mutateFile(NOTREADY_TSX, "if (runtimeUnready && rt && state !== 'running') {", 'if (false) {'),
      expect: 'G5',
    },
    {
      id: 'M3',
      what: '把新分支的标题塞进 summaryOf（这就是"混进 L1 失败"）',
      mutate: () => mutateFile(NOTREADY_TSX, "title: '本地服务没能起来',", "title: '需要先安装翻译引擎',"),
      expect: 'G6',
    },
    {
      id: 'M4',
      what: 'GB 数字写死成 6.9',
      mutate: () =>
        mutateFile(NOTREADY_TSX, '（模型资产约 ${(rt.requiredBytes / GIB).toFixed(1)} GB）', '（模型资产约 6.9 GB）'),
      expect: 'G8',
    },
    {
      id: 'M5',
      what: 'service.rs 里删掉 runtime 的赋值（CLI 有、产品没接上）',
      mutate: () => mutateFile(SERVICE_RS, '        runtime: mangasvc::engine::runtime_probe::runtime_view(),\n', ''),
      expect: 'G2',
    },
  ];

  for (const c of cases) {
    const restore = c.mutate();
    try {
      const r = await runForward();
      check(`${c.id} ${c.what} ⇒ ${c.expect} 红`, red(r, c.expect), { code: r.code });
    } finally {
      restore();
    }
  }

  // 收尾：源码逐字节还原
  {
    const bad = [];
    if (!fs.readFileSync(NOTREADY_TSX, 'utf8').includes("text: '正在检查运行环境'"))
      bad.push('NotReadyScreen.tsx 残留 M1');
    if (!fs.readFileSync(NOTREADY_TSX, 'utf8').includes('需要先安装翻译引擎')) bad.push('NotReadyScreen.tsx 残留 M3');
    if (!fs.readFileSync(SERVICE_RS, 'utf8').includes('runtime: mangasvc::engine::runtime_probe::runtime_view(),'))
      bad.push('service.rs 残留 M5');
    check('R1 变异收尾：三处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
