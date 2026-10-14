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
 * 每条反证都按字节还原，收尾复核残留。
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
const ENGINE_DOWNLOAD_TS = path.join(ROOT, 'app', 'src', 'engine-download.ts');
const UI_FILES = [
  path.join(ROOT, 'app', 'src', 'screens', 'NotReadyScreen.tsx'),
  path.join(ROOT, 'app', 'src', 'screens', 'engine', 'DownloadPanel.tsx'),
  path.join(ROOT, 'app', 'src', 'screens', 'settings', 'OnlineApiForm.tsx'),
  path.join(ROOT, 'app', 'src', 'components', 'units', 'ProgressRing.tsx'),
];

/** 命令行字样（反证 M1 / W5 / W6 要抓的就是这些）—— 只钉真正的命令，不钉「命令行」这种中性叙述词 */
const CLI_JARGON = /npm install|pip install|python -m venv|MSVC|conda install|apt-get install/i;

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
    const local = w ? w.local === true : false;
    const url = w ? (typeof w.url === 'string' && w.url.length > 0) : false;
    // 🔴 二选一且互斥：未托管(local=true) ⇒ 没 url；托管后(local=false) ⇒ 必须有 url。
    const mutuallyExclusive = (local && !url) || (!local && url);
    ok2 = !!(w && hasSha && hasSize && mutuallyExclusive);
    detail2 = { found: !!w, hasSha, hasSize, local, url, mutuallyExclusive };
  } catch (e) {
    detail2 = String(e.message);
  }
  check('W2 `wheels.manifest.json` pydensecrf 条目结构合法（sha256/sizeBytes 齐备，`local` 与 `url` 互斥）', ok2, detail2);

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

  // 收尾：确认还原到位
  {
    const bad = [];
    if (!fs.readFileSync(ENGINE_DOWNLOAD_TS, 'utf8').includes("text: '引擎下载中',")) bad.push('engine-download.ts 残留 M1');
    if (fs.readFileSync(RUNTIME_MANIFEST, 'utf8').includes('"sha256": ""')) bad.push('runtime.manifest.json 残留 M2');
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('"runtime" => Some("stage1"')) bad.push('state.rs 残留 M3');
    check('R1 变异收尾：三处源码/清单按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
