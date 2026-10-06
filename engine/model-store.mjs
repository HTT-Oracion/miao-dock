/**
 * model-store.mjs —— S3 模型管理内核（引擎侧）
 * =============================================================================
 * 职责：把 `engine/models.manifest.json` 里声明的外部资产（视觉模型 / LLM 权重 / 外部二进制）
 *      拉到 `runtimes/manga-translator/`（模型根目录，可用 MIAO_MODEL_ROOT 覆盖）。
 *
 * 能力（对应交付计划 §S3）：HTTPS 源（多通道按序回退）· **断点续传** · **逐文件 SHA256** ·
 *      失败**单文件**重下 · `.ready` **幂等**标记 · 逐文件进度 · 可暂停/恢复。
 *
 * 🔴 三个"看起来能用、其实会静默出错"的点，都在这里显式处理：
 *   ① **Range 请求的服务器可能不支持** —— 我们发 `Range` 而对方回 **200（全量）**是合法行为，
 *      此时**必须截断进度重新计**，否则会把整包追加到 `.part` 后面，得到一个"大小对不上、
 *      哈希必然不符"的文件。判 206 与 200 是两件事，不能只看 `res.ok`。
 *   ② **`Content-Length` 在续传时是"剩余长度"不是"总长度"** —— 进度要用 `Content-Range` 的
 *      total（`bytes a-b/total`），否则进度条走到 100% 却只下了半截。
 *   ③ **校验失败必须重下，但只许一次** —— 无限重试会在"源本身是坏的"时变成一个不报错的死循环。
 *
 * 本模块**不做网络判断之外的事**：不下载引擎源码、不 pip install、不解包（解包是 CLI 的 `--extract`）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

/** `.ready` 标记文件名（放在模型根目录下）。 */
export const READY_MARKER = '.models.ready.json';
/** 未完成下载的临时文件后缀。它就是"断点"本体 —— 存在即有进度。 */
export const PART_SUFFIX = '.part';

/** 校验失败后允许的**自动重下**次数（1 = 重下一次；再失败就报错，不静默）。 */
export const REDOWNLOAD_LIMIT = 1;

/** 带错误码的失败。调用方据此区分"网络问题"与"内容坏了"。 */
export class ModelStoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ModelStoreError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 反证开关（**只给测试用**；产品路径不得设置这些变量）。
 * 每个开关都对应断言里的一条"这个机制真的在起作用" —— 关掉它，那条断言必须变红。
 */
export function refuteFlags(env = process.env) {
  return {
    noVerify: env.MIAO_NO_MODEL_VERIFY === '1', // 关掉 SHA256 校验
    noResume: env.MIAO_NO_RESUME === '1',       // 关掉断点续传（每次从 0 重来）
    noReady: env.MIAO_NO_READY === '1',         // 关掉 .ready 幂等标记
    noLink: env.MIAO_NO_LINK === '1',           // 关掉"把 store 链进引擎树"这一步
  };
}

// ------------------------------------------------------------------ 基础工具

const log = (fn, msg) => { if (fn) fn(msg); };

async function sizeOf(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

export async function statSafe(p) {
  try {
    const s = await fsp.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev };
  } catch { return null; }
}

/** 流式算 sha256（不把文件读进内存 —— Sakura 权重有 3.3 GB）。 */
export async function sha256File(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    const onAbort = () => rs.destroy(new ModelStoreError('MODEL_ABORTED', '校验被中止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (err, v) => {
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(v);
    };
    rs.on('data', (c) => h.update(c));
    rs.on('error', (e) => done(e));
    rs.on('end', () => done(null, h.digest('hex')));
  });
}

/** 选中要处理的文件：`ids` 优先，其次 `set`，都没有则全量。 */
export function selectFiles(manifest, { ids, set } = {}) {
  const all = manifest.files || [];
  if (ids?.length) {
    // 显式点名 id ⇒ **不做平台过滤**：跨平台取证（例如在 Mac 上验 Windows 条目的下载）需要它。
    const want = new Set(ids);
    const picked = all.filter((f) => want.has(f.id));
    const missing = [...want].filter((id) => !all.some((f) => f.id === id));
    if (missing.length) {
      throw new ModelStoreError('MODEL_UNKNOWN_ID', `清单里没有这些 id：${missing.join(', ')}`, { missing });
    }
    return picked;
  }
  // `set` / 全量：**按当前平台过滤** —— 否则在 Windows 上会去下 macos-arm64 的 llama.cpp
  // （平台相关的资产带上 `platform` 字段；无该字段 = 平台无关，恒适用）。
  const key = platformKey();
  if (set) {
    const s = manifest.sets?.[set];
    if (!s) throw new ModelStoreError('MODEL_UNKNOWN_SET', `清单里没有 set「${set}」`, { set });
    const want = new Set(s.files);
    return all.filter((f) => want.has(f.id) && matchesPlatform(f, key));
  }
  return all.filter((f) => matchesPlatform(f, key));
}

/**
 * 当前平台标识，形如 `win32-x64` / `darwin-arm64` —— 与 manifest 条目的 `platform` 字段对齐。
 * 只区分 arm64 与 x64（其余架构原样透传，避免把未知架构误当成 x64）。
 */
export function platformKey(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' || arch === 'x64' ? arch : arch;
  return `${platform}-${a}`;
}

/** 条目是否适用于给定平台（无 `platform` 字段 = 平台无关，恒适用）。 */
export function matchesPlatform(file, key = platformKey()) {
  return !file.platform || file.platform === key;
}

// ------------------------------------------------------------------ .ready 标记

export async function readMarker(rootDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(rootDir, READY_MARKER), 'utf8'));
  } catch { return null; }
}

export async function writeMarker(rootDir, manifest, records) {
  const payload = {
    manifestVersion: manifest.manifestVersion,
    engineCommit: manifest.engineCommit,
    verifiedAt: new Date().toISOString(),
    files: records,
  };
  const p = path.join(rootDir, READY_MARKER);
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await fsp.rename(tmp, p); // 原子替换：半截的 .ready 比没有更危险
  return payload;
}

/**
 * 标记里的记录能否代表**盘上当前这个文件**？
 * 判据 = dest / sha256 / 大小 / mtime 四件全等。
 * ⚠️ mtime 进判据是**故意的**：单靠大小挡不住"篡改一字节"（大小不变），
 *    而每次启动都重算 3.3 GB 的哈希也不可接受。mtime 变了就退回真哈希。
 *    代价：若有人篡改后**把 mtime 改回去**，快速路径会漏 —— 所以
 *    `integrity:'hash'` 始终可达，且诊断/验收路径走的就是它（见 D-72）。
 */
export function markerMatches(rec, dest, st, sha256) {
  return !!rec && rec.dest === dest && rec.sha256 === sha256
    && rec.sizeBytes === st.size && rec.mtimeMs === st.mtimeMs;
}

// ------------------------------------------------------------------ 单文件取回

/** 解析 `Content-Range: bytes 100-999/1000` 的总长。 */
function totalFromContentRange(v) {
  const m = /\/(\d+)\s*$/.exec(v || '');
  return m ? Number(m[1]) : null;
}

/**
 * 单个源在一次**流中断**后的重试次数。
 * ⚠️ 这与 `REDOWNLOAD_LIMIT` 是两件事，别合并：
 *    · 这里是**传输**失败（网络断了）⇒ 从断点接着试，源本身没问题；
 *    · 那里是**内容**失败（校验不符）⇒ 必须丢掉重来，接着试只会拼出一个更坏的文件。
 */
export const RETRY_PER_SOURCE = 3;

/**
 * 把内容落到 `.part`（支持续传）。**不做哈希校验** —— 那是调用方的事。
 *
 * 🔴 每次尝试都**重新量一次盘上 `.part` 的大小**，而不是沿用入参：
 *    上一轮（或上一次调用、或本函数的上一次重试）可能已经写下了一部分字节。
 *    用入参记的旧值会算出错的 Range 起点 —— 症状是"续传成功但文件哈希永远不对"。
 *
 * @returns {{url:string, resumedFrom:number, restarted:boolean, bytes:number}}
 */
async function fetchToPart(partAbs, file, { sources, fetchImpl, signal, onProgress, logger, allowResume = true }) {
  const urls = sources?.length ? sources : [file.url];
  let lastErr = null;

  for (const url of urls) {
    for (let attempt = 0; attempt <= RETRY_PER_SOURCE; attempt += 1) {
      // allowResume=false 是**反证态**（MIAO_NO_RESUME=1）：连重试都不许从断点接，
      // 必须每次从 0 全量下 —— 否则"关掉续传"这个反证根本咬不到东西（见 D-72）。
      const offset = allowResume ? await sizeOf(partAbs) : 0;
      let ws = null;
      try {
        const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
        const res = await fetchImpl(url, { headers, signal });
        if (!res.ok) {
          throw new ModelStoreError('MODEL_HTTP_ERROR', `HTTP ${res.status}：${url}`, { url, status: res.status });
        }

        // 🔴 关键分流：发了 Range 但对方回 200 ⇒ 它给的是**全量**，必须从 0 重新计。
        const acceptsRange = res.status === 206;
        const from = offset > 0 && acceptsRange ? offset : 0;
        const restarted = offset > 0 && !acceptsRange;

        const total = acceptsRange
          ? totalFromContentRange(res.headers.get('content-range'))
          : (res.headers.get('content-length') != null ? Number(res.headers.get('content-length')) : null);

        ws = fs.createWriteStream(partAbs, { flags: from > 0 ? 'a' : 'w' });
        const closed = finished(ws);
        closed.catch(() => {}); // 中止/异常路径由下面的 catch 统一处理，这里吞掉未处理拒绝
        let received = from;
        onProgress?.({ id: file.id, phase: 'downloading', received, total, url, resumed: from > 0 });

        const reader = res.body.getReader();
        for (;;) {
          if (signal?.aborted) throw new ModelStoreError('MODEL_ABORTED', '下载被中止');
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          received += buf.length;
          if (!ws.write(buf)) await once(ws, 'drain');
          onProgress?.({ id: file.id, phase: 'downloading', received, total, url, resumed: from > 0 });
        }
        ws.end();
        await closed;

        return { url, resumedFrom: from, restarted, bytes: received };
      } catch (err) {
        try { ws?.destroy(); } catch { /* 已关 */ }
        // 用户主动中止 ⇒ 立刻上抛，不当作"这个源坏了"去试下一个（否则取消变成慢动作）。
        // 并且**只吐一个错误码**：底层可能是裸的 AbortError，也可能是我们自己的 —— 调用方
        // 不该被迫同时接两种形态（这是最容易漏、漏了就表现为"取消失败"的地方）。
        if (err?.code === 'MODEL_ABORTED') throw err;
        if (signal?.aborted) throw new ModelStoreError('MODEL_ABORTED', '下载被中止', { cause: err?.message });
        lastErr = err;
        if (attempt >= RETRY_PER_SOURCE) {
          log(logger, `  [源放弃] ${url} —— 连试 ${attempt + 1} 次仍失败：${err.message}`);
        } else {
          log(logger, `  [重试] ${url} 第 ${attempt + 1} 次中断（${err.message}）⇒ 从断点接着下`);
        }
      }
    }
  }
  throw lastErr ?? new ModelStoreError('MODEL_NO_SOURCE', `没有可用源：${file.id}`);
}

// ------------------------------------------------------------------ 主流程

/**
 * 确保清单里的文件都就位且校验通过。
 *
 * @param {object} manifest          已解析的 models.manifest.json
 * @param {object} opts
 * @param {string} opts.rootDir      模型根目录（dest 相对于它）
 * @param {string[]} [opts.ids]      只处理这些 id
 * @param {string} [opts.set]        只处理这个 set
 * @param {'hash'|'cached'} [opts.integrity]
 *        'hash'   = **每个文件都重新算 SHA256**（诊断 / 验收口径，慢但不容错）
 *        'cached' = 若 `.ready` 记录的 (sha256,size,mtime) 与盘上一致则跳过哈希（应用启动口径）
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function ensureModels(manifest, opts = {}) {
  const {
    rootDir,
    ids,
    set,
    integrity = 'hash',
    fetchImpl = globalThis.fetch,
    onProgress,
    signal,
    logger,
  } = opts;

  const flags = refuteFlags();
  if (!rootDir) throw new ModelStoreError('MODEL_NO_ROOT', '缺少 rootDir');
  if (integrity !== 'hash' && integrity !== 'cached') {
    throw new ModelStoreError('MODEL_BAD_INTEGRITY', `integrity 只能是 hash | cached，收到「${integrity}」`);
  }

  const files = selectFiles(manifest, { ids, set });
  const prev = flags.noReady ? null : await readMarker(rootDir);
  const records = { ...(prev?.files ?? {}) };

  const result = {
    total: files.length,
    reused: [],        // 已就位且校验通过，本次未动
    downloaded: [],    // 本次（重新）下载成功
    redownloaded: [],  // 因校验不符触发**自动重下**的
    resumeFrom: {},    // id → 续传起点（0 表示从头）
    bytes: 0,
  };

  for (const file of files) {
    const destRel = file.dest;
    const destAbs = path.join(rootDir, destRel);
    const partAbs = `${destAbs}${PART_SUFFIX}`;
    await fsp.mkdir(path.dirname(destAbs), { recursive: true });

    const st = await statSafe(destAbs);
    let needDownload = st == null;

    if (st != null) {
      if (flags.noVerify) {
        // 反证态（MIAO_NO_MODEL_VERIFY=1）：**存在即复用**，完全不看内容。
        // ⚠️ 这一支必须在最前面：否则 integrity:'hash' 会绕开开关去算哈希，反证轮就咬不到东西了。
        result.reused.push(file.id);
        records[file.id] = { dest: destRel, sha256: null, sizeBytes: st.size, mtimeMs: st.mtimeMs };
        log(logger, `  [复用] ${file.id}（⚠️ 未校验）`);
        continue;
      }
      if (integrity === 'cached' && markerMatches(records[file.id], destRel, st, file.sha256)) {
        result.reused.push(file.id);
        log(logger, `  [复用] ${file.id}（.ready 记录与盘上大小/mtime 一致）`);
        continue;
      }
      onProgress?.({ id: file.id, phase: 'verifying', received: 0, total: st.size });
      const got = await sha256File(destAbs, { signal });
      if (got === file.sha256) {
        result.reused.push(file.id);
        records[file.id] = { dest: destRel, sha256: got, sizeBytes: st.size, mtimeMs: st.mtimeMs };
        log(logger, `  [复用] ${file.id}（sha256 校验通过）`);
        continue;
      }
      log(logger, `  [重下] ${file.id} 哈希不符：盘上 ${got.slice(0, 12)}… ≠ 清单 ${file.sha256.slice(0, 12)}…`);
      needDownload = true;
      result.redownloaded.push(file.id);
      // 盘上那份是坏的 ⇒ 先清掉，别让续传把好字节接在坏字节后面
      await fsp.rm(destAbs, { force: true });
      await fsp.rm(partAbs, { force: true });
    }

    if (!needDownload) continue;

    // —— 下载 + 校验，失败自动重下（上限 REDOWNLOAD_LIMIT 次）
    let attempt = 0;
    for (;;) {
      const partial = await sizeOf(partAbs);
      if (partial > 0) log(logger, `  [续传] ${file.id} 从 ${(partial / 1048576).toFixed(1)} MB 接着下`);
      const fetched = await fetchToPart(partAbs, file, {
        sources: file.sources,
        fetchImpl,
        signal,
        onProgress,
        logger,
        allowResume: !flags.noResume,
      });
      result.resumeFrom[file.id] = fetched.resumedFrom;
      result.bytes += fetched.bytes;
      if (fetched.restarted && partial > 0) {
        log(logger, `  [注意] ${file.id} 的源不支持 Range ⇒ 退回全量重下（不是错误，是它的合法选择）`);
      }

      // —— 落位 + 校验
      await fsp.rename(partAbs, destAbs);
      const st2 = await statSafe(destAbs);

      if (flags.noVerify) {
        // 反证态：不校验。downloaded 照记，但坏内容会被当成好的。
        result.downloaded.push(file.id);
        records[file.id] = { dest: destRel, sha256: null, sizeBytes: st2.size, mtimeMs: st2.mtimeMs };
        log(logger, `  [完成] ${file.id}（⚠️ 未校验）`);
        break;
      }

      onProgress?.({ id: file.id, phase: 'verifying', received: 0, total: st2.size });
      const got = await sha256File(destAbs, { signal });
      if (got === file.sha256) {
        result.downloaded.push(file.id);
        records[file.id] = { dest: destRel, sha256: got, sizeBytes: st2.size, mtimeMs: st2.mtimeMs };
        log(logger, `  [完成] ${file.id}（sha256 校验通过）`);
        break;
      }

      await fsp.rm(destAbs, { force: true });
      if (attempt >= REDOWNLOAD_LIMIT) {
        // 🔴 不静默：源本身坏了就必须炸出来，否则后面会以"模型加载失败"的面目出现
        throw new ModelStoreError(
          'MODEL_SHA256_MISMATCH',
          `${file.id} 重下 ${attempt + 1} 次后 sha256 仍不符（期望 ${file.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）——源内容有问题，不再重试`,
          { id: file.id, expected: file.sha256, actual: got, attempts: attempt + 1 },
        );
      }
      attempt += 1;
      log(logger, `  [重下] ${file.id} 校验失败，自动重下第 ${attempt} 次`);
    }
  }

  if (!flags.noReady) {
    await writeMarker(rootDir, manifest, records);
  }
  return result;
}

/**
 * 纯校验（不联网）：逐文件比对 sha256。
 * 给诊断视图与验收用 —— 它能在"只看盘上字节"的前提下回答"模型是不是好的"。
 */
export async function verifyModels(manifest, { rootDir, ids, set, signal, onProgress } = {}) {
  const files = selectFiles(manifest, { ids, set });
  const out = { total: files.length, ok: [], bad: [], missing: [] };
  for (const file of files) {
    const destAbs = path.join(rootDir, file.dest);
    const st = await statSafe(destAbs);
    if (st == null) { out.missing.push(file.id); continue; }
    onProgress?.({ id: file.id, phase: 'verifying', received: 0, total: st.size });
    const got = await sha256File(destAbs, { signal });
    if (got === file.sha256) out.ok.push(file.id);
    else out.bad.push({ id: file.id, expected: file.sha256, actual: got });
  }
  return out;
}

/**
 * 把 store 里的权威副本**硬链接**进引擎源码树（`linkTo`）。
 * =============================================================================
 * 为什么需要这一步：引擎把模型路径硬编码在源码树里
 * （`utils/inference.py:94` `_MODEL_DIR = join(BASE_PATH,'models')`，`BASE_PATH = <引擎>/src`），
 * 而 `server/args.py` **没有** `--model-dir` ⇒ 视觉模型必须出现在 `src/models/<子目录>/`。
 * 于是"引擎换版本"（删除 `src/` 后重新解包）会把模型一起带走。
 *
 * 解法：权威副本只存一份在 store（manifest 的 `dest`），引擎树里那份是**硬链接**。
 *   · 硬链接不额外占盘、读写路径完全透明（引擎看到的就是普通文件，`os.path.exists` 为真）；
 *   · 换版本后只需重跑这一步（毫秒级、**零网络**），不必重下几个 GB；
 *   · 首选硬链接而非符号链接：Python 侧对符号链接的处理（realpath / replace / 写入跟随）
 *     会带来多余的不确定性，而硬链接在文件系统层面就是一个普通文件。
 *   · 跨设备/不支持硬链接时退化为**复制**（并如实记账，不假装是链接）。
 *
 * ⚠️ 已知边界：若引擎在"文件已存在"的前提下仍去写这个路径（本项目的预置策略使它不会），
 *    由于共享 inode，写入会同时改到 store 里的权威副本。故 `verifyModels()` 是这套设计的安全网
 *    —— 它能在任何时候回答"盘上那份还是不是好的"。
 */
export async function linkModels(manifest, { rootDir, linkBase, ids, set, logger } = {}) {
  const flags = refuteFlags();
  const files = selectFiles(manifest, { ids, set }).filter((f) => f.linkTo);
  const base = linkBase ?? path.join(rootDir, 'src');
  const out = { total: files.length, base, linked: [], already: [], copied: [], skipped: [] };

  if (flags.noLink) {
    out.skipped = files.map((f) => f.id);
    log(logger, '  [跳过] 全部（⚠️ 反证态：链接步骤被关闭）');
    return out;
  }

  for (const file of files) {
    const from = path.join(rootDir, file.dest);
    const to = path.join(base, file.linkTo);
    const stFrom = await statSafe(from);
    if (!stFrom) {
      out.skipped.push(file.id);
      log(logger, `  [跳过] ${file.id}：store 里没有它（先跑下载）`);
      continue;
    }

    await fsp.mkdir(path.dirname(to), { recursive: true });
    const stTo = await statSafe(to);
    if (stTo && stTo.ino === stFrom.ino && stTo.dev === stFrom.dev) {
      out.already.push(file.id); // 已经是指向同一 inode 的链接，不动它
      continue;
    }
    if (stTo) await fsp.rm(to, { force: true }); // 上一个引擎版本留下的、或已被换掉的旧文件

    try {
      await fsp.link(from, to);
      out.linked.push(file.id);
      log(logger, `  [链接] ${file.id} → ${file.linkTo}`);
    } catch (e) {
      await fsp.copyFile(from, to); // 跨设备等情况：退化为复制，但**如实记账**
      out.copied.push(file.id);
      log(logger, `  [复制] ${file.id}（硬链接不可用：${e.code || e.message}）`);
    }
  }
  return out;
}
