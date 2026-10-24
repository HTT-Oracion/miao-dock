#!/usr/bin/env node
/**
 * G5 · 「本地引擎开箱即用」引导链门 —— 一键下载编排 / 阶段顺序 / 中断可续 / 百分比来源真实 / 不出现命令行字样
 * =============================================================================
 * 对应计划「开箱即用」整组。本门**不重新发明下载器**：运行时资产（Python 运行时、
 * 引擎源码、预装 site-packages）走 `runtime.manifest.json`，由既有 `mangasvc::engine::model_store`
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
 * - M1–M5：运行态文案注入命令行字样 ⇒ W5 · 清单抹掉 `sha256` ⇒ W1 · 阶段映射改名 ⇒ W4 ·
 *   `FIX_SETUP` 注回 `node engine/scripts/…` ⇒ W9a · 未就绪文案抹掉产品内入口 ⇒ W9b。
 * - M6–M9：第 2 轮也带 `--engine-bootstrap`（重跑 pip）⇒ W10 · llama.cpp 挪回 stage2 ⇒ W11 ·
 *   stage1 文案承诺"即可开始翻译" ⇒ W12 · 长路径结论不落盘 ⇒ W13。
 * - M10–M11：解包改回按 url 末段找归档 ⇒ W14 · 运行时解包退回"解整份清单" ⇒ W15。
 * - M12–M13：镜像套回 codeload（ghfast 不代理它）⇒ W16 · 原 `url` 的 owner 拼错一个字母 ⇒ W16。
 * - M14–M15（D-231④）：`prepare` 不再归 `stage1` ⇒ W4 · `step` 不映射 `models` 段 ⇒ W4。
 * - M16–M17（D-231⑤）：`persist()` 退回直写目标文件 ⇒ W17 · `isDownloadActive` 退回只认三态 ⇒ W18。
 * - M18–M20（D-231⑦）：③ 失败文案退回一律「启动超时」⇒ W19 · `--use-gpu` 退回恒真 ⇒ W20 ·
 *   CUDA 自检结论不落盘 ⇒ W21。
 * 每条反证都按字节还原，收尾复核残留（R1）。
 *
 * ## W9 为什么必须打在 Rust 侧
 * W5/W6 只扫前端 4 个文件，而「运行时未装配」屏渲染的字符串来自
 * `mangasvc/engine/runtime_probe.rs`（经 `/engine/runtime` → `NotReadyScreen.tsx`）。
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
const HANDLERS_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'handlers.rs');
const STATE_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'state.rs');
/// W9：**Rust 侧**面向用户的未就绪文案（`fix` + 闸门消息）也要零命令行 ——
/// 前端 4 个文件干净不等于产品干净：`NotReadyScreen.tsx` 渲染的正是这里的字符串。
const RUNTIME_PROBE_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'runtime_probe.rs');
/// W13：装配编排（长路径体检住在那里）；D-231④ 的阶段 0 与 D-231⑦ 的 torch 索引也住在那里。
const RUNTIME_SETUP_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'runtime_setup.rs');
/// D-233：第 2 轮（无 bootstrap）的 `llm` 阶段事件。
const FETCH_MODELS_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'fetch_models.rs');
/// D-231⑦：③ 的等待/失败原因分支。
const SUPERVISOR_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'supervisor.rs');
/// D-231⑦：`--use-gpu` 默认值的取值处。
const ENGINE_RS = path.join(ROOT, 'src-tauri', 'src', 'mangasvc', 'engine.rs');
/// W17 / W18（D-231⑤）：下载状态文件的原子写 + `isDownloadActive` 的抖动防御。
const ENGINE_DOWNLOAD_TS = path.join(ROOT, 'src', 'ipc', 'engine-download.ts');
/// W11：stage 归属的事实源。
const MODELS_MANIFEST = path.join(ROOT, 'engine', 'models.manifest.json');
/// W12：下载视图（第 1/第 2 阶段文案）。
const DOWNLOAD_PANEL_TSX = path.join(ROOT, 'src', 'screens', 'engine', 'DownloadPanel.tsx');
/// W12：五段阶段文案住在文案层（`download/copy.ts`）—— 判据必须读**文案层**，
/// 读组件文件只会拿到空串，而那会让这条断言永远绿（空串里当然不含"即可开始翻译"）。
const DOWNLOAD_COPY_TS = path.join(ROOT, 'src', 'screens', 'engine', 'download', 'copy.ts');
/// W16：版本锁（人读的事实源）—— `engine_source` 的 owner/repo/commit 以它为准。
const VERSIONS_LOCK = path.join(ROOT, 'engine', 'VERSIONS.lock');
const UI_FILES = [
  path.join(ROOT, 'src', 'screens', 'manga', 'NotReadyScreen.tsx'),
  path.join(ROOT, 'src', 'screens', 'engine', 'DownloadPanel.tsx'),
  path.join(ROOT, 'src', 'components', 'units', 'ProgressRing.tsx'),
];

/**
 * 命令行字样（反证 M1 / W5 / W6 / W9 要抓的就是这些）—— 只钉真正的命令，不钉「命令行」这种中性叙述词。
 * 🔴 必须含 `node <脚本>` 与 `npm run <脚本>` 两种形态：历史文案是
 * 「运行 node engine/scripts/setup-engine.mjs …」「运行 npm run deps:engine …」，
 * 它们能被用户读到，却**不被**前几条命令前缀命中（W9 之前这条是盲区）。
 */
const CLI_JARGON =
  /npm install|npm run|pip install|python -m venv|MSVC|conda install|apt-get install|node\s+\S+\.mjs|node\s+engine\//i;

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

/**
 * W16 判据：`engine_source` 的两处 URL 是否与 `engine/VERSIONS.lock` §1 **同形**。
 *
 * D-217 的真机事故：`url` 的 owner 拼成了 `zydnnys`、`sources[0]` 拼成了 `zydmnys`，
 * 且把 **codeload 套在镜像前缀后面**（ghfast 不代理 codeload，实测一律 403）。
 * 三处都"看起来对"：都是 https、都落在同一个仓库名与 commit 上 ——
 * 只有**形态**判据分得开，而形态恰恰是人眼最容易放过的一层。
 *
 * 正向轮与反证收尾（R1）共用本函数：两处各写一份形态正则会各自漂移。
 */
function engineSourceShape() {
  const lock = fs.readFileSync(VERSIONS_LOCK, 'utf8');
  const repo = (/^\s*repo\s*=\s*(\S+)\s*$/m.exec(lock) || [])[1] || '';
  const commit = (/^\s*commit\s*=\s*(\S+)\s*$/m.exec(lock) || [])[1] || '';
  // 只认 `https://github.com/<owner>/<repo>`（`.git` 可省）—— 版本锁里就这一种写法。
  const slug = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repo);
  if (!slug || !commit) {
    return { lockRepo: repo, lockCommit: commit, error: '版本锁 §1 的 repo / commit 读不出来' };
  }
  const owner = slug[1];
  const name = slug[2];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 原 `url`：codeload 的按需打包归档（上游源码的真实获取通道，见 §1 的实测注释）。
  const urlForm = new RegExp(`^https://codeload\\.github\\.com/${esc(owner)}/${esc(name)}/tar\\.gz/${esc(commit)}$`);
  // 镜像：`<前缀>https://github.com/<owner>/<repo>/archive/<commit>.tar.gz`。
  // 🔴 套 codeload 的那条**是死链**（ghfast 不代理它）—— 形态判据在这里替网络说话。
  const mirrorForm = new RegExp(
    `^https://[^/]+/https://github\\.com/${esc(owner)}/${esc(name)}/archive/${esc(commit)}\\.tar\\.gz$`,
  );

  const manifest = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'));
  const entry = (manifest.files || []).find((f) => f.id === 'engine_source') || {};
  const sources = Array.isArray(entry.sources) ? entry.sources.map((s) => String(s)) : [];
  return {
    lockRepo: repo,
    lockCommit: commit,
    url: entry.url || '',
    urlOk: urlForm.test(entry.url || ''),
    sources,
    badSources: sources.filter((s) => !mirrorForm.test(s)),
  };
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
    const allComplete =
      files.length > 0 &&
      files.every(
        (f) =>
          f.id &&
          f.dest &&
          typeof f.sha256 === 'string' &&
          f.sha256.length > 0 &&
          typeof f.sizeBytes === 'number' &&
          f.sizeBytes > 0 &&
          typeof f.url === 'string' &&
          f.url.length > 0,
      );
    ok = allComplete && hasWin;
    detail = { entries: files.length, hasWin, allComplete };
  } catch (e) {
    detail = String(e.message);
  }
  check(
    'W1 `runtime.manifest.json` 条目完整可下载（dest/sha256/sizeBytes/url 齐全），且含 win32-x64 平台变体',
    ok,
    detail,
  );

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
    const url = w ? typeof w.url === 'string' && w.url.length > 0 : false;
    const exactlyOne = [bundled, local, url].filter(Boolean).length === 1;
    const bundledComplete = !bundled || path;
    ok2 = !!(w && hasSha && hasSize && exactlyOne && bundledComplete);
    detail2 = { found: !!w, hasSha, hasSize, bundled, path, local, url, exactlyOne, bundledComplete };
  } catch (e) {
    detail2 = String(e.message);
  }
  check(
    'W2 `wheels.manifest.json` pydensecrf 条目结构合法（sha256/sizeBytes 齐备，分发形态 bundled/local/url 三态恰取其一且 bundled 必带 path）',
    ok2,
    detail2,
  );

  // W3 端点接线 + G5 进度字段全部暴露在 `/engine/status` 的 `modelDownload`。
  const handlers = fs.readFileSync(HANDLERS_RS, 'utf8');
  const state = fs.readFileSync(STATE_RS, 'utf8');
  const wired =
    handlers.includes('"POST /api/v1/engine/models/download"') &&
    handlers.includes('models_download') &&
    handlers.includes('start_model_download');
  const keys = [
    '"percent"',
    '"receivedBytes"',
    '"totalBytes"',
    '"speedBps"',
    '"etaMs"',
    '"stage"',
    '"step"',
    '"currentId"',
    '"canResume"',
    '"interruptedReason"',
  ];
  const allKeys = keys.every((k) => state.includes(k));
  check(
    'W3 `/engine/models/download` 接线到 `start_model_download`，且 `modelDownload` 暴露全部 G5 进度字段',
    wired && allKeys,
    { wired, missing: keys.filter((k) => !state.includes(k)) },
  );

  // W4 阶段顺序：runtime→stage1，models→stage2（先可翻译、后补权重）。
  // 🔴 D-231④ 起这里钉的是**两张表同时**成立：`stage`（下载详情页那个两步指示器，
  //    `prepare` 必须归 stage1，否则 `STAGE_TEXT['prepare']` 是 undefined ⇒ 指示器整块消失）
  //    与 `step`（未就绪屏四段时间线）。只钉 stage 会漏掉"step 根本没接上"，
  //    只钉 step 会漏掉"prepare 把下载详情页打没了"。
  const setupForPhases = fs.readFileSync(RUNTIME_SETUP_RS, 'utf8');
  const fetchForPhases = fs.readFileSync(FETCH_MODELS_RS, 'utf8');
  const stageMap =
    state.includes('"prepare" | "runtime" | "visual" => Some("stage1"') &&
    state.includes('"llm" | "models" => Some("stage2"');
  const stepMap =
    state.includes('"prepare" => Some("prepare".to_string())') &&
    state.includes('"runtime" => Some("runtime".to_string())') &&
    state.includes('"visual" => Some("visual".to_string())') &&
    state.includes('"llm" => Some("llm".to_string())') &&
    state.includes('"models" => Some("models".to_string())');
  // 装配侧必须真的发出 `prepare` 段（发不出来 ⇒ 五段时间线的第 1 段永远不亮）；
  // `visual` 由 bootstrap 发，`llm` 由第 2 轮的 fetch-models 发 —— 两侧各缺一条都会让流程停住。
  const emitsPrepare = /on_phase\("prepare",\s*"[^"]+"\)/.test(setupForPhases);
  const emitsVisual =
    /on_phase\(model_phase,\s*"[^"]+"\)/.test(setupForPhases) && /Some\(1\)\s*\{\s*"visual"/.test(setupForPhases);
  const emitsLlm =
    /id:\s*"llm"\.to_string\(\)/.test(fetchForPhases) && /args\.max_stage == Some\(2\)/.test(fetchForPhases);
  check(
    'W4 五段顺序：visual=stage1、llm=stage2（先可用后完整）· `prepare`/`visual`/`llm` 各有真实事件与 step 映射',
    stageMap && stepMap && emitsPrepare && emitsVisual && emitsLlm,
    { stageMap, stepMap, emitsPrepare, emitsVisual, emitsLlm },
  );

  // W5 工具条芯片映射：运行态/中断态/缺件未开始三态文案，且**不含命令行字样**。
  const ed = fs.readFileSync(ENGINE_DOWNLOAD_TS, 'utf8');
  const mapped = ed.includes("'引擎下载中'") && ed.includes("'下载中断'") && ed.includes("'需下载引擎'");
  const noJargon = !CLI_JARGON.test(ed);
  check('W5 `engine-download.ts` 三态文案正确（下载中/下载中断/需下载引擎）且不含命令行字样', mapped && noJargon, {
    mapped,
    jargon: CLI_JARGON.test(ed),
  });

  // W6 引导/下载视图不出现命令行字样（用户全程零命令行）。
  const uiText = UI_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  check('W6 引导页/下载视图/在线表单/进度环不含命令行字样（node/npm/pip/MSVC 等）', !CLI_JARGON.test(uiText), {
    jargon: CLI_JARGON.test(uiText),
  });

  // W7 进度环：无真实进度时如实显示「准备中」，不画假的 0%。
  const ring = fs.readFileSync(path.join(ROOT, 'src', 'components', 'units', 'ProgressRing.tsx'), 'utf8');
  check('W7 `ProgressRing` 无真实进度时显示「准备中」而非假的 0%', ring.includes("'准备中'"), {
    hasPreparing: ring.includes("'准备中'"),
  });

  // W8 续传能力现算自盘上 `.part`（进程重启后内存态清空仍能如实报可续）。
  const resumable = state.includes('fn can_resume_now') && state.includes('has_part_files');
  check('W8 续传态现算自盘上 `.part`（`can_resume_now` + `has_part_files`），重启不丢续传能力', resumable, {
    resumable,
  });

  // W9 Rust 侧面向用户的未就绪文案：**零命令行**，且必须给出产品内动作。
  //    判据只取 `const FIX_*` 的**字面值**与闸门消息那一行 —— 文件注释里正讨论着
  //    「不许写命令行」，扫全文会把规则本身当成违规（历史上踩过：规则条文自身污染扫描）。
  // 🔴 分母**写死**且必须跟着判据一起长：D-231③ 加了第 5 条 `FIX_MODELS`
  //    （③ 可执行体 / 翻译权重，它走模型链那条，文案与前四条刻意分开）。
  //    写死而不是"至少 4 条"：比率型判据会把"新增的文案里混进了命令行"这类事故放过。
  const EXPECTED_FIX_LITERALS = 5;
  const probeSrc = fs.readFileSync(RUNTIME_PROBE_RS, 'utf8');
  const fixLiterals = [...probeSrc.matchAll(/const FIX_[A-Z_]+: &str = "([^"]*)";/g)].map((m) => m[1]);
  const fixClean =
    fixLiterals.length === EXPECTED_FIX_LITERALS && fixLiterals.every((t) => t.length > 0 && !CLI_JARGON.test(t));
  check('W9a Rust `FIX_*` 未就绪文案五条齐全且零命令行字样（node / npm run / engine/scripts）', fixClean, {
    count: fixLiterals.length,
    dirty: fixLiterals.filter((t) => CLI_JARGON.test(t)),
  });

  // W9b 文案必须落到**产品内动作**上：只说"缺什么"而不给可点的入口，用户仍无处可去。
  const IN_APP_ENTRY = /开始下载|重新下载模型/;
  const fixActionable = fixLiterals.length === EXPECTED_FIX_LITERALS && fixLiterals.every((t) => IN_APP_ENTRY.test(t));
  check('W9b 每条未就绪文案都指向产品内入口（「开始下载」/「重新下载模型」），不是命令行', fixActionable, {
    notActionable: fixLiterals.filter((t) => !IN_APP_ENTRY.test(t)),
  });

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
  check(
    'W10 下载真的分两轮：第 1 轮 `--stage 1`（运行环境就绪）成功后自动接第 2 轮（翻译权重）',
    startsStage1 && chainsStage2 && bootstrapOnlyInFirst,
    { startsStage1, chainsStage2, bootstrapOnlyInFirst },
  );

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
    stageOk = llama.length > 0 && llama.every((f) => st(f) === 1) && !!sakura && st(sakura) === 2;
    stageDetail = { runtimeStage: llama.map((f) => [f.id, st(f)]), sakuraStage: sakura ? st(sakura) : null };
  } catch (e) {
    stageDetail = String(e.message);
  }
  check(
    'W11 `models.manifest.json` 里 llama.cpp / cudart 归 stage1、Sakura 权重归 stage2（否则第 1 轮结束 ③ 仍起不来）',
    stageOk,
    stageDetail,
  );

  // ---- W12：阶段文案必须与两轮实现一致（不许承诺"1 分钟就能翻译"）----
  //     stage1 不含任何 LLM ⇒ 翻译必须等 stage2。文案不实 = 欺骗性进度。
  // 文案在 copy.ts（拆层后），组件文件里只剩引用 —— 读文案层才拿得到 stage1 那段
  const panel = fs.readFileSync(DOWNLOAD_COPY_TS, 'utf8');
  // D-233：两轮指示器仍在，但文案按五段 `step` 取；stage1 对应 `visual` 段。
  const stage1Text = /visual:\s*\{[\s\S]*?\}/.exec(panel);
  const stage1Body = stage1Text ? stage1Text[0] : '';
  const noFalsePromise = stage1Body.length > 0 && !/即可开始翻译|就能开始翻译/.test(stage1Body);
  check('W12 第 1 阶段（visual）文案不承诺"即可开始翻译"（stage1 无 LLM，翻译要等第 2 轮）', noFalsePromise, {
    stage1Body: stage1Body.slice(0, 200),
  });

  // ---- W13：长路径体检**存在且不替用户改系统** ----
  //     两条一起钉：① 装配真的会量一遍最长路径并把结论写进就绪标记（否则"要不要开
  //     LongPathsEnabled"永远只是安装引导里的一句推测）；② 它**只报告**，不写注册表、
  //     不挪目录 —— 那是 D-189 已拍板的边界（`check:bundle` 的 M13 反证同理）。
  const setupSrc = fs.readFileSync(RUNTIME_SETUP_RS, 'utf8');
  const measures = setupSrc.includes('fn longest_path') && setupSrc.includes('fn measure_long_path');
  const writesMarker = setupSrc.includes('"longPath"');
  const noRegistryWrite = !/WriteRegDWORD|reg\s+add|LongPathsEnabled"\s*,\s*1/.test(setupSrc);
  const tarVerbatim = setupSrc.includes('fn verbatim') && setupSrc.includes('verbatim(&arc)');
  check(
    'W13 装配期做长路径体检（量最长路径 + 写进就绪标记 + tar 走 verbatim 前缀），且只报告、不写注册表',
    measures && writesMarker && noRegistryWrite && tarVerbatim,
    { measures, writesMarker, noRegistryWrite, tarVerbatim },
  );

  // ---- W14：解包找归档必须用 `dest`，不是 `url` 的末段 ----
  //     下载侧（`model_store::ensure_models`）落在 `root.join(file.dest)`；解包侧若按 url 找，
  //     必然落空 —— 症状是**下完 100 MB 之后**报「待解包归档不存在」，而下载日志里那条
  //     「[完成] …」看上去一切正常。两份清单里 dest 与 url 末段**真的不同名**
  //     （`python-3.11.17-….tar.gz` vs `cpython-3.11.17%2B….tar.gz`），所以这不是理论问题。
  const archiveFromDest =
    /fn archive_path\(root: &Path, e: &FileEntry\) -> PathBuf \{\s*root\.join\(&e\.dest\)/.test(setupSrc) &&
    setupSrc.includes('archive_path(root, e)');
  // 反面：不许再出现"按 url 末段拼 .download-cache"那种写法。
  const noUrlTailLookup = !/\.download-cache"\)\.join\(url_name\(/.test(setupSrc) && !setupSrc.includes('fn url_name(');
  check(
    'W14 解包按 `dest` 找归档（与下载侧同一条路径），且不再按 url 末段拼 —— 两处不同名时按 url 必然落空',
    archiveFromDest && noUrlTailLookup,
    { archiveFromDest, noUrlTailLookup },
  );

  // ---- W15：解包只解**刚下过的那一组** ----
  //     装配是分组推进的（python 组 → source 组 → 模型组），而解包曾经是打开整份清单去解 ⇒
  //     第 1 阶段刚下完 python 就会顺手去解还没下载的 `engine_source`，报「待解包归档不存在」。
  //     🔴 这条只在**干净机器**上现形：本机缓存里恰好躺着 `setup:engine` 留下的那份归档，
  //     于是本机跑装配一路绿灯 —— 正是"假绿"的标准形态，所以钉在源码上而不是靠跑一遍。
  const scopedBySet =
    setupSrc.includes('fn set_ids(manifest: &Manifest, set: &str)') &&
    /let py_ids = set_ids\(runtime_manifest, "python"\)\?;/.test(setupSrc) &&
    /extract_entries\(runtime_manifest, runtime_root, Some\(&py_ids\)\)\?;/.test(setupSrc) &&
    /let src_ids = set_ids\(runtime_manifest, "source"\)\?;/.test(setupSrc) &&
    /extract_entries\(runtime_manifest, runtime_root, Some\(&src_ids\)\)\?;/.test(setupSrc);
  // 反面①：运行时侧不许再有**不带范围**的解包。
  const noUnscopedRuntimeExtract = !/extract_entries\(runtime_manifest, runtime_root\)\?;/.test(setupSrc);
  // 反面②：模型侧的范围必须与 `--stage` 同源（`model_ids`），否则第 1 轮会去解第 2 轮的归档。
  const modelsScopedByStage = /extract_entries\(model_manifest, model_root, model_ids\.as_deref\(\)\)\?;/.test(
    setupSrc,
  );
  check(
    'W15 解包只解**刚下过的那一组**（运行时按 `set_ids`、模型按 `--stage` 同源）—— 否则干净机器第 1 阶段去解还没下的 engine_source',
    scopedBySet && noUnscopedRuntimeExtract && modelsScopedByStage,
    { scopedBySet, noUnscopedRuntimeExtract, modelsScopedByStage },
  );

  // ---- W16：清单里 `engine_source` 的两处 URL 必须与 `engine/VERSIONS.lock` §1 对得上 ----
  //     这一条是**下载器的前提**：清单写错时下载器一句错都不报，只如实打出
  //     「每条源都 403」（见 D-217 的真机日志），根因（镜像形态 + owner 拼写）离症状极远。
  let w16 = false;
  let w16Detail = null;
  try {
    const shape = engineSourceShape();
    w16 = !shape.error && shape.urlOk && shape.sources.length > 0 && shape.badSources.length === 0;
    w16Detail = shape;
  } catch (e) {
    w16Detail = String(e.message);
  }
  check(
    'W16 `engine_source` 的两处 URL 与 `engine/VERSIONS.lock` §1 同形（原 `url` 走 codeload、镜像一律套 `github.com/<owner>/<repo>/archive/<commit>.tar.gz`，owner 不许拼错）',
    w16,
    w16Detail,
  );

  // ---- W17（D-231⑤）状态文件必须**原子写** ----
  //     `persist()` 在**每个进度事件**上都调，而 `fs::write` 是"截断后逐段写"
  //     ⇒ 前端 1.5 s 轮询有很高概率读到**半截/空**文件 ⇒ `load_persisted()` 的
  //     `from_str().unwrap_or_else(default)` 整个吞掉 ⇒ `state` 回落 `idle`
  //     ⇒ `isDownloadActive` 为假 ⇒ 下载视图被卸载、用户被**弹回引导页**，
  //     再点「开始下载」又被下载器打回"已有一条任务"。
  //     钉死"写 `.tmp` + `rename` 覆盖"这两个动作；直写目标文件必须红。
  const persistFn = /fn persist\(&self\)[\s\S]*?\n {4}\}/.exec(state);
  const persistBody = persistFn ? persistFn[0] : '';
  const persistAtomic = persistBody.includes('with_extension("json.tmp")') && persistBody.includes('fs::rename');
  const persistDirectWrite = /fs::write\(\s*&p\b/.test(persistBody);
  check(
    'W17 下载状态文件**原子写**（`.tmp` + `rename` 覆盖）—— 否则前端读到半截文件就被弹回引导页',
    persistAtomic && !persistDirectWrite,
    { persistAtomic, persistDirectWrite, persistBody: persistBody.slice(0, 200) },
  );

  // ---- W18（D-231⑤）前端防御：`isDownloadActive` 必须把"开过一场下载却读到 idle"也算进行中 ----
  //     🔴 只钉"`state` 含 idle"不够：那样会把「装好、从未下载」的机器**永久钉在下载视图**，
  //     那比弹回引导页更糟。判据必须同时落在 `startedAt` 上（反证 M17）。
  const idleGuard = /state === 'idle' && view\.startedAt != null/.test(ed);
  check(
    'W18 `isDownloadActive` 把「已开场下载却读到 idle」也算进行中（读抖动不卸载下载视图；判据落在 `startedAt` 上）',
    idleGuard,
    { idleGuard },
  );

  // ---- W19（D-231⑦）③ 起不来的文案必须按**真实原因**写 ----
  //     现场症状：引擎一起来就自杀，界面与日志却一律报「③ LLM 未在 180s 内就绪」+ 停止原因
  //     「启动超时」。用户和排障被引向"是不是慢"，而真相是"它已经死了、再等也不会好"。
  //      -> `wait_ready` 必须返回**原因枚举**（不再是 bool），三个分支都得有人在血清里点名。
  const supervisor = fs.readFileSync(SUPERVISOR_RS, 'utf8');
  const hasOutcome = /enum WaitOutcome/.test(supervisor);
  const hasExited = /WaitOutcome::Exited/.test(supervisor);
  const hasTimeout = /WaitOutcome::Timeout/.test(supervisor);
  // 🔴 两种结局的**措辞不同**也算进来：共用一句"启动超时"就把"再等也不会好"
  //    和"可能只是慢"又混成了一个 —— 那正是这条要修的事。
  const distinctWords = /子进程已退出/.test(supervisor) && /启动超时/.test(supervisor);
  // 子进程的最后一行 stderr 往往是唯一物证（真机就是靠 `os error 3` 定位的），必须带进错误。
  const carriesTail = /last_llm_err\(logs\)/.test(supervisor);
  check(
    'W19 ③ 起不来时按真实原因分支（进程已退出 / 真超时），且把 `[llm:err]` 末行带进错误信息',
    hasOutcome && hasExited && hasTimeout && distinctWords && carriesTail,
    { hasOutcome, hasExited, hasTimeout, distinctWords, carriesTail },
  );

  // ---- W20（D-231⑦）`--use-gpu` 的默认值不再恒真，而是读装配期的 CUDA 自检结论 ----
  //     `env_bool("MIAO_ENGINE_USE_GPU", true)` 对一台装着 `torch 2.14.1+cpu` 的机器就是
  //     「配方恒带 --use-gpu ⇒ 引擎起来第一件事就找 CUDA ⇒ 找不到就自杀」。
  const engineSrc = fs.readFileSync(ENGINE_RS, 'utf8');
  const noHardTrue = !/env_bool\("MIAO_ENGINE_USE_GPU",\s*true\)/.test(engineSrc);
  const readsFact =
    /o\.use_gpu\.unwrap_or_else\(default_use_gpu\)/.test(engineSrc) && /read_cuda_available\(\)/.test(engineSrc);
  check(
    'W20 `--use-gpu` 默认值读装配期自检的 `cudaAvailable`，不再 `env_bool(..., true)` 恒真',
    noHardTrue && readsFact,
    { noHardTrue, readsFact },
  );

  // ---- W21（D-231⑦）装配期按本机 GPU 选 torch 构建，并当场自检 `torch.cuda.is_available()` ----
  //     🔴 有 NVIDIA 才挂 CUDA 索引：给没卡的机器装 CUDA 版 torch 的代价不只是多下几个 GB，
  //        那份 torch 跑起来第一件事就是报找不到设备然后退出 —— 与 W20 是同一条因果链的两端。
  const setupForGpu = fs.readFileSync(RUNTIME_SETUP_RS, 'utf8');
  const picksIndex = /TORCH_CUDA_INDEX/.test(setupForGpu) && /detect_nvidia_gpu\(\)/.test(setupForGpu);
  const selfChecks = /fn torch_cuda_available/.test(setupForGpu) && /torch\.cuda\.is_available\(\)/.test(setupForGpu);
  const persisted = /"cudaAvailable":\s*cuda_available/.test(setupForGpu);
  check(
    'W21 装依赖时按本机 GPU 选 torch 构建 + 事后自检 `cuda_available` 并写进 `.runtime.ready.json`',
    picksIndex && selfChecks && persisted,
    { picksIndex, selfChecks, persisted },
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
      const c = spawn(process.execPath, [SELF], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const restore = mutateFile(
      STATE_RS,
      '"prepare" | "runtime" | "visual" => Some("stage1"',
      '"prepare" | "runtime" | "visual" => Some("phase1"',
    );
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

  // ---- M8：visual 文案承诺"即可开始翻译"（stage1 无 LLM，是假承诺）⇒ W12 红 ----
  {
    // 文案住在 `download/copy.ts`（拆层后）—— 锚点跟着搬，否则这条反证会静默跳过
    const restore = mutateFile(
      DOWNLOAD_COPY_TS,
      "sub: '检测 / OCR / 抹字 / 字体，以及 llama.cpp 与 CUDA 运行库。',",
      "sub: '下载并解包 Python 运行时、引擎源码与视觉模型 —— 这一步完成即可开始翻译。',",
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W12');
    check('M8 visual 文案承诺"即可开始翻译"（stage1 无 LLM）⇒ W12 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M9：长路径体检量完却不落盘（结论只出现在日志里，重启后无从复算）⇒ W13 红 ----
  {
    const restore = mutateFile(
      RUNTIME_SETUP_RS,
      '        "longPath": longpath.map(|(len, p)| json!({',
      '        "longPathOff": longpath.map(|(len, p)| json!({',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W13');
    check('M9 长路径体检结论不写进就绪标记 ⇒ W13 红（重启后无从复算）', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M10：解包改回按 url 末段找归档（下载侧仍写 dest）⇒ W14 红 ----
  {
    const restore = mutateFile(
      RUNTIME_SETUP_RS,
      'fn archive_path(root: &Path, e: &FileEntry) -> PathBuf {\n    root.join(&e.dest)\n}',
      'fn archive_path(root: &Path, e: &FileEntry) -> PathBuf {\n    root.join(".download-cache").join(e.url.rsplit(\'/\').next().unwrap_or(&e.url))\n}',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W14');
    check('M10 解包改回按 url 末段找归档 ⇒ W14 红（下完之后报「待解包归档不存在」的那条路）', red, {
      code: r.code,
      redOn: red,
    });
    restore();
  }

  // ---- M11：运行时解包退回"解整份清单"（干净机器第 1 阶段必失败）⇒ W15 红 ----
  {
    const restore = mutateFile(
      RUNTIME_SETUP_RS,
      'extract_entries(runtime_manifest, runtime_root, Some(&py_ids))?;',
      // 变异体要**编得过**（`None` = 解整份清单），否则"没红"会被误读成断言无效 ——
      // 少传一个参数是**编译错误**，那反证的不是断言而是语法。
      'extract_entries(runtime_manifest, runtime_root, None)?;',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W15');
    check('M11 运行时解包退回"解整份清单" ⇒ W15 红（干净机器第 1 阶段报「待解包归档不存在」的那条路）', red, {
      code: r.code,
      redOn: red,
    });
    restore();
  }

  // ---- M12：镜像套回 codeload（ghfast 不代理它 ⇒ 死链）⇒ W16 红 ----
  {
    const restore = mutateFile(
      RUNTIME_MANIFEST,
      'https://ghfast.top/https://github.com/zyddnys/manga-image-translator/archive/',
      'https://ghfast.top/https://codeload.github.com/zyddnys/manga-image-translator/tar.gz/',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W16');
    check('M12 镜像套回 codeload（ghfast 不代理它，实测 403）⇒ W16 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M13：原 `url` 的 owner 拼错一个字母（`zyddnys` → `zydnnys`）⇒ W16 红 ----
  {
    const restore = mutateFile(
      RUNTIME_MANIFEST,
      'https://codeload.github.com/zyddnys/manga-image-translator/tar.gz/',
      'https://codeload.github.com/zydnnys/manga-image-translator/tar.gz/',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W16');
    check('M13 原 `url` 的 owner 拼错一个字母 ⇒ W16 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M14（D-233）：把 `prepare` 从 `stage` 的映射里摘掉 ⇒ W4 红 ----
  // 🔴 这个变异反的是**最容易被忽略的退化路径**：`prepare` 落到 `other => Some(other)` 兜底
  //    ⇒ `stage = "prepare"` ⇒ `DownloadPanel` 的 `ROUND_TEXT['prepare']` 是 `undefined`
  //    ⇒ 两轮指示器在准备期**整块消失**。它不会让任何服务起不来，所以没有任何别的断言会红。
  {
    const restore = mutateFile(
      STATE_RS,
      '"prepare" | "runtime" | "visual" => Some("stage1".to_string()),',
      '"runtime" | "visual" => Some("stage1".to_string()),',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W4');
    check('M14 `prepare` 不再归 stage1（下载页两轮指示器会整块消失）⇒ W4 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M15（D-233）：`step` 映射不接 visual（五段时间线永远停在 runtime）⇒ W4 红 ----
  {
    const restore = mutateFile(STATE_RS, '"visual" => Some("visual".to_string()),', '"visual" => d.step.take(),');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W4');
    check('M15 `step` 不映射 visual 段（五段时间线永远停在第 2 段）⇒ W4 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M15b（D-233）：第 2 轮不再发 `llm` 阶段事件 ⇒ W4 红 ----
  {
    const restore = mutateFile(FETCH_MODELS_RS, 'if args.max_stage == Some(2) {', 'if false {');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W4');
    check('M15b 第 2 轮不发 llm 事件（流程停在视觉段）⇒ W4 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M16（D-231⑤）：`persist()` 退回直写目标文件（非原子）⇒ W17 红 ----
  {
    const restore = mutateFile(
      STATE_RS,
      'if std::fs::write(&tmp, &s).is_err() {',
      'if std::fs::write(&p, &s).is_err() {',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W17');
    check('M16 `persist()` 退回直写目标文件（读到半截文件 ⇒ 弹回引导页）⇒ W17 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M17（D-231⑤）：`isDownloadActive` 退回只认三态 ⇒ W18 红 ----
  {
    const restore = mutateFile(
      ENGINE_DOWNLOAD_TS,
      "  return view.state === 'idle' && view.startedAt != null;",
      '  return false;',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W18');
    check('M17 `isDownloadActive` 退回只认三态（抖动又会把下载视图卸载掉）⇒ W18 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M18（D-231⑦）：③ 的失败文案退回一律"启动超时" ⇒ W19 红 ----
  {
    const restore = mutateFile(
      SUPERVISOR_RS,
      '                (String::from("子进程已退出"), format!("③ LLM 进程已退出（{c}），不是慢 —— 再等也不会好"))',
      '                (String::from("启动超时"), format!("③ LLM 未在 {secs}s 内就绪"))',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W19');
    check('M18 ③ 进程已退出也报「启动超时」（排障被引向"是不是慢"）⇒ W19 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M19（D-231⑦）：`--use-gpu` 退回恒真（CPU 版 torch 的机器 ⇒ 引擎一起来就自杀）⇒ W20 红 ----
  {
    const restore = mutateFile(
      ENGINE_RS,
      '    let use_gpu = o.use_gpu.unwrap_or_else(default_use_gpu);',
      '    let use_gpu = o.use_gpu.unwrap_or_else(|| env_bool("MIAO_ENGINE_USE_GPU", true));',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W20');
    check('M19 `--use-gpu` 退回恒 true（机器没 GPU 时引擎起来就自杀）⇒ W20 红', red, { code: r.code, redOn: red });
    restore();
  }

  // ---- M20（D-231⑦）：自检结论不落盘（启动期又只能回去猜 ⇒ W21 红 ----
  //      🔴 为什么不改别的：这条是 W20 与 W21 之间**唯一**的接缝 —— 不落盘，`default_use_gpu()`
  //         读到的永远是 `null`，装配期测得再准也没用。把 py 索引那一节改成恒 CU 反而
  //         **不会**让这条断言红（它钉的是"这套东西存在"，不是"分支怎么走"），那是假反证。
  {
    const restore = mutateFile(RUNTIME_SETUP_RS, '        "cudaAvailable": cuda_available,\n', '');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W21');
    check('M20 CUDA 自检结论不写进 `.runtime.ready.json`（启动期又只能回去猜）⇒ W21 红', red, {
      code: r.code,
      redOn: red,
    });
    restore();
  }

  // 收尾：确认还原到位
  {
    const bad = [];
    if (!fs.readFileSync(ENGINE_DOWNLOAD_TS, 'utf8').includes("text: '引擎下载中',"))
      bad.push('engine-download.ts 残留 M1');
    if (fs.readFileSync(RUNTIME_MANIFEST, 'utf8').includes('"sha256": ""')) bad.push('runtime.manifest.json 残留 M2');
    {
      const shape = engineSourceShape();
      if (!shape.urlOk || shape.badSources.length > 0)
        bad.push('runtime.manifest.json 残留 M12 / M13（engine_source 的 URL 形态）');
    }
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('"prepare" | "runtime" | "visual" => Some("stage1"'))
      bad.push('state.rs 残留 M3');
    if (!fs.readFileSync(RUNTIME_PROBE_RS, 'utf8').includes('点「开始下载」，喵坞会自动装配引擎运行时'))
      bad.push('runtime_probe.rs 残留 M4');
    if (!fs.readFileSync(RUNTIME_PROBE_RS, 'utf8').includes('装配会从公网镜像安装引擎依赖'))
      bad.push('runtime_probe.rs 残留 M5');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('if stage == Some(1) {')) bad.push('state.rs 残留 M6');
    if (
      fs
        .readFileSync(MODELS_MANIFEST, 'utf8')
        .includes('"stage": 2,\n      "platform": "win32-x64",\n      "dest": "bin/llama')
    )
      bad.push('models.manifest.json 残留 M7');
    if (!fs.readFileSync(DOWNLOAD_COPY_TS, 'utf8').includes('检测 / OCR / 抹字 / 字体'))
      bad.push('DownloadPanel.tsx 残留 M8');
    if (!fs.readFileSync(RUNTIME_SETUP_RS, 'utf8').includes('"longPath": longpath.map'))
      bad.push('runtime_setup.rs 残留 M9');
    if (
      !fs
        .readFileSync(RUNTIME_SETUP_RS, 'utf8')
        .includes('extract_entries(runtime_manifest, runtime_root, Some(&py_ids))?;')
    )
      bad.push('runtime_setup.rs 残留 M11');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('"prepare" | "runtime" | "visual" => Some("stage1"'))
      bad.push('state.rs 残留 M14');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('"models" => Some("models".to_string())'))
      bad.push('state.rs 残留 M15');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('if std::fs::write(&tmp, &s).is_err() {'))
      bad.push('state.rs 残留 M16');
    if (!fs.readFileSync(ENGINE_DOWNLOAD_TS, 'utf8').includes("view.state === 'idle' && view.startedAt != null"))
      bad.push('engine-download.ts 残留 M17');
    if (!fs.readFileSync(SUPERVISOR_RS, 'utf8').includes('子进程已退出')) bad.push('supervisor.rs 残留 M18');
    if (!fs.readFileSync(ENGINE_RS, 'utf8').includes('o.use_gpu.unwrap_or_else(default_use_gpu)'))
      bad.push('engine.rs 残留 M19');
    if (!fs.readFileSync(RUNTIME_SETUP_RS, 'utf8').includes('"cudaAvailable": cuda_available,'))
      bad.push('runtime_setup.rs 残留 M20');
    check('R1 变异收尾：十九处源码/清单按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
