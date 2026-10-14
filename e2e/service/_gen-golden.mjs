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
 *
 * 用法：node e2e/service/_gen-golden.mjs <engine|store-exec|...>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GOLDEN_DIR = path.join(HERE, 'golden');

const normStr = (s) => s
  .replace(/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, '<HOME>')
  .replaceAll(REPO_ROOT, '<REPO>');

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
  const r = spawnSync(RUST_BIN, args, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${args[0]} 退出码 ${r.status}：${(r.stderr || '').slice(0, 500)}`);
  return r.stdout;
}

function write(name, obj) {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const f = path.join(GOLDEN_DIR, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  console.log(`✓ golden → ${path.relative(REPO_ROOT, f)}（${fs.statSync(f).size} 字节）`);
}

// ------------------------------------------------------------------ engine（F4）
function genEngine() {
  const projLaunch = (l) => {
    const env = l.env || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
    const injected = {};
    for (const k of ['PYTHONIOENCODING', 'SAKURA_API_BASE', 'MT_WEB_NONCE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE']) injected[k] = has(k) ? env[k] : null;
    const noProxy = (has('NO_PROXY') ? env.NO_PROXY : has('no_proxy') ? env.no_proxy : null) ?? null;
    return { label: l.label, cmd: l.cmd, cwd: l.cwd ?? null, executorPort: l.executorPort ?? null, probes: l.probes, envInjected: injected, noProxy };
  };
  const projLlm = (l) => (l && l.error ? { error: l.error } : { label: l.label, tier: l.tier ?? null, model: l.model ?? null, cmd: l.cmd, cwd: l.cwd ?? null, probes: l.probes });
  const projFrames = (frames) => frames.map((f) => ({ name: f.name, resultB64: f.resultB64 ?? null, ext: f.ext ?? null, mime: f.mime ?? null, stageLines: f.stageLines }));

  const proj = (o) => ({
    constants: canon(o.constants),
    engineVersion: o.engineVersion,
    pure: canon(o.pure),
    configSnapshot: canon(o.configSnapshot),
    launch: canon(projLaunch(o.launch)),
    llmLaunch: canon(projLlm(o.llmLaunch)),
    frames: o.pure.parseResultStream ? canon(projFrames(o.pure.parseResultStream)) : null,
  });

  const real = JSON.parse(run(['--engine-selftest'], { MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PYTHON: '/py/python', NO_PROXY: 'parity.example', MIAO_ENGINE_PROBE_MS: '400' }));
  const mock = JSON.parse(run(['--engine-selftest'], { MIAO_ENGINE_PROTOCOL: 'mock', MIAO_ENGINE_DETECTION_SIZE: '1024' }));
  write('engine-selftest', { real: proj(real), mock: proj(mock) });
}

// ------------------------------------------------------------------ 入口
const which = process.argv[2];
if (which === 'engine') genEngine();
else throw new Error(`未知 golden 目标：${which}（现支持：engine）`);
