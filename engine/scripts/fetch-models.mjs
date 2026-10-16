#!/usr/bin/env node
/**
 * fetch-models.mjs —— S3 模型下载器的命令行入口
 * =============================================================================
 * 用法：
 *   node engine/scripts/fetch-models.mjs                      # 拉全套（visual + llm + runtime）
 *   node engine/scripts/fetch-models.mjs --set visual         # 只拉视觉模型（默认流水线必需）
 *   node engine/scripts/fetch-models.mjs --set translation    # 只拉英译中权重（nllb，2.3 GiB）
 *   node engine/scripts/fetch-models.mjs --id ocr_48px        # 只拉一个
 *   node engine/scripts/fetch-models.mjs --check              # 只校验、不联网（含 HF 缓存布局可解析性）
 *   node engine/scripts/fetch-models.mjs --set runtime --extract   # 拉 llama.cpp 并解包
 *   node engine/scripts/fetch-models.mjs --integrity cached   # 应用启动口径（命中 .ready 就不重算哈希）
 *   node engine/scripts/fetch-models.mjs --link               # **只重建引擎树里的链接**（零网络）
 *   node engine/scripts/fetch-models.mjs --no-link            # 拉完不建链
 *
 * 🔴 `--link` 是「引擎换版本」后的收尾动作：权威副本在 store（models-store/），
 *    引擎源码树 `src/models/` 里那几份只是硬链接；`src/` 被换掉后跑这一条即可恢复，
 *    **不需要重下几个 GB**（依据与理由见 manifest 的 linkNote）。
 *
 * 环境变量：MIAO_MODEL_ROOT 覆盖模型根目录（默认 <appData>/runtimes/manga-translator/）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ensureModels,
  verifyModels,
  verifyHfCache,
  linkModels,
  matchesPlatform,
  ModelStoreError,
} from '../model-store.mjs';
import { runtimesDir } from './runtime-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DEFAULT_MANIFEST = path.join(REPO, 'engine', 'models.manifest.json');

/**
 * 🔴 `--manifest` / `--root` / `--report` / `--progress-log` 是为**双靶取证**加的（A3d）。
 *    Node 版原先把清单与模型根**写死**，而 `check:models` 的对拍必须用**夹具清单** ——
 *    否则两靶都在比对真清单，夹具 HTTP 服务器根本没人打。`--report` / `--progress-log`
 *    把结构化结果落到盘上，让两靶能被同一套谓词读（"解析 stdout 文本"做不到这一点）。
 */
function parseArgs(argv) {
  const out = {
    ids: [],
    set: null,
    integrity: 'cached',
    check: false,
    extract: false,
    linkOnly: false,
    noLink: false,
    manifest: null,
    root: null,
    linkBase: null,
    report: null,
    progressLog: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--set') out.set = argv[++i];
    else if (a === '--id') out.ids.push(argv[++i]);
    else if (a === '--integrity') out.integrity = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--link-base') out.linkBase = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--progress-log') out.progressLog = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--extract') out.extract = true;
    else if (a === '--link') out.linkOnly = true;
    else if (a === '--no-link') out.noLink = true;
    else if (a === '-h' || a === '--help') {
      out.help = true;
    } else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/** 逐行 JSON 进度（与 Rust 侧 `--progress-log` 同格式）。 */
function makeProgressSink(file) {
  let fd = null;
  if (file) fd = fs.openSync(file, 'w');
  return {
    push(p) {
      if (fd != null) fs.writeSync(fd, `${JSON.stringify(p)}\n`);
    },
    close() {
      if (fd != null) {
        fs.closeSync(fd);
        fd = null;
      }
    },
  };
}

const human = (n) => {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  const manifestPath = args.manifest || DEFAULT_MANIFEST;
  // 🔴 B1：与服务同源（`config.mjs` 的 `engineModelDir` 注释同样要求这一点）——
  //    一边读仓库 `runtimes/`、一边读 `<appData>/runtimes/` 会「两边都报成功」。
  const ROOT = args.root || process.env.MIAO_MODEL_ROOT || runtimesDir();
  const sink = makeProgressSink(args.progressLog);
  const writeReport = (payload) => {
    if (args.report) fs.writeFileSync(args.report, `${JSON.stringify(payload, null, 2)}\n`);
  };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const scope = args.ids.length ? `id=${args.ids.join(',')}` : args.set ? `set=${args.set}` : '全部';
  console.log(`模型根目录：${ROOT}`);
  console.log(
    `清单：v${manifest.manifestVersion} · 引擎 commit ${manifest.engineCommit.slice(0, 12)} · 范围：${scope}`,
  );

  if (args.check) {
    const r = await verifyModels(manifest, {
      rootDir: ROOT,
      ids: args.ids,
      set: args.set,
      onProgress: (p) => sink.push(p),
    });
    console.log(`校验：通过 ${r.ok.length} / 不符 ${r.bad.length} / 缺失 ${r.missing.length}（共 ${r.total}）`);
    for (const b of r.bad)
      console.log(`  ✗ ${b.id}：盘上 ${b.actual.slice(0, 12)}… ≠ 清单 ${b.expected.slice(0, 12)}…`);
    for (const m of r.missing) console.log(`  ✗ ${m}：缺失`);

    // —— HF 缓存布局（带 `hf` 的条目）：光有 blobs 不够，HF 认的是 snapshots/<rev>/<file> + refs/main。
    //    这一节是"链接建完了、权重还是不被引擎认"的唯一承担者（见 docs/internal/spec-notes.md D-99）。
    const hf = await verifyHfCache(manifest, { rootDir: ROOT, ids: args.ids, set: args.set, linkBase: args.linkBase });
    if (hf.total) {
      console.log(`HF 缓存布局：可解析 ${hf.ok.length} / 不可解析 ${hf.missing.length}（共 ${hf.total}）`);
      for (const m of hf.missing) {
        console.log(
          `  ✗ ${m.id}：snapshot=${m.snapshot ? '有' : '缺'} store=${m.store ? '有' : '缺'} refs/main=${m.refs ? '对' : '缺或不对'}`,
        );
      }
    }
    writeReport({ verify: r, hf });
    sink.close();
    return r.bad.length || r.missing.length || hf.missing.length ? 1 : 0;
  }

  // —— 只重建链接（引擎换版本后的收尾动作，零网络）
  if (args.linkOnly) {
    const l = await linkModels(manifest, {
      rootDir: ROOT,
      ids: args.ids,
      set: args.set,
      linkBase: args.linkBase,
      logger: (m) => console.log(m),
    });
    console.log(`链接基准：${l.base}`);
    console.log(
      `链接：新建 ${l.linked.length} · 已是 ${l.already.length} · 复制 ${l.copied.length} · 跳过 ${l.skipped.length}（共 ${l.total}）`,
    );
    if (l.hf.length) console.log(`HF 缓存布局：补齐 ${l.hf.length} 个条目的 snapshot + refs/main`);
    writeReport({ link: l });
    sink.close();
    if (l.skipped.length) {
      console.log('✗ 有跳过项 ⇒ store 里还缺资产，先跑一次下载。');
      return 1;
    }
    return 0;
  }

  let last = '';
  const r = await ensureModels(manifest, {
    rootDir: ROOT,
    ids: args.ids,
    set: args.set,
    integrity: args.integrity,
    logger: (m) => console.log(m),
    onProgress: (p) => {
      sink.push(p);
      const line = `${p.id} ${p.phase} ${human(p.received)}/${human(p.total)}`;
      if (line !== last) {
        last = line;
        process.stdout.write(`\r${line.padEnd(60)}`);
      }
    },
  });
  process.stdout.write(`\r${' '.repeat(60)}\r`);
  console.log(
    `复用 ${r.reused.length} · 下载 ${r.downloaded.length} · 因校验重下 ${r.redownloaded.length} · 传输 ${human(r.bytes)}`,
  );
  for (const [id, from] of Object.entries(r.resumeFrom)) {
    if (from > 0) console.log(`  续传：${id} 从 ${human(from)} 接着下`);
  }

  // —— 把 store 里的权威副本链进引擎源码树（视觉模型必须出现在 <引擎>/src/models/ 下）
  let linked = null;
  if (!args.noLink) {
    linked = await linkModels(manifest, { rootDir: ROOT, ids: args.ids, set: args.set, linkBase: args.linkBase });
    console.log(
      `链接：新建 ${linked.linked.length} · 已是 ${linked.already.length} · 复制 ${linked.copied.length} · 跳过 ${linked.skipped.length}`,
    );
    if (linked.hf.length) console.log(`HF 缓存布局：补齐 ${linked.hf.length} 个条目的 snapshot + refs/main`);
  }
  writeReport({ ensure: r, link: linked });
  sink.close();

  if (args.extract) {
    // 按**当前平台**挑选带 `extractTo` 的 runtime 条目（Mac = macos tar.gz；Windows = win zip + cudart）。
    // 归档都用 `tar -xf` 解（Windows 10 自带 bsdtar，能解 zip 与 tar.gz）。
    const targets = (manifest.files || []).filter((f) => f.extractTo && matchesPlatform(f));
    if (!targets.length) throw new Error('清单里没有适用于当前平台的可解包条目（需要 extractTo 字段）');
    for (const entry of targets) {
      const arcAbs = path.join(ROOT, entry.dest);
      if (!fs.existsSync(arcAbs)) {
        console.log(`  跳过 ${entry.id}：归档不在 ${arcAbs}（先跑一次下载）`);
        continue;
      }
      const outDir = path.join(ROOT, entry.extractTo);
      fs.mkdirSync(outDir, { recursive: true });
      // 归档一般带一个顶层目录 ⇒ 默认 strip 掉第 1 层，让内容直接落在 outDir。
      const strip = entry.extractStrip ?? 1;
      const tarArgs = ['-xf', arcAbs, '-C', outDir];
      if (strip > 0) tarArgs.push(`--strip-components=${strip}`);
      const rc = spawnSync('tar', tarArgs, { stdio: 'inherit' });
      if (rc.status !== 0) throw new Error(`解包失败（exit ${rc.status}）：${arcAbs}`);
      console.log(`  已解包 ${entry.id} → ${outDir}`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ModelStoreError) console.error(`\n✗ [${err.code}] ${err.message}`);
    else console.error(`\n✗ ${err.stack || err.message}`);
    process.exit(1);
  });
