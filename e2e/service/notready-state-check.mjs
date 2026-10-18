#!/usr/bin/env node
/**
 * D1 · 「运行时未装配」独立成态钉子 —— 「缺引擎时说人话，而不是让人对着 L1 转圈」
 * =============================================================================
 * 对应计划文档 D1：`GET /engine/status` 与 `service_status` 各带一个 `runtime` 块；
 * `NotReadyScreen.tsx` 增一条与装配时间线**并列**的分支（**不混进服务失败**）。
 *
 * ⚠️ **D-231⑥ 起这条门也跟着换了轴**：原先 G4 冻结的是 L1–L4「服务启动分层」那四句，
 *    现已退役；G4 冻结的是**装配四段**（环境准备 / 运行环境装配 / 本地引擎装配 / 就绪），
 *    G4b 另钉「旧表真的删干净了」。`status.phase` 本身**保留不动**（属 `/engine/status`
 *    契约，被 `check:autostart` / `check:contract` 断言），退役的只是「前端拿它当进度事实源」。
 *
 * ## 它钉的是什么
 * ① 服务侧真的把运行时就绪检测发出去了（`/engine/status` 的 `runtime` 块 + Tauri 命令的
 *    `ServiceStatus.runtime`）—— **两条链路都要有**：HTTP 那条在"服务起来了但引擎没装"时
 *    能用，进程内那条在"一个子进程都没起"（D6 闸门）时仍能答；
 * ② 界面上装配四段的四句**逐字未改**（冻结字面量，D-231⑥）；
 * ③ 新分支与装配时间线**并列而不是混进去**：`summaryOf` 里不许出现新分支的措辞、
 *    也不许再按 `phase === 'L3'` 分支，且它必须在时间线之前 `return`；
 * ④ 「约 X GB」的数字**不是写死的**：界面读数必须来自服务端的 `requiredBytes`
 *    （写死的话，清单加一条权重就会让界面开始撒谎，且没人会发现）。
 *
 * ## 反证轮（--refute）
 * - M1 改四段里某一句文案一字 ⇒ G4 红（"逐字未改"是钉的，不是口号）。
 * - M2 把新分支的条件改成 `if (false)` ⇒ G5 红（分支在，但永远不会走）。
 * - M3 把新分支的标题塞进 `summaryOf` ⇒ G6 红（这就是"混进服务失败"）。
 * - M4 把 GB 数字写死 ⇒ G8 红。
 * - M5 删 `service.rs` 里 `runtime` 的赋值 ⇒ G2 红（CLI 有、产品没接上）。
 * - M6 四段进度丢掉 `download.step` ⇒ G11 红（永远停在第 1 段）。
 * - M7 引导页不再画时间线 ⇒ G12 红（同一件事两个样子）。
 * - M8 翻译屏装配件不再透传 `download` ⇒ G10b 红（四段永远全灰）。
 * - M9 把退役的旧阶段表塞回来 ⇒ G4b 红（"退役"必须是真的删干净）。
 * - M10 缺项改回 `active` ⇒ G14 红（服务没启动时假装「正在装配」）。
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
const IPC_TS = path.join(REPO_ROOT, 'src', 'ipc', 'index.ts');
const NOTREADY_TSX = path.join(REPO_ROOT, 'src', 'screens', 'manga', 'NotReadyScreen.tsx');
const ASSEMBLY_TS = path.join(REPO_ROOT, 'src', 'screens', 'manga', 'assembly.ts');
// B1 起未就绪屏（含它的入口）住在**翻译屏装配件**里，App 只持有 setScreen 本身
const TRANSLATE_PANE = path.join(REPO_ROOT, 'src', 'router', 'panes', 'TranslatePane.tsx');

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
      'G0 GET /engine/status 带 `runtime` 块（七项 + requiredBytes）与 `models.files`（D8 逐条）',
      res.status === 200 &&
        Array.isArray(body?.runtime?.items) &&
        body.runtime.items.length === 7 &&
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
    check('G0b 新出口上的七项判据仍带绝对路径（不是"另写一套"）', badPath.length === 0, badPath);

    // D-233：分档块（五段流程的数据源）必须与七项**共存**，不能取代 ready。
    const sets = body?.runtime?.sets ?? {};
    const setOk = ['visual', 'translation', 'llm', 'runtime'].every(
      (k) => sets[k] && typeof sets[k].ready === 'boolean' && typeof sets[k].totalBytes === 'number',
    );
    check('G0c `runtime.sets` 四个分档共存（visual / translation / llm / runtime），带 ready 与字节', setOk, {
      keys: Object.keys(sets),
      ready: body?.runtime?.ready,
    });
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
const asm = fs.readFileSync(ASSEMBLY_TS, 'utf8');
{
  // G4：装配五段**逐字**（冻结字面量；D-233 由四段拆成五段，旧结论见 D-231⑥）
  const PHASE_TEXT = [
    ['prepare', '环境准备'],
    ['runtime', '运行环境装配'],
    ['visual', '视觉模型装配'],
    ['llm', 'LLM 翻译模型装配'],
    ['ready', '就绪'],
  ];
  const wrong = PHASE_TEXT.filter(([id, text]) => !asm.includes(`{ id: '${id}', text: '${text}' }`));
  check('G4 装配五段文案逐字未改（冻结字面量；D-233 拆出 visual / llm）', wrong.length === 0, wrong);

  // G4b：**退役**是真的删干净了，而不是"新表在旁边、旧表还留着"
  const retired = ['STARTUP_COUNT', 'PHASE_INDEX', "id: 'L1'", "id: 'L2'", "id: 'L3'", "id: 'L4'", '首图时完成'].filter(
    (k) => tsx.includes(k) || asm.includes(k),
  );
  check(
    'G4b L1–L4 已退役（旧阶段表 / STARTUP_COUNT / PHASE_INDEX / 「首图时完成」都不在源码里）',
    retired.length === 0,
    retired,
  );

  // G5：新分支的**判据**与**标题**都在，且是真的会走（不是 `if (false)`）
  // ⚠️ 判据在 D-229 收窄成「real 档 + 运行时未就绪」：**不再看服务状态**
  //    （闸门允许 ① 在未装配时照常起，state 会是 running，而这一页恰恰那时最需要）。
  check(
    'G5 「运行时未装配」分支存在且判据可走（real 档 + 运行时未就绪；服务状态不是判据，见 D-229）',
    /const runtimeUnready = status\?\.mode === 'real' && !!rt && !rt\.ready;/.test(tsx) &&
      /if \(runtimeUnready && rt\) \{/.test(tsx) &&
      tsx.includes('需要先装配本地引擎'),
    null,
  );

  // G6：**不混进 L1 失败** —— `summaryOf`（服务现状的措辞源）里不许出现新分支的话
  const sum = sliceFn(tsx, 'function summaryOf(');
  check(
    'G6 新分支的措辞不在 `summaryOf` 里（与五段时间线并列，不混进服务失败）',
    sum.length > 0 && !sum.includes('需要先装配本地引擎'),
    { summaryLen: sum.length },
  );

  // G6b：`summaryOf` 也不许再拿 `status.phase` 当分支（L1–L4 退役的最后一处残留）
  check(
    "G6b `summaryOf` 不再按 `phase === 'L3'` 分支（服务现状与装配进度是两条轴，混进同一句话就自相矛盾）",
    sum.length > 0 && !sum.includes("'L3'") && !/phase/.test(sum),
    { hasPhase: /phase/.test(sum) },
  );

  // G7：它必须在**时间线之前** return —— 否则用户仍会先看到一条走到 L1 就停的进度条
  const atBranch = tsx.indexOf('if (runtimeUnready && rt) {');
  const atTimeline = tsx.indexOf('<AssemblyTimeline notes={notes}');
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

  // G11（D-233）：五段进度**只**来自 `download.step` + `runtime.sets/items`；不再取 `status.phase`。
  //     `ready` 由判据收尾而不是等第五个事件 —— 否则"装配跑完了但判据不过"会永远停在第 4 段。
  check(
    'G11 五段进度只来自 `download.step` + 探针分档（`assemblyNotes`），不再取 `status.phase`',
    /assemblyNotes\(status, download\)/.test(tsx) &&
      /STEP_INDEX\[download\.step\]/.test(asm) &&
      /notes\[4\] = 'done'/.test(asm),
    null,
  );

  // G12：引导页与时间线分支**共用**同一个 `AssemblyTimeline`。
  //     两处各画各的 ⇒ 同一件事在两个页面显示成两个样子（段数、当前段、状态词各不相同）。
  const guideTl = tsx.indexOf('<AssemblyTimeline notes={notes}', atBranch);
  const timelineTl = tsx.lastIndexOf('<AssemblyTimeline notes={notes}');
  check(
    'G12 引导页与「已装配但服务没起来」两处共用同一个 `AssemblyTimeline`（不是各画各的）',
    guideTl > atBranch && timelineTl > guideTl,
    { guideTl, timelineTl },
  );

  // G13：下载进行中时引导页顶部落一句"当前处于第几段"（用户点完按钮最想知道的就是这句）
  check(
    'G13 引导页在下载进行中时显示「当前处于第 N 段」（且只在真的在下载时说）',
    tsx.includes('当前处于第') && /downloading && stepLabel/.test(tsx),
    null,
  );

  // G14（A 口径）：缺项在没有下载/启动活动时只能是 `waiting`，不能假装「进行中」；
  //      服务 stopped 时顶部必须说明「下面是磁盘装配状态」，否则 1–2 段打勾会被读成
  //      「本次启动已经走到第二段」。
  check(
    'G14 缺项无实际活动时为 `waiting`，且 stopped 时说明「磁盘装配状态」',
    /notes\[1\] = 'waiting'/.test(asm) &&
      /notes\[2\] = 'waiting'/.test(asm) &&
      /notes\[3\] = 'waiting'/.test(asm) &&
      tsx.includes('本地服务未启动；下面是磁盘装配状态'),
    {
      runtime: /notes\[1\] = 'waiting'/.test(asm),
      visual: /notes\[2\] = 'waiting'/.test(asm),
      llm: /notes\[3\] = 'waiting'/.test(asm),
      caption: tsx.includes('本地服务未启动；下面是磁盘装配状态'),
    },
  );
}

// ------------------------------------------------------------------ G10：入口接上
{
  const pane = fs.readFileSync(TRANSLATE_PANE, 'utf8');
  check(
    'G10 翻译屏装配件把指引入口传给未就绪屏（onOpenGuide → 设置页）',
    /onOpenGuide=\{\(\) => setScreen\('settings'\)\}/.test(pane),
    null,
  );
  check(
    'G10b 翻译屏装配件把 `download` 透传给未就绪屏（四段进度的唯一事实源；壳层本来就有它）',
    /download=\{download\}/.test(pane) && /\bdownload,\s*\n\s*startService,/.test(pane),
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
      what: '五段里某一段的文案被改了一个字',
      mutate: () => mutateFile(ASSEMBLY_TS, "text: '环境准备'", "text: '环境准备…'"),
      expect: 'G4',
    },
    {
      id: 'M2',
      what: '新分支条件改成 if (false)（分支在，但永远不走）',
      mutate: () => mutateFile(NOTREADY_TSX, 'if (runtimeUnready && rt) {', 'if (false) {'),
      expect: 'G5',
    },
    {
      id: 'M3',
      what: '把新分支的标题塞进 summaryOf（这就是"混进 L1 失败"）',
      mutate: () => mutateFile(NOTREADY_TSX, "title: '本地服务没能起来',", "title: '需要先装配本地引擎',"),
      expect: 'G6',
    },
    {
      id: 'M4',
      what: 'GB 数字写死成 6.9（清单加一条权重后界面就开始撒谎）',
      /*
       * 锚点跟着实现走：总量由 `totalText` 从 `rt.requiredBytes` 换算，
       * "写死"的形态因此是**把拼装处换成字面量**。
       */
      mutate: () =>
        mutateFile(
          NOTREADY_TSX,
          'const totalText = rt.requiredBytes > 0 ? formatBytes(rt.requiredBytes) : null;',
          "const totalText = '6.9 GB';",
        ),
      expect: 'G8',
    },
    {
      id: 'M5',
      what: 'service.rs 里删掉 runtime 的赋值（CLI 有、产品没接上）',
      mutate: () => mutateFile(SERVICE_RS, '        runtime: mangasvc::engine::runtime_probe::runtime_view(),\n', ''),
      expect: 'G2',
    },
    {
      id: 'M6',
      what: '五段进度丢掉 `download.step`（永远停在第 1 段）',
      mutate: () => mutateFile(NOTREADY_TSX, 'assemblyNotes(status, download)', 'assemblyNotes(status, null)'),
      expect: 'G11',
    },
    {
      id: 'M7',
      what: '引导页不再画时间线（只剩另一处画 ⇒ 同一件事两个样子）',
      mutate: () =>
        mutateFile(
          NOTREADY_TSX,
          '<AssemblyTimeline notes={notes} detail={detail} extra={extra} />',
          '<div className="nr-guide-note">装配分五段。</div>',
        ),
      expect: 'G12',
    },
    {
      id: 'M8',
      what: '翻译屏装配件不再透传 `download`（五段拿不到段号，五段永远全灰）',
      mutate: () => mutateFile(TRANSLATE_PANE, '        download={download}\n', ''),
      expect: 'G10b',
    },
    {
      id: 'M9',
      what: '把退役的旧阶段表（`id: L1` 那张）塞回来（新旧两表并存 = "退役"是假的）',
      mutate: () =>
        mutateFile(
          ASSEMBLY_TS,
          'export const ASSEMBLY_PHASES: AssemblyPhase[] = [',
          "export const STAGES = [{ id: 'L1', text: '正在检查运行环境' }];\nexport const ASSEMBLY_PHASES: AssemblyPhase[] = [",
        ),
      expect: 'G4b',
    },
    {
      id: 'M10',
      what: '缺项改回 `active`（服务没启动时假装「正在装配」）',
      mutate: () => mutateFile(ASSEMBLY_TS, "notes[2] = 'waiting';", "notes[2] = 'active';"),
      expect: 'G14',
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
    if (!fs.readFileSync(ASSEMBLY_TS, 'utf8').includes("text: '环境准备'")) bad.push('assembly.ts 残留 M1');
    if (!fs.readFileSync(NOTREADY_TSX, 'utf8').includes('需要先装配本地引擎')) bad.push('NotReadyScreen.tsx 残留 M3');
    if (!fs.readFileSync(NOTREADY_TSX, 'utf8').includes('assemblyNotes(status, download)'))
      bad.push('NotReadyScreen.tsx 残留 M6');
    if (
      !fs.readFileSync(NOTREADY_TSX, 'utf8').includes('<AssemblyTimeline notes={notes} detail={detail} extra={extra}')
    )
      bad.push('NotReadyScreen.tsx 残留 M7');
    if (!fs.readFileSync(ASSEMBLY_TS, 'utf8').includes('export const ASSEMBLY_PHASES: AssemblyPhase[] = ['))
      bad.push('assembly.ts 残留 M9');
    if (!fs.readFileSync(ASSEMBLY_TS, 'utf8').includes("notes[2] = 'waiting';")) bad.push('assembly.ts 残留 M10');
    if (!fs.readFileSync(TRANSLATE_PANE, 'utf8').includes('download={download}')) bad.push('TranslatePane.tsx 残留 M8');
    if (!fs.readFileSync(SERVICE_RS, 'utf8').includes('runtime: mangasvc::engine::runtime_probe::runtime_view(),'))
      bad.push('service.rs 残留 M5');
    check('R1 变异收尾：七处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
