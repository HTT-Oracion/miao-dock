#!/usr/bin/env node
/**
 * F2 路径快照的归一化 + Rust 侧取证 —— golden 生成器与对拍脚本**共用的唯一一份**。
 * =============================================================================
 * 为什么单独一个文件：`check:paths` 原先是「Rust `--print-paths` ⟷ Node `service/src/config.mjs`」
 * 双靶对拍。F5 摘除 Node 服务层后没有对照对象，改以冻结 golden 快照作**单向金标**。
 * golden 里存的是**归一化后**的快照，冻结（`_gen-golden.mjs paths`）与比对
 * （`paths-parity-check.mjs`）必须用同一份规则 —— 两边各写一遍 = 又一处会走散的契约。
 *
 * ## 归一化（只抹「换机器就不同」的量）
 *   · 临时目录（override 场景的 6 个 `MIAO_*` 覆盖目标）→ `<TMP>`
 *   · 仓库根 → `<REPO>`
 *   · 用户 home（`<盘>:\Users\<name>` 任意分隔符）→ `<HOME>`
 *   顺序固定为「先精确后模糊」：TMP → REPO → HOME。反过来的话，仓库若落在 home 之下，
 *   HOME 会先把 repo 的前缀打掉，golden 里就再也看不到 `<REPO>`。
 *
 * 用法：`import { buildScenarios, dumpRust, normSnapshot } from './_paths-report.mjs'`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RUST_BIN } from './_service-harness.mjs';

const TOKEN = 'a'.repeat(64);

/**
 * 两个取证场景（与原双靶对拍的 `SCENARIOS` 逐字同物）：
 *   · `default`  无覆盖 —— 13 个路径的默认落点
 *   · `override` 6 个 `MIAO_*` 全覆盖 —— 覆盖后仍须逐字节可推
 * `override` 的覆盖目标落在**每次新建的临时目录**里（⇒ 必须归一化，否则跨运行假红）。
 */
export function buildScenarios() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-paths-parity-'));
  return [
    { id: 'default', tmp: null, env: {} },
    {
      id: 'override',
      tmp,
      env: {
        MIAO_STATE_DIR: path.join(tmp, 'state'),
        MIAO_ROOT: path.join(tmp, 'root', 'Box 漫画'),
        MIAO_ENGINE_DIR: path.join(tmp, 'eng', 'src'),
        MIAO_ENGINE_PYTHON: path.join(tmp, 'eng', 'venv', 'Scripts', 'python.exe'),
        MIAO_ENGINE_SERVER_DIR: path.join(tmp, 'eng', 'src', 'server'),
        MIAO_MODEL_MANIFEST: path.join(tmp, 'models.json'),
      },
    },
  ];
}

/** 字符串归一化（顺序固定：TMP → REPO → HOME）。 */
export function normStr(s, ctx) {
  let out = s;
  if (ctx.tmp) out = out.split(ctx.tmp).join('<TMP>');
  if (ctx.repo) out = out.split(ctx.repo).join('<REPO>');
  out = out.replace(/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, '<HOME>');
  return out;
}

/** 一份快照（13 个键全是路径字符串）→ 归一化后的同形对象。 */
export function normSnapshot(snap, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(snap || {})) out[k] = typeof v === 'string' ? normStr(v, ctx) : v;
  return out;
}

/** 跑一次 `boxsvc --print-paths`，返回 `paths.rs::snapshot()` 的原始 JSON。 */
export async function dumpRust(env) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  return new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, ['--print-paths'], {
      env: { ...process.env, MIAO_TOKEN: TOKEN, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(`--print-paths 退出码 ${code}：${err.slice(0, 600)}`)),
    );
  });
}

/** 归一化上下文：临时目录 + 仓库根（由调用方从各自目录推导）。 */
export function makeCtx(scenario, repoRoot) {
  return { tmp: scenario.tmp, repo: repoRoot };
}
