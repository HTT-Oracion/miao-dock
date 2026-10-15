#!/usr/bin/env node
/**
 * 共享夹具：造一份「全就绪 / 缺指定几样」的假引擎运行时。
 * =============================================================================
 * 判据的默认落点是 `<appData>/runtimes/manga-translator`（B1）⇒ 验收若用真实落点，
 * 就会去 `stat` 用户机器上的引擎安装，结果随机器而变、且会误判。故各场景都用
 * `MIAO_RUNTIME_ROOT` / `MIAO_ENGINE_DIR` / `MIAO_ENGINE_PYTHON` 把判据指到 TMP，
 * 与 `MIAO_ROOT` / `MIAO_STATE_DIR` 一律指 TMP 是同一条纪律。
 *
 * 谁在用：`runtime-probe-check.mjs`（B2/B5 的逐项翻转）、`launch-gate-check.mjs`（D6 闸门）。
 * 抽成共享模块而不是各写一份：两份夹具漂移时，「A 脚本说就绪、B 脚本说没就绪」
 * 这种自相矛盾会非常难查（同 B3 的理由，只是换了个位置）。
 *
 * 🔴 补丁文件按 **Node 侧 SSOT**（`ENGINE_PATCHES`）生成 ⇒ 顺带验证 Rust 镜像
 *    （`mangasvc::engine::patches`）的落点与 SSOT 一致：镜像若指错文件，
 *    「全就绪」场景就会报「缺补丁」。
 * 🔴 同一文件可能被多条补丁共享（`nllb.py` ×2、`text_render.py` ×3）⇒ **追加**而非覆写，
 *    否则先写的 mark 被后写的抹掉（症状：补丁明明打全了却报没打）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_PATCHES, SRC_DIR } from '../../engine/scripts/setup-engine.mjs';

/// Node 侧 SSOT 记的是**绝对路径**（`srcPy(...)`）；夹具要的是相对源码目录的段。
export const relOf = (p) => path.relative(SRC_DIR, p.file).split(path.sep);

/**
 * 建一份「全就位」的假引擎运行时；`missing` 指定要拆掉哪几样。
 *
 * 可选值：`python` / `source` / `deps` / `patches` / `venvRoot`（后者是级联场景：
 * 整个运行时候选 ⇒ 其余各项的判据路径都在它下面，必然一起翻）。
 *
 * @returns {{ rt: string, src: string, venv: string, env: Record<string,string> }}
 */
export function buildRuntime(base, missing = []) {
  const rt = path.join(base, 'rt');
  const src = path.join(rt, 'manga-translator', 'src');
  const venv = path.join(rt, 'manga-translator', 'venv');
  fs.mkdirSync(path.join(src, 'server'), { recursive: true });
  fs.mkdirSync(path.join(src, 'manga_translator'), { recursive: true });
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(venv, 'Scripts'), { recursive: true });
    fs.mkdirSync(path.join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'Scripts', 'python.exe'), 'MZ-fixture');
  } else {
    fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(venv, 'lib', 'python3.11', 'site-packages', 'torch'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'bin', 'python'), '#!/bin/sh\n');
  }
  fs.writeFileSync(path.join(src, 'server', 'main.py'), '# fixture\n');
  // B5：补丁目标文件按 SSOT 造（mark 写进去 = "补丁已打"）
  for (const p of ENGINE_PATCHES) {
    const f = path.join(src, ...relOf(p));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `# fixture\n${p.mark}\n`);
  }
  if (missing.includes('patches')) {
    // 抹掉**第一条**补丁的 mark（确定性地选同一条，别随机）
    const p = ENGINE_PATCHES[0];
    const f = path.join(src, ...relOf(p));
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(p.mark).join(''), 'utf8');
  }
  if (missing.includes('python'))
    fs.rmSync(path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true, force: true });
  if (missing.includes('source')) fs.rmSync(path.join(src, 'server'), { recursive: true, force: true });
  if (missing.includes('deps'))
    fs.rmSync(path.join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true, force: true });
  if (missing.includes('venvRoot')) fs.rmSync(path.join(rt, 'manga-translator'), { recursive: true, force: true });
  return {
    rt,
    src,
    venv,
    env: {
      MIAO_RUNTIME_ROOT: rt,
      MIAO_ENGINE_DIR: src,
      MIAO_ENGINE_PYTHON: path.join(
        venv,
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
      ),
    },
  };
}
