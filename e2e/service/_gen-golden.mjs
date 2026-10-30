#!/usr/bin/env node
/**
 * golden 快照生成器（F5 摘除 Node 后，对拍检查改「Rust 输出 ⟷ 冻结 golden」）。
 *
 * ## 为什么要有它
 * golden 是「Node 同源对齐时代冻结的最后一份正确输出」。它只能在 Node 还活着时、
 * 且 Rust 与 Node 对拍全绿的前提下生成一次；此后 Node 摘除，golden 就是唯一金标。
 * 未来 Rust 侧**有意**变更契约（字段/顺序/语义）时，改完 Rust 后跑本脚本重新冻结，
 * 并把 diff 写进提交说明 —— 那是有意的迁移，不是漂移。
 *
 * ## 每个 golden 的归一化（跨机器稳定）
 *   · 键排序 + 剔 `updatedAt`（canon）
 *   · 路径归一化：`C:\Users\<name>`（任意转义层级）→ `<HOME>`、仓库根 → `<REPO>`
 *   · 各检查的投影（只比契约面，规避动态端口 / env 大小写折叠）
 *   · `store-exec` 的投影另有一份**共享**规则 `_store-exec-report.mjs`（时间抹平 / 运行目录 /
 *     taskId / 事件 id 拉平）—— 生成与比对共用，避免规则走散。
 *
 * 用法：node e2e/service/_gen-golden.mjs <engine|store-exec>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';
import { collect as collectEngineHttp } from './_engine-http-report.mjs';
import { collectRust } from './_llm-report.mjs';
import { buildScenarios, dumpRust, makeCtx, normSnapshot } from './_paths-report.mjs';
import { freshDirs, projectScenario } from './_store-exec-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GOLDEN_DIR = path.join(HERE, 'golden');

const normStr = (s) =>
  s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, '<HOME>').replaceAll(REPO_ROOT, '<REPO>');

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'updatedAt') continue;
      out[k] = canon(v[k]);
    }
    return out;
  }
  if (typeof v === 'string') return normStr(v);
  return v;
}

function run(args, env = {}) {
  const r = spawnSync(RUST_BIN, args, {
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`${args[0]} 退出码 ${r.status}：${(r.stderr || '').slice(0, 500)}`);
  return r.stdout;
}

function write(name, obj) {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const f = path.join(GOLDEN_DIR, `${name}.json`);
  // 🔴 行尾纪律：golden 是文本产物，与既有 golden 一样落 CRLF（`JSON.stringify` 只给 `\n`）
  fs.writeFileSync(f, JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n'));
  console.log(`✓ golden → ${path.relative(REPO_ROOT, f)}（${fs.statSync(f).size} 字节）`);
}

// ------------------------------------------------------------------ engine（F4）
function genEngine() {
  const projLaunch = (l) => {
    const env = l.env || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
    const injected = {};
    for (const k of ['PYTHONIOENCODING', 'SAKURA_API_BASE', 'MT_WEB_NONCE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'])
      injected[k] = has(k) ? env[k] : null;
    const noProxy = (has('NO_PROXY') ? env.NO_PROXY : has('no_proxy') ? env.no_proxy : null) ?? null;
    return {
      label: l.label,
      cmd: l.cmd,
      cwd: l.cwd ?? null,
      executorPort: l.executorPort ?? null,
      probes: l.probes,
      envInjected: injected,
      noProxy,
    };
  };
  const projLlm = (l) =>
    l && l.error
      ? { error: l.error }
      : {
          label: l.label,
          tier: l.tier ?? null,
          model: l.model ?? null,
          cmd: l.cmd,
          cwd: l.cwd ?? null,
          probes: l.probes,
        };
  const projFrames = (frames) =>
    frames.map((f) => ({
      name: f.name,
      resultB64: f.resultB64 ?? null,
      ext: f.ext ?? null,
      mime: f.mime ?? null,
      stageLines: f.stageLines,
    }));

  const proj = (o) => ({
    constants: canon(o.constants),
    engineVersion: o.engineVersion,
    pure: canon(o.pure),
    configSnapshot: canon(o.configSnapshot),
    launch: canon(projLaunch(o.launch)),
    llmLaunch: canon(projLlm(o.llmLaunch)),
    frames: o.pure.parseResultStream ? canon(projFrames(o.pure.parseResultStream)) : null,
  });

  const real = JSON.parse(
    run(['--engine-selftest'], {
      MIAO_ENGINE_PROTOCOL: 'real',
      MIAO_ENGINE_PYTHON: '/py/python',
      NO_PROXY: 'parity.example',
      MIAO_ENGINE_PROBE_MS: '400',
    }),
  );
  const mock = JSON.parse(
    run(['--engine-selftest'], { MIAO_ENGINE_PROTOCOL: 'mock', MIAO_ENGINE_DETECTION_SIZE: '1024' }),
  );
  write('engine-selftest', { real: proj(real), mock: proj(mock) });
}

// ------------------------------------------------------------------ store-exec（F3-b）
function genStoreExec() {
  const dirs = freshDirs('gen');
  const raw = run(['--store-exec-selftest'], {
    MIAO_MANGA_ROOT_DIR: dirs.root,
    MIAO_MANGA_STATE_DIR: dirs.state,
    MIAO_TOKEN: 'a'.repeat(64),
    MIAO_ENGINE_PROTOCOL: 'mock',
  });
  const scenarios = JSON.parse(raw).scenarios.map((sc) => projectScenario(sc, dirs));
  write('store-exec-selftest', { scenarios });
}

// ------------------------------------------------------------------ paths（F2）
async function genPaths() {
  const scenarios = buildScenarios();
  const out = {};
  for (const sc of scenarios) {
    const snap = await dumpRust(sc.env);
    out[sc.id] = normSnapshot(snap, makeCtx(sc, REPO_ROOT));
  }
  write('paths-selftest', out);
}

// ------------------------------------------------------------------ llm-supervisor（F4-b2）
async function genLlmSupervisor() {
  const results = await collectRust();
  write('llm-selftest', { results });
}

// ------------------------------------------------------------------ engine-http（F4-b）
async function genEngineHttp() {
  const { results, payloads } = await collectEngineHttp();
  write('engine-http-selftest', { results, payloads });
}

// ------------------------------------------------------------------ translate（F5.5 纯逻辑面）
// 只冻结 `--translate-selftest`（纯逻辑报告）：运行时用例要打 Node 侧假上游，
// 是**活体**断言面（由 `check:translate` 的假上游 + 反证开关把守），不进 golden。
function genTranslate() {
  write('translate-selftest', JSON.parse(run(['--translate-selftest'])));
}

// ------------------------------------------------------------------ 入口
const which = process.argv[2];
if (which === 'engine') genEngine();
else if (which === 'store-exec') genStoreExec();
else if (which === 'paths') await genPaths();
else if (which === 'llm-supervisor') await genLlmSupervisor();
else if (which === 'engine-http') await genEngineHttp();
else if (which === 'translate') genTranslate();
else
  throw new Error(
    `未知 golden 目标：${which}（现支持：engine / store-exec / paths / llm-supervisor / engine-http / translate）`,
  );
