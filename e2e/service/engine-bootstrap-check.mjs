#!/usr/bin/env node
/**
 * G5 · 「本地引擎开箱即用」引导链门 —— 一键下载编排 / 阶段顺序 / 中断可续 / 百分比来源真实 / 不出现命令行字样
 * =============================================================================
 * 对应计划「开箱即用」整组。本门**不重新发明下载器**：运行时资产（Python 运行时、
 * 引擎源码、预装 site-packages）走 `runtime.manifest.json`，由既有 `boxsvc::engine::model_store`
 * 的 `ensure_models` 完成下载/校验/续传/解包；进度只来自 `--progress-log` 真实事件；
 * 中断态与续传能力由 `state.rs` 现算（盘上 `.part` 是否存在）。
 *
 * ## 为什么是 `static` 层（纯文件分析，可并行）
 * 这条门要钉的是「产品自己会下载并装配、且全程对用户零命令行」这一**事实**在源码与清单里
 * 真的存在：清单字段、端点接线、状态机、前端文案都不含命令行字样。这些都能从文件本身
 * 逐字节读出，不需要起真实服务（那是 `check:models` / `check:progress-truth` 的职责）。
 * 起服务反而会让这条门与端口竞争的服务层耦合，丧失「改一行源码就能立刻红」的灵敏度。
 *
 * ## 反证轮（--refute）
 * - M1 `engine-download.ts` 的运行态文案注入 `pip` 字样 ⇒ W5（无命令行字样）红。
 * - M2 `runtime.manifest.json` 抹掉某条的 `sha256` ⇒ W1（清单条目完整可下载）红。
 * - M3 `state.rs` 阶段映射 `stage1` 改成 `phase1` ⇒ W4（阶段顺序 stage1→stage2）红。
 * - M4 `runtime_probe.rs` 的 `FIX_SETUP` 注回 `node engine/scripts/…` ⇒ W9a 红。
 * - M5 未就绪文案抹掉产品内入口（只说缺什么）⇒ W9b 红。
 * 每条反证都按字节还原，收尾复核残留。
 *
 * ## W9 为什么必须打在 Rust 侧
 * W5/W6 只扫前端 4 个文件，而「运行时未装配」屏渲染的字符串来自
 * `boxsvc/engine/runtime_probe.rs`（经 `/engine/runtime` → `NotReadyScreen.tsx`）。
 * 文案里的 `node engine/scripts/setup-engine.mjs` 既不会被前端扫描命中、也不匹配
 * 旧版 `CLI_JARGON` 的任何前缀 ⇒ 长时间全绿而产品一直在教用户跑命令行。
 *
 * 用法：node e2e/service/engine-bootstrap-check.mjs [--refute]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);

const RUNTIME_MANIFEST = path.join(ROOT, 'engine', 'runtime.manifest.json');
const WHEELS_MANIFEST = path.join(ROOT, 'engine', 'wheels.manifest.json');
const HANDLERS_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'handlers.rs');
const STATE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine', 'state.rs');
/// W9：**Rust 侧**面向用户的未就绪文案（`fix` + 闸门消息）也要零命令行 ——
/// 前端 4 个文件干净不等于产品干净：`NotReadyScreen.tsx` 渲染的正是这里的字符串。
const RUNTIME_PROBE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine', 'runtime_probe.rs');
const ENGINE_DOWNLOAD_TS = path.join(ROOT, 'app', 'src', 'engine-download.ts');
/// W11：stage 归属的事实源。
const MODELS_MANIFEST = path.join(ROOT, 'engine', 'models.manifest.json');
/// W12：下载视图（第 1/第 2 阶段文案）。
const DOWNLOAD_PANEL_TSX = path.join(ROOT, 'app', 'src', 'screens', 'engine', 'DownloadPanel.tsx');
const UI_FILES = [
  path.join(ROOT, 'app', 'src', 'screens', 'NotReadyScreen.tsx'),
  path.join(ROOT, 'app', 'src', 'screens', 'engine', 'DownloadPanel.tsx'),
  path.join(ROOT, 'app', 'src', 'screens', 'settings', 'OnlineApiForm.tsx'),
  path.join(ROOT, 'app', 'src', 'components', 'units', 'ProgressRing.tsx'),
];

/**
 * 命令行字样（反证 M1 / W5 / W6 / W9 要抓的就是这些）—— 只钉真正的命令，不钉「命令行」这种中性叙述词。
 * 🔴 必须含 `node <脚本>` 与 `npm run <脚本>` 两种形态：历史文案是
 * 「运行 node engine/scripts/setup-engine.mjs …」「运行 npm run deps:engine …」，
 * 它们能被用户读到，却**不被**前几条命令前缀命中（W9 之前这条是盲区）。
 */
const CLI_JARGON = /npm install|npm run|pip install|python -m venv|MSVC|conda install|apt-get install|node\s+\S+\.mjs|node\s+engine\//i;

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

// ------------------------------------------------------------------ 正向
{
  // W1 运行时清单：条目完整、可下载（每条都有 dest/sha256/sizeBytes/url）。
  let ok = false;
  let detail = null;
  try {
    const m = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'));
    const files = Array.isArray(m.files) ? m.files : [];
    const hasWin = files.some((f) => f.platform === 'win32-x64');
    const allComplete = files.length > 0 && files.every(
      (f) => f.id && f.dest && typeof f.sha256 === 'string' && f.sha256.length > 0
        && typeof f.sizeBytes === 'number' && f.sizeBytes > 0
        && typeof f.url === 'string' && f.url.length > 0,
    );
    ok = allComplete && hasWin;
    detail = { entries: files.length, hasWin, allComplete };
  } catch (e) {
    detail = String(e.message);
  }
  check('W1 `runtime.manifest.json` 条目完整可下载（dest/sha256/sizeBytes/url 齐全），且含 win32-x64 平台变体', ok, detail);

  // W2 wheel 通道：pydensecrf 条目 `local` 与 `url` 互斥（未托管时 local=true/url=null；托管后 local=false/url 非空）。
  let ok2 = false;
  let detail2 = null;
  try {
    const m = JSON.parse(fs.readFileSync(WHEELS_MANIFEST, 'utf8'));
    const w = (m.wheels || []).find((x) => String(x.id).includes('pydensecrf'));
    const hasSha = w && typeof w.sha256 === 'string' && w.sha256.length > 0;
    const hasSize = w && typeof w.sizeBytes === 'number' && w.sizeBytes > 0;
    // 🔴 三态**恰取其一**：随包(bundled=true + path) / 未托管(local=true) / 已托管(url 非空)。
    const bundled = w ? w.bundled === true : false;
    const path = w && typeof w.path === 'string' && w.path.length > 0;
    const local = w ? w.local === true : false;
    const url = w ? (typeof w.url === 'string' && w.url.length > 0) : false;
    const exactlyOne = [bundled, local, url].filter(Boolean).length === 1;
    const bundledComplete = !bundled || path;
    ok2 = !!(w && hasSha && hasSize && exactlyOne && bundledComplete);
    detail2 = { found: !!w, hasSha, hasSize, bundled, path, local, url, exactlyOne, bundledComplete };
  } catch (e) {
    detail2 = String(e.message);
  }
  check('W2 `wheels.manifest.json` pydensecrf 条目结构合法（sha256/sizeBytes 齐备，分发形态 bundled/local/url 三态恰取其一且 bundled 必带 path）', ok2, detail2);

  // W3 端点接线 + G5 进度字段全部暴露在 `/engine/status` 的 `modelDownload`。
  const handlers = fs.readFileSync(HANDLERS_RS, 'utf8');
  const state = fs.readFileSync(STATE_RS, 'utf8');
  const wired = handlers.includes('"POST /api/v1/engine/models/download"')
    && handlers.includes('models_download')
    && handlers.includes('start_model_download');
  const keys = ['"percent"', '"receivedBytes"', '"totalBytes"', '"speedBps"', '"etaMs"', '"stage"', '"currentId"', '"canResume"', '"interruptedReason"'];
  const allKeys = keys.every((k) => state.includes(k));
  check('W3 `/engine/models/download` 接线到 `start_model_download`，且 `modelDownload` 暴露全部 G5 进度字段', wired && allKeys, { wired, missing: keys.filter((k) => !state.includes(k)) });

  // W4 阶段顺序：runtime→stage1，models→stage2（先可翻译、后补权重）。
  const stageMap = state.includes('"runtime" => Some("stage1"') && state.includes('"models" => Some("stage2"');
  check('W4 阶段顺序：运行环境=stage1、权重=stage2（先可用后完整）', stageMap, { stageMap });

  // W5 工具条芯片映射：运行态/中断态/缺件未开始三态文案，且**不含命令行字样**。
  const ed = fs.readFileSync(ENGINE_DOWNLOAD_TS, 'utf8');
  const mapped = ed.includes("'引擎下载中'") && ed.includes("'下载中断'") && ed.includes("'需下载引擎'");
  const noJargon = !CLI_JARGON.test(ed);
  check('W5 `engine-download.ts` 三态文案正确（下载中/下载中断/需下载引擎）且不含命令行字样', mapped && noJargon, { mapped, jargon: CLI_JARGON.test(ed) });

  // W6 引导/下载视图不出现命令行字样（用户全程零命令行）。
  const uiText = UI_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  check('W6 引导页/下载视图/在线表单/进度环不含命令行字样（node/npm/pip/MSVC 等）', !CLI_JARGON.test(uiText), { jargon: CLI_JARGON.test(uiText) });

  // W7 进度环：无真实进度时如实显示「准备中」，不画假的 0%。
  const ring = fs.readFileSync(path.join(ROOT, 'app', 'src', 'components', 'units', 'ProgressRing.tsx'), 'utf8');
  check('W7 `ProgressRing` 无真实进度时显示「准备中」而非假的 0%', ring.includes("'准备中'"), { hasPreparing: ring.includes("'准备中'") });

  // W8 续传能力现算自盘上 `.part`（进程重启后内存态清空仍能如实报可续）。
  const resumable = state.includes('fn can_resume_now') && state.includes('has_part_files');
  check('W8 续传态现算自盘上 `.part`（`can_resume_now` + `has_part_files`），重启不丢续传能力', resumable, { resumable });

  // W9 Rust 侧面向用户的未就绪文案：**零命令行**，且必须给出产品内动作。
  //    判据只取 `const FIX_*` 的**字面值**与闸门消息那一行 —— 文件注释里正讨论着
  //    「不许写命令行」，扫全文会把规则本身当成违规（历史上踩过：规则条文自身污染扫描）。
  const probeSrc = fs.readFileSync(RUNTIME_PROBE_RS, 'utf8');
  const fixLiterals = [...probeSrc.matchAll(/const FIX_[A-Z_]+: &str = "([^"]*)";/g)].map((m) => m[1]);
  const fixClean = fixLiterals.length === 4 && fixLiterals.every((t) => t.length > 0 && !CLI_JARGON.test(t));
  check('W9a Rust `FIX_*` 未就绪文案四条齐全且零命令行字样（node / npm run / engine/scripts）',
    fixClean, { count: fixLiterals.length, dirty: fixLiterals.filter((t) => CLI_JARGON.test(t)) });

  // W9b 文案必须落到**产品内动作**上：只说"缺什么"而不给可点的入口，用户仍无处可去。
  const IN_APP_ENTRY = /开始下载|重新下载模型/;
  const fixActionable = fixLiterals.length === 4 && fixLiterals.every((t) => IN_APP_ENTRY.test(t));
  check('W9b 每条未就绪文案都指向产品内入口（「开始下载」/「重新下载模型」），不是命令行',
    fixActionable, { notActionable: fixLiterals.filter((t) => !IN_APP_ENTRY.test(t)) });

  // W9c 闸门消息同样不得把用户支去命令行。
  const gateLine = probeSrc.split('\n').find((l) => l.includes('运行时未装配：'));
  const gateClean = !!gateLine && !CLI_JARGON.test(gateLine);
  check('W9c D6 闸门消息不含命令行字样（它是 `last_error`，用户会看到）', gateClean, { gateLine });

  // ---- W10：产品调用必须真的分两轮（`--stage 1` → 成功后 `--stage 2`）----
  //     只跑一次全量的形态：用户要等 6 GB 权重下完才能开始翻译，而引导页与安装文档
  //     承诺的是"先准备好运行环境、权重在后台继续"。判据取**源码结构**而不是行为：
  //     ① `start_model_download` 起的是 `Some(1)`；② 有一个函数把第 2 轮接上。
  const startsStage1 = /spawn_download_round\(\s*&self\.download_runner,[\s\S]{0,400}?Some\(1\)/.test(state);
  const chainsStage2 = state.includes('Some(2)') && state.includes('第 1 阶段就绪，继续下载翻译权重');
  // 第 2 轮**不得**再带 `--engine-bootstrap`：那会重跑 pip（不幂等廉价）。
  const bootstrapOnlyInFirst = /if stage == Some\(1\) \{\s*cmd\.arg\("--engine-bootstrap"\)/.test(state);
  check('W10 下载真的分两轮：第 1 轮 `--stage 1`（运行环境就绪）成功后自动接第 2 轮（翻译权重）',
    startsStage1 && chainsStage2 && bootstrapOnlyInFirst,
    { startsStage1, chainsStage2, bootstrapOnlyInFirst });

  // ---- W11：stage 归属必须让「运行环境就绪」自洽 ----
  //     stage1 若只有视觉模型而没有 llama-server，则第 1 轮结束时 ③ 仍起不来
  //     （CUDA DLL 与 llama-server.exe 必须同目录）⇒ "先可用"是假的。
  //     事实源是 `models.manifest.json` 本身，不在这里另列一份集合。
  let stageOk = false;
  let stageDetail = null;
  try {
    const m = JSON.parse(fs.readFileSync(MODELS_MANIFEST, 'utf8'));
    const st = (f) => (f.stage === undefined ? 1 : f.stage);
    const llama = m.files.filter((f) => f.set === 'runtime');
    const sakura = m.files.find((f) => f.id === 'sakura_1_5b_fp16');
    stageOk = llama.length > 0
      && llama.every((f) => st(f) === 1)
      && !!sakura && st(sakura) === 2;
    stageDetail = { runtimeStage: llama.map((f) => [f.id, st(f)]), sakuraStage: sakura ? st(sakura) : null };
  } catch (e) {
    stageDetail = String(e.message);
  }
  check('W11 `models.manifest.json` 里 llama.cpp / cudart 归 stage1、Sakura 权重归 stage2（否则第 1 轮结束 ③ 仍起不来）',
    stageOk, stageDetail);

  // ---- W12：阶段文案必须与两轮实现一致（不许承诺"1 分钟就能翻译"）----
  //     stage1 不含任何 LLM ⇒ 翻译必须等 stage2。文案不实 = 欺骗性进度。
  const panel = fs.readFileSync(DOWNLOAD_PANEL_TSX, 'utf8');
  const stage1Text = /stage1:\s*\{[\s\S]*?\}/.exec(panel);
  const stage1Body = stage1Text ? stage1Text[0] : '';
  const noFalsePromise = stage1Body.length > 0 && !/即可开始翻译|就能开始翻译/.test(stage1Body);
  check('W12 第 1 阶段文案不承诺"即可开始翻译"（stage1 无 LLM，翻译要等第 2 轮）',
    noFalsePromise, { stage1Body: stage1Body.slice(0, 200) });
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
      const c = spawn(process.execPath, [SELF], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('error', () => resolve({ code: -1, out }));
      c.on('close', (code) => resolve({ code, out }));
    });

  // 用 import 避免顶部依赖未用到时报 unused（本文件仅反证轮需要）
  const { spawn } = await import('node:child_process');

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));

  // ---- M1：注入命令行字样 ----
  {
    const restore = mutateFile(ENGINE_DOWNLOAD_TS, "text: '引擎下载中',", "text: '引擎下载中（pip 续传）',");
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W5');
    check('M1 运行态文案注入命令行字样 ⇒ W5 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M2：抹掉清单某条 sha256 ----
  {
    const original = fs.readFileSync(RUNTIME_MANIFEST, 'utf8');
    const m = JSON.parse(original);
    const first = m.files[0];
    const backup = first.sha256;
    first.sha256 = '';
    fs.writeFileSync(RUNTIME_MANIFEST, JSON.stringify(m, null, 2));
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W1');
    check('M2 运行时清单某条 sha256 缺失 ⇒ W1 红', red, { code: r.code, redOn: red });
    const back = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'));
    back.files[0].sha256 = backup;
    fs.writeFileSync(RUNTIME_MANIFEST, JSON.stringify(back, null, 2));
  }

  // ---- M3：阶段映射改名 ----
  {
    const restore = mutateFile(STATE_RS, '"runtime" => Some("stage1"', '"runtime" => Some("phase1"');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W4');
    check('M3 阶段映射 stage1 改名 ⇒ W4 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M4：Rust 未就绪文案注回命令行（W9 之前这条是盲区） ----
  {
    const restore = mutateFile(
      RUNTIME_PROBE_RS,
      'const FIX_SETUP: &str = "在「设置 → 翻译服务」点「开始下载」，喵坞会自动装配引擎运行时";',
      'const FIX_SETUP: &str = "运行 node engine/scripts/setup-engine.mjs 装配引擎运行时";',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W9a');
    check('M4 Rust `FIX_SETUP` 注回命令行字样 ⇒ W9a 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M5：文案丢掉产品内入口（改成纯描述）⇒ W9b 红 ----
  {
    const restore = mutateFile(
      RUNTIME_PROBE_RS,
      'const FIX_DEPS: &str = "点「开始下载」即可 —— 装配会从公网镜像安装引擎依赖（无需命令行）";',
      'const FIX_DEPS: &str = "引擎依赖（torch / manga_translator）缺失";',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W9b');
    check('M5 未就绪文案抹掉产品内入口（只说缺什么）⇒ W9b 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M6：第 2 轮也带上 `--engine-bootstrap`（会重跑 pip，几分钟白等）⇒ W10 红 ----
  {
    const restore = mutateFile(
      STATE_RS,
      '    if stage == Some(1) {\n        cmd.arg("--engine-bootstrap");\n    }',
      '    cmd.arg("--engine-bootstrap");',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W10');
    check('M6 第 2 轮也带 `--engine-bootstrap`（重跑 pip）⇒ W10 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M7：把 llama.cpp 挪回 stage2（第 1 轮结束 ③ 仍起不来）⇒ W11 红 ----
  {
    const original = fs.readFileSync(MODELS_MANIFEST, 'utf8');
    const m = JSON.parse(original);
    const llama = m.files.filter((f) => f.set === 'runtime');
    for (const f of llama) f.stage = 2;
    fs.writeFileSync(MODELS_MANIFEST, JSON.stringify(m, null, 2));
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W11');
    check('M7 llama.cpp / cudart 挪回 stage2 ⇒ W11 红（第 1 轮结束 ③ 起不来）', red, { code: r.code, redOn: red });
    fs.writeFileSync(MODELS_MANIFEST, original);
  }

  // ---- M8：stage1 文案承诺"即可开始翻译"（stage1 无 LLM，是假承诺）⇒ W12 红 ----
  {
    const restore = mutateFile(
      DOWNLOAD_PANEL_TSX,
      "sub: '下载并解包 Python 运行时、引擎源码与视觉模型 —— 这一步完成后本地引擎即可启动，翻译权重在后台继续。',",
      "sub: '下载并解包 Python 运行时、引擎源码与视觉模型 —— 这一步完成即可开始翻译。',",
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W12');
    check('M8 stage1 文案承诺"即可开始翻译"（stage1 无 LLM）⇒ W12 红', red, { code: r.code, redOn: red });
    restore();
  }

  // 收尾：确认还原到位
  {
    const bad = [];
    if (!fs.readFileSync(ENGINE_DOWNLOAD_TS, 'utf8').includes("text: '引擎下载中',")) bad.push('engine-download.ts 残留 M1');
    if (fs.readFileSync(RUNTIME_MANIFEST, 'utf8').includes('"sha256": ""')) bad.push('runtime.manifest.json 残留 M2');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('"runtime" => Some("stage1"')) bad.push('state.rs 残留 M3');
    if (!fs.readFileSync(RUNTIME_PROBE_RS, 'utf8').includes('点「开始下载」，喵坞会自动装配引擎运行时')) bad.push('runtime_probe.rs 残留 M4');
    if (!fs.readFileSync(RUNTIME_PROBE_RS, 'utf8').includes('装配会从公网镜像安装引擎依赖')) bad.push('runtime_probe.rs 残留 M5');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('if stage == Some(1) {')) bad.push('state.rs 残留 M6');
    if (fs.readFileSync(MODELS_MANIFEST, 'utf8').includes('"stage": 2,\n      "platform": "win32-x64",\n      "dest": "bin/llama')) bad.push('models.manifest.json 残留 M7');
    if (!fs.readFileSync(DOWNLOAD_PANEL_TSX, 'utf8').includes('这一步完成后本地引擎即可启动')) bad.push('DownloadPanel.tsx 残留 M8');
    check('R1 变异收尾：八处源码/清单按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
