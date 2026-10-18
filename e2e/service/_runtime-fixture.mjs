#!/usr/bin/env node
/**
 * 共享夹具：造一份「全就绪 / 缺指定几样」的假引擎运行时。
 * =============================================================================
 * 判据的默认落点是 `<appData>/runtimes/manga-translator`（B1）⇒ 验收若用真实落点，
 * 就会去 `stat` 用户机器上的引擎安装，结果随机器而变、且会误判。故各场景都用
 * `MIAO_MANGA_RUNTIME_ROOT` / `MIAO_ENGINE_DIR` / `MIAO_ENGINE_PYTHON` 把判据指到 TMP，
 * 与 `MIAO_MANGA_ROOT_DIR` / `MIAO_MANGA_STATE_DIR` 一律指 TMP 是同一条纪律。
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
 * 假引擎运行时里那些**走另一条链**的东西（D-231③）。
 *
 * 🔴 为什么要单独造：③ 的可执行体与翻译权重来自模型清单 + `--fetch-models --extract`，
 *    与前五项的 `--engine-bootstrap` **互不覆盖**。夹具不造它们 ⇒ 「全就位」场景会被
 *    新增的 `llm` / `weights` 两项判成未就绪，那不是回归，是夹具没跟上判据。
 *
 * 权重用**小清单 + 精确大小**（`models-guide-check.mjs` 的 `buildSmallFixture` 同款做法）：
 * 真清单的权重是 GB 级，夹具造不出来；而 `model_status` 的就绪判据是"在位且大小一致"，
 * 所以夹具自己写一份清单、清单里的 `sizeBytes` 就等于夹具写出的字节数。
 */
export const LLAMA_VERSION_DIR = 'llama-b11417';

/** 造 `bin/llama/<版本>/llama-server[.exe]`；返回它的绝对路径。 */
function seedLlmBin(rt) {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const p = path.join(rt, 'manga-translator', 'bin', 'llama', LLAMA_VERSION_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, process.platform === 'win32' ? 'MZ-fixture' : '#!/bin/sh\n');
  return p;
}

/** 造一份小模型清单 + 两个权重文件；返回 `{ manifest, root }`。 */
function seedWeights(base) {
  const root = path.join(base, 'model-root');
  const manifest = path.join(base, 'models.manifest.json');
  const files = [
    { id: 'fx-visual', set: 'visual', dest: 'models/fx/visual.bin', sizeBytes: 3 },
    { id: 'fx-llm', set: 'llm', dest: `models/sakura/${LLAMA_VERSION_DIR}.gguf`, sizeBytes: 4 },
    // D-233：翻译权重（nllb）单独一档，用来证明 `sets` 真的把 visual / llm / translation 分开。
    { id: 'fx-nllb', set: 'translation', dest: 'models/translators/nllb.bin', sizeBytes: 2 },
  ];
  for (const f of files) {
    const p = path.join(root, f.dest);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(f.sizeBytes));
  }
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      files,
      sets: {
        visual: { files: ['fx-visual'] },
        llm: { files: ['fx-llm'] },
        translation: { files: ['fx-nllb'] },
      },
    }),
  );
  return { manifest, root, files };
}

/**
 * 建一份「全就位」的假引擎运行时；`missing` 指定要拆掉哪几样。
 *
 * 可选值：`python` / `source` / `deps` / `patches` / `venvRoot`（后者是级联场景：
 * 整个运行时候选 ⇒ 其余各项的判据路径都在它下面，必然一起翻）/ `llm` / `weights`
 * （后两项属模型链，见上面的说明）；以及分档粒度 `visual` / `sakura` / `nllb`
 * （只拆对应 model set，D-233）。
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

  // ---- D-231③：模型链那两样（③ 可执行体 + 翻译权重）----
  // 🔴 必须在下面那批 `missing` 拆除**之前**造：llama 可执行体就落在运行时根底下，
  //    `missing: ['venvRoot']` 那个级联场景要的是"整个运行时候选 ⇒ 里面全没"，
  //    若拆完再补种就会把 `manga-translator/` 又建回来 ⇒ `venvRoot` 反而判成在位
  //    （S4 直接红，且是夹具自己造出来的假红）。
  const llmBin = seedLlmBin(rt);
  const weights = seedWeights(base);

  if (missing.includes('python'))
    fs.rmSync(path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true, force: true });
  if (missing.includes('source')) fs.rmSync(path.join(src, 'server'), { recursive: true, force: true });
  if (missing.includes('deps'))
    fs.rmSync(path.join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true, force: true });
  if (missing.includes('venvRoot')) fs.rmSync(path.join(rt, 'manga-translator'), { recursive: true, force: true });
  if (missing.includes('llm')) fs.rmSync(llmBin, { force: true });
  if (missing.includes('weights')) {
    for (const f of weights.files) fs.rmSync(path.join(weights.root, f.dest), { force: true });
  }
  // D-233：分档粒度 —— 只拆某一档，用来证明 `sets` 不是把三档合成一个布尔。
  for (const [key, id] of [
    ['visual', 'fx-visual'],
    ['sakura', 'fx-llm'],
    ['nllb', 'fx-nllb'],
  ]) {
    if (missing.includes(key)) {
      const f = weights.files.find((x) => x.id === id);
      if (f) fs.rmSync(path.join(weights.root, f.dest), { force: true });
    }
  }
  return {
    rt,
    src,
    venv,
    env: {
      MIAO_MANGA_RUNTIME_ROOT: rt,
      MIAO_ENGINE_DIR: src,
      MIAO_ENGINE_PYTHON: path.join(
        venv,
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
      ),
      // 判据侧的 `llm` / `weights` 两项走模型清单这条接缝，不接就会读到仓库里那份真清单
      // （真清单的权重是 GB 级，夹具永远判不 ready ⇒ 「全就位」场景恒红）。
      MIAO_MODEL_MANIFEST: weights.manifest,
      MIAO_MODEL_ROOT: weights.root,
    },
  };
}
