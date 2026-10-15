#!/usr/bin/env node
/**
 * 单张漫画「返工重译」+ 全屏缩放的取证 —— 且必须可反证
 * =========================================================================
 * ## 覆盖的两件事（用户 2026-10-07 提的）
 *
 * 1. **返工重译**（`POST /library/{name}/retranslate`）：译错了要能重来一遍。
 *    与既有的两条"再跑一次"路径语义都不同，必须分别钉住：
 *    · `resume`     补**缺**的页，遇到已有译文跳过（幂等）；
 *    · `retry`      重跑**同一任务**里失败的页，复用同一 taskId；
 *    · `retranslate` 重跑**已译**的页，**覆盖**译文。
 * 2. **全屏看图缩放**（前端源码断言）：`Ctrl/⌘ + ↑↓`，100%–200%。
 *
 * ## 钉子盯住的核心不变量：**译文必须真的被换掉**
 *
 * 这是最容易"看起来实现了、其实没生效"的地方 —— 有两条独立的短路会让返工空转：
 *  ① `_processItem` 里的 `skipExisting` 幂等短路：已有译文 ⇒ `skipped(already_exists)`。
 *     任务会秒完、进度条走满、**译文一个字没换**。R2/R3 盯这条。
 *  ② `_writeItem` 的 `flag:'wx'` 独占写：目标文件已存在 ⇒ 直接抛错。
 *     （这条已被 ① 遮住，但把 ① 修好之后它就会浮出来，所以 R4 单独钉。）
 *
 * 反过来，"覆盖"也不能覆盖过头：**原图必须一个字节都不动**（`_writeOriginal` 的
 * 「永不覆盖」，契约 §7.2）。R5 钉这条 —— 否则返工会把用户的原图也一起毁了。
 *
 * ## 为什么 R6 要钉"缩放必须限定 Ctrl/⌘"
 *
 * 缩放的输入在 2026-10-07 从 `Ctrl/⌘ + ↑/↓` 改成了 `Ctrl/⌘ + 滚轮`（用户要求）。
 * 要守的风险点**没变**，只是换了个载体：**不带修饰键的输入不得触发缩放**。
 *   · 旧形态的后果：缩放若写成裸 `↑/↓`，会和全局 `useMusicHotkeys` 的音量键打架
 *     （"在全屏里按 ↑，音量变了、图没变"）。
 *   · 新形态的后果：滚轮判定若不要求修饰键，触控板双指滚动会被当缩放
 *     （"手滑一下直接冲到 200%"），且 100% 时裸滚轮被吞、用户以为滚轮失灵。
 * 所以断言要求「认 Ctrl 或 ⌘」且「已换成滚轮」且「旧 ↑/↓ 键盘缩放已撤干净」三者同时成立。
 *
 * 缩放的**实现**细节（锚点缩放、非 passive 监听、−/+ 兜底按钮）由
 * `check:units` 的 ZOOM 组钉（那里能直接看源码结构，本脚本不重复钉）。
 *
 * ## 反证轮（`--refute`）：六条变异，各自必须让指定断言变红
 *   M1 去掉 `item.overwrite` 的幂等短路豁免 ⇒ 返工全被 skipped ⇒ R2/R3 变红；
 *   M2 `overwrite` 标记不落到 item 上 ⇒ 同上 ⇒ R2/R3 变红；
 *   M3 译文写回时忽略 overwrite（恒用 `'wx'`）⇒ 覆盖失败 ⇒ R3 变红；
 *   M4 返工取「缺页」而非「有原图的页」⇒ 对已译完的漫画报无可返工 ⇒ R1 变红；
 *   M5 滚轮缩放去掉 Ctrl/⌘ 限定 ⇒ 裸滚轮也缩放 ⇒ R6 变红；
 *   M6 复活已废弃的 ↑/↓ 键盘缩放 ⇒ 与全局音量键抢键 ⇒ R6 变红。
 *
 * 用法：
 *   node e2e/service/retranslate-check.mjs           正向跑（期望全绿）
 *   node e2e/service/retranslate-check.mjs --refute  反证轮（破坏 → 变红 → 按字节还原）
 *
 * 约束：纯 Node、零依赖；起**模拟引擎**；临时目录落 os.tmpdir；反证轮结束必须按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子）
import { killTree, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENGINE_ENTRY = path.join(ROOT, 'engine', 'src', 'server.mjs');
const CARGO_DIR = path.join(ROOT, 'src-tauri');
/// 🔴 返工的四个反证锚点全在 Rust 侧（`service/src/manga/store.mjs` 已随 Node 实现删除）。
/// `exec.rs` 管执行态（幂等短路豁免 / overwrite 落标 / 译文写回），`store.rs` 管计划取数口径。
const RUST_EXEC_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'store', 'exec.rs');
const RUST_STORE_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'store.rs');
const LIB_SRC = path.join(ROOT, 'src', 'screens', 'LibraryScreen.tsx');
// D-148：缩放的实现从 `LibraryScreen.tsx` 搬到 `screens/library/viewer.tsx`（Lightbox）。
const VIEWER_SRC = path.join(ROOT, 'src', 'screens', 'library', 'viewer.tsx');

const REFUTE = process.argv.includes('--refute');
/// 起的是模拟引擎；不声明会让服务按 real 协议去打替身。
const ENGINE_PROTOCOL = 'mock';
const ENGINE_PORT = 5027;

/**
 * 编译 Rust 靶子（反证轮改完源码必须重编，否则断言验的是"上一份产物"）。
 * 🔴 编译失败**不算通过**：它记 skipped —— 锚点选错行与"覆盖不足"在报告里长得一样，
 *    必须分开记，否则"反证没跑成"会被读成"反证通过"。
 */
function buildRust() {
  const r = spawnSync('cargo', ['build', '--bin', 'boxsvc'], {
    cwd: CARGO_DIR,
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, log: log.split('\n').slice(-6).join(' | ').slice(0, 400) };
}

const COMIC = '返工甲';
const IMAGES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

// ------------------------------------------------------------------ 子进程

function spawnProc(entry, env, tag) {
  // entry 是服务 ⇒ 按 MIAO_SERVICE_IMPL 选靶子；是模拟引擎 ⇒ 原样走 node
  const child = spawnTarget(entry, env);
  const state = { child, tag, out: '' };
  child.stdout.on('data', (b) => (state.out += b.toString('utf8')));
  child.stderr.on('data', (b) => (state.out += b.toString('utf8')));
  return state;
}

async function waitReady(state, re, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = re.exec(state.out);
    if (m) return JSON.parse(m[1]);
    await sleep(120);
  }
  throw new Error(`${state.tag} 未在 ${timeoutMs}ms 内就绪：\n${state.out.slice(-800)}`);
}

function killProc(state) {
  if (!state || !state.child || state.child.exitCode !== null) return Promise.resolve();
  const child = state.child;
  // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
  killTree(child);
  // Windows：刚被 kill 的子进程会短暂占着文件句柄，随后写源文件会 EPERM —— 必须等它真的退出。
  return new Promise((resolve) => {
    const until = Date.now() + 3000;
    const tick = () => {
      if (child.exitCode !== null || Date.now() > until) {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** 带重试写文件；上界必须有，否则"文件被占"会被拖成静默挂死 */
async function writeRetry(file, data, tries = 40) {
  for (let i = 1; ; i++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(100);
    }
  }
}

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ HTTP

function request(port, method, urlPath, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: { ...(token ? { 'X-Box-Token': token } : {}), ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};

const postJson = (port, token, urlPath, obj) =>
  request(port, 'POST', urlPath, {
    token,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
  });

function buildMultipart(payload, images) {
  const boundary = `----miaort${Math.random().toString(16).slice(2)}`;
  const parts = [];
  if (payload) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`,
        'utf8',
      ),
    );
  }
  for (const img of images) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${img.filename}"\r\n` +
          `Content-Type: ${img.contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    parts.push(img.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

const makeImages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    filename: `${String(i + 1).padStart(3, '0')}.png`,
    contentType: 'image/png',
    data: encodePng(40, 60, (x, y, put) => put((x * 6 + i * 13) % 256, (y * 4 + i * 7) % 256, 128)),
  }));

async function submit(port, token, comicName, images) {
  const mp = buildMultipart({ comicName, idempotencyKey: crypto.randomUUID() }, images);
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token,
    headers: { 'Content-Type': mp.contentType },
    body: mp.body,
  });
  return { status: res.status, json: json(res) };
}

const TERMINAL = ['done', 'partial_failed', 'failed', 'canceled'];

async function waitTask(port, token, taskId, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = json(await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token }));
    if (t && TERMINAL.includes(t.status)) return t;
    if (Date.now() > until) throw new Error(`${taskId} 未在 ${timeoutMs}ms 内到终态（当前 ${t && t.status}）`);
    await sleep(120);
  }
}

/** 列目录里某 seq 的译文文件名（`_translated.` 之前的部分用 seq 匹配） */
function translatedFile(dir, seq) {
  const pad = String(seq).padStart(3, '0');
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${pad}_translated.`));
  return hit ? path.join(dir, hit) : null;
}

function originalFile(dir, seq) {
  const pad = String(seq).padStart(3, '0');
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${pad}.`) && !f.includes('_translated'));
  return hit ? path.join(dir, hit) : null;
}

/**
 * 去掉 `//` 与 `/* *\/` 注释（带字符串状态机）。
 *
 * 为什么源码断言必须先剥注释：本仓的注释**主动写出了被查的字面量**
 * （例如 Lightbox 的注释里就写着「Ctrl/⌘ + ↑↓ 缩放」）。不剥注释时，
 * R6 在"真实按键判定已被改错"之后仍会因为注释里的那行而判绿 ——
 * 这正是本仓反复出现的那类假阳性（断言测的是注释，不是代码）。
 */
function stripComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i++;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        i++;
        continue;
      }
      out += c;
    } else if (state === 'line') {
      if (c === '\n') {
        out += c;
        state = 'code';
      }
    } else {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i++;
      } else if (c === '\n') out += c; // 保留换行，行号不错位
    }
  }
  return out;
}

// ------------------------------------------------------------------ 正向

async function runAll() {
  results.length = 0;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-'));
  const ROOT_DIR = path.join(TMP, '漫画');
  const STATE_DIR = path.join(TMP, 'state');
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  let engine = null;
  let service = null;
  try {
    engine = spawnProc(ENGINE_ENTRY, { MIAO_ENGINE_PORT: String(ENGINE_PORT) }, 'engine');
    const engineInfo = await waitReady(engine, /MIAO_ENGINE_READY (\{[^\n]*\})/);

    service = spawnProc(
      SERVICE_ENTRY,
      {
        MIAO_ENGINE_PORT: String(engineInfo.port),
        MIAO_ENGINE_PROTOCOL: ENGINE_PROTOCOL,
        MIAO_ROOT: ROOT_DIR,
        MIAO_STATE_DIR: STATE_DIR,
      },
      'service',
    );
    const svcInfo = await waitReady(service, /MIAO_READY (\{[^\n]*\})/);
    const PORT = svcInfo.port;
    const TOKEN = svcInfo.token;
    const dir = path.join(ROOT_DIR, COMIC);

    // ---- 前置：先正常翻一遍，磁盘上才会有"已有译文"可被覆盖 ----
    const first = await submit(PORT, TOKEN, COMIC, makeImages(IMAGES));
    const firstId = first.json?.taskId;
    const done1 = firstId ? await waitTask(PORT, TOKEN, firstId) : null;
    check(
      'P0',
      `前置：${COMIC} 交 ${IMAGES} 张、跑到终态且译文已落盘`,
      done1?.status === 'done' && !!translatedFile(dir, 1),
      `status=${done1?.status} translated=${!!translatedFile(dir, 1)}`,
    );
    if (done1?.status !== 'done') return;

    // 记下返工**前**的译文与原图字节：后面要逐字节比对
    const beforeT = translatedFile(dir, 1);
    const beforeO = originalFile(dir, 1);
    const beforeOBytes = beforeO ? fs.readFileSync(beforeO) : null;

    // ---- R1：返工计划取的是「有原图的页」，而不是「缺译文的页」 ----
    const planRes = json(
      await request(PORT, 'GET', `/api/v1/library/${encodeURIComponent(COMIC)}/retranslate`, { token: TOKEN }),
    );
    check(
      'R1',
      '返工计划覆盖**已译**的页：对已翻完的漫画仍报得出可返工张数，且覆盖数 = 全部页',
      planRes && planRes.retranslateCount === IMAGES && planRes.overwriteCount === IMAGES,
      `retranslateCount=${planRes && planRes.retranslateCount} overwriteCount=${planRes && planRes.overwriteCount} (期望 ${IMAGES}/${IMAGES})`,
    );

    // 与 resume 的分工：resume 对同一本应报"没有待续做的页"（缺 0 张）
    const resumeRes = json(
      await request(PORT, 'GET', `/api/v1/library/${encodeURIComponent(COMIC)}/resume`, { token: TOKEN }),
    );
    check(
      'R1b',
      '与 resume 分工明确：同一本已翻完的漫画，resume 报 0 待续做（两条路不是同一件事）',
      resumeRes && resumeRes.pendingCount === 0,
      `pendingCount=${resumeRes && resumeRes.pendingCount}（期望 0）`,
    );

    // ---- R2：返工建单后跑起来，页不能被幂等短路成 skipped ----
    const rtRes = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC)}/retranslate`, {});
    const rtId = json(rtRes)?.taskId;
    check(
      'R2',
      'POST /library/{name}/retranslate 建单成功（201），且回执带覆盖张数',
      rtRes.status === 201 && !!rtId && json(rtRes).overwriteCount === IMAGES,
      `HTTP ${rtRes.status} taskId=${rtId ? '有' : '无'} overwriteCount=${json(rtRes)?.overwriteCount}`,
    );
    const done2 = rtId ? await waitTask(PORT, TOKEN, rtId) : null;
    const skippedCount = (done2?.batches ?? []).reduce(
      (acc, b) => acc + (b.status === 'skipped' ? b.count || 0 : 0),
      0,
    );
    const detail2 = json(await request(PORT, 'GET', `/api/v1/tasks/${rtId}`, { token: TOKEN }));
    const items = detail2?.items ?? [];
    const skippedItems = items.filter((i) => i.status === 'skipped').length;
    check(
      'R2b',
      '返工**不被幂等短路**：没有一页落到 skipped(already_exists)（否则译文一个字没换）',
      done2?.status === 'done' && skippedItems === 0 && items.length === IMAGES,
      `status=${done2?.status} items=${items.length} skipped=${skippedItems}（skippedBatch=${skippedCount}）`,
    );
    if (done2?.status !== 'done') return;

    // ---- R3：译文必须真的被换掉 ----
    /**
     * ⚠️ 判据为什么是"放一份假译文再比对"，而不是"跑两次比字节"。
     *
     * 起初这里写的是"返工前后字节应不同"，结果恒绿 —— 因为**模拟引擎对同一 seq 的输出
     * 是确定的**（`render.mjs` 用 `lcg(seq)` 伪随机，种子只来自 seq），同一页重跑必然
     * 产出逐字节相同的图。这类断言看起来在验"重译了"，实际它连引擎是否被调用都区分不出来，
     * 正是"覆盖率幻觉"的一种。
     *
     * 改成构造一个**只有覆盖才会变**的场景：手动往磁盘塞一份**内容明显不同**的假译文，
     * 再返工。若覆盖真的发生，那份假译文必然被引擎产物顶掉；不覆盖（哪怕任务状态是 done）
     * 它会原样留着。这样判据才真的只在"覆盖生效"时为绿。
     */
    const fakeT = translatedFile(dir, 1);
    const fakeBytes = encodePng(40, 60, (x, y, put) => put(255, 0, 255)); // 纯品红，绝不会与引擎产物相同
    fs.writeFileSync(fakeT, fakeBytes);
    const rtRes2 = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC)}/retranslate`, {
      seqs: [1],
    });
    const rtId2 = json(rtRes2)?.taskId;
    const doneR2 = rtId2 ? await waitTask(PORT, TOKEN, rtId2) : null;
    const afterT2 = translatedFile(dir, 1);
    const afterT2Bytes = afterT2 ? fs.readFileSync(afterT2) : null;
    const replaced = !!afterT2Bytes && !afterT2Bytes.equals(fakeBytes);
    check(
      'R3',
      '返工**真的覆盖**已有译文：塞进去的假译文被引擎产物顶掉了（不是 skipped 装样子的"完成"）',
      replaced && doneR2?.status === 'done',
      replaced
        ? `假译文已被替换（${fakeBytes.length}B 品红 → ${afterT2Bytes.length}B 引擎产物）`
        : `译文仍是那份假译文（覆盖没发生）status=${doneR2?.status}`,
    );

    // ---- R3b：续做路径**不覆盖**（不勾 overwrite 时，'wx' 独占写必须挡住） ----
    // 这条是覆盖能力的**另一半**：能覆盖不等于该覆盖时也覆盖。
    // 用「把已译页塞进 resume」验证：resume 跳过已译页，一个都不该动。
    const beforeResume = translatedFile(dir, 2);
    const beforeResumeBytes = beforeResume ? fs.readFileSync(beforeResume) : null;
    const resumeTry = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC)}/resume`, {});
    const resumeId = json(resumeTry)?.taskId;
    if (resumeId) await waitTask(PORT, TOKEN, resumeId);
    const afterResumeBytes = beforeResume ? fs.readFileSync(beforeResume) : null;
    check(
      'R3b',
      '返工能力**不外溢**：resume（缺页续做）对已译页一个都不动 —— 覆盖是 retranslate 独有的特权',
      !!afterResumeBytes && !!beforeResumeBytes && afterResumeBytes.equals(beforeResumeBytes),
      afterResumeBytes && beforeResumeBytes && afterResumeBytes.equals(beforeResumeBytes)
        ? '已译页未被 resume 触碰'
        : 'resume 动到了已译页！',
    );

    // ---- R5：原图必须一个字节都不动（覆盖只发生在译文上） ----
    const afterO = originalFile(dir, 1);
    const afterOBytes = afterO ? fs.readFileSync(afterO) : null;
    const origIntact = !!afterOBytes && !!beforeOBytes && afterOBytes.equals(beforeOBytes);
    check(
      'R5',
      '返工**不碰原图**（契约 §7.2 永不覆盖：返工只重译，原图是用户数据）',
      origIntact,
      origIntact ? '原图字节一致' : '原图被改动了！',
    );

    // ---- 只返工单页：seqs 精确生效 ----
    const oneRes = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC)}/retranslate`, {
      seqs: [2],
    });
    const oneId = json(oneRes)?.taskId;
    const done3 = oneId ? await waitTask(PORT, TOKEN, oneId) : null;
    const d3 = oneId ? json(await request(PORT, 'GET', `/api/v1/tasks/${oneId}`, { token: TOKEN })) : null;
    const seqs3 = (d3?.items ?? []).map((i) => i.seq).sort((a, b) => a - b);
    check(
      'R4',
      '指定 seqs 时只提交那些页（单页返工不会把整本都重跑一遍）',
      oneRes.status === 201 && done3?.status === 'done' && JSON.stringify(seqs3) === '[2]',
      `HTTP ${oneRes.status} status=${done3?.status} seqs=${JSON.stringify(seqs3)}（期望 [2]）`,
    );

    // ---- R7：超上限要报错而不是硬塞（整部大漫画一次建单会占死引擎队列） ----
    const overDir = path.join(ROOT_DIR, '大漫画');
    fs.mkdirSync(overDir, { recursive: true });
    for (let i = 1; i <= 21; i++) {
      fs.writeFileSync(
        path.join(overDir, `${String(i).padStart(3, '0')}.png`),
        encodePng(8, 8, (x, y, put) => put(i * 7, y * 3, 90)),
      );
    }
    const overRes = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent('大漫画')}/retranslate`, {});
    // 错误信封是**嵌套**的：`{ error: { code, message, details } }`（errors.mjs::errorEnvelope），
    // 不是扁平的 `{ code }` —— 读错层级会让这条恒红，掩盖真正的回归。
    const overJson = json(overRes);
    check(
      'R7',
      '超过单次上限（20 张）时报 BATCH_LIMIT_EXCEEDED，而不是硬塞给引擎',
      // 400 是**契约 §3 自己定的**码（errors.mjs: BATCH_LIMIT_EXCEEDED: 400），不是笔误
      overRes.status === 400 && overJson?.error?.code === 'BATCH_LIMIT_EXCEEDED',
      `HTTP ${overRes.status} code=${overJson?.error?.code}（期望 400/BATCH_LIMIT_EXCEEDED）`,
    );

    // ---- R6：缩放必须限定 Ctrl/⌘，且**裸滚轮不缩放**（改为滚轮后的新契约） ----
    //
    // 2026-10-07 改版：缩放输入从 `Ctrl/⌘ + ↑/↓` 改为 `Ctrl/⌘ + 滚轮`（用户要求）。
    // 本条随之**重写**而非删除 —— 它要守的风险点没变：**滚轮不带修饰键就缩放**。
    // 后果具体：① 触控板双指滚动被当缩放，"滑一下冲到 200%"；
    //          ② 100% 时的裸滚轮被吞，用户以为滚轮失灵。
    // 反过来"只有修饰键才缩放"正是本条要的正向形态，故判 `hasModGate && !gatesArrowUpDown`。
    const libSrc = stripComments(fs.readFileSync(VIEWER_SRC, 'utf8'));
    const hasModGate = /e\.ctrlKey\s*\|\|\s*e\.metaKey/.test(libSrc);
    const usesWheel = /addEventListener\('wheel'/.test(libSrc);
    // 旧键盘缩放必须**已撤干净**：留着 ↑/↓ 会与 useMusicHotkeys 的音量键抢
    const gatesArrowUpDown = /ArrowUp/.test(libSrc) && /ArrowDown/.test(libSrc);
    check(
      'R6',
      '缩放改为滚轮：认 Ctrl 或 ⌘ 才缩放（裸滚轮不缩放），且旧 ↑/↓ 键盘缩放已撤',
      hasModGate && usesWheel && !gatesArrowUpDown,
      `modGate=${hasModGate} wheel=${usesWheel} arrows=${gatesArrowUpDown}`,
    );

    // ---- R8：缩放范围与拖拽 ----
    // 2026-10-08：下限 100% → 50%（用户要求可缩小看全局），上限仍 200%。
    const hasClamp = /clampZoom/.test(libSrc) && /ZOOM_MAX\s*=\s*200/.test(libSrc) && /ZOOM_MIN\s*=\s*50/.test(libSrc);
    // 拖拽用 Pointer Events（一次覆盖鼠标/触屏/触控板，macOS 与 Windows 同模型）
    const usesPointer = /onPointerDown/.test(libSrc) && /onPointerMove/.test(libSrc);
    check(
      'R8',
      '缩放范围夹在 50%–200%；拖拽用 Pointer Events（兼容 macOS 触控板与鼠标）',
      hasClamp && usesPointer,
      `clamp(50..200)=${hasClamp} pointerEvents=${usesPointer}`,
    );
  } finally {
    await killProc(service);
    await killProc(engine);
  }
}

// ------------------------------------------------------------------ 反证轮

const MUTATIONS = [
  {
    name: 'M1 去掉 overwrite 的幂等短路豁免（返工会被全量 skipped）',
    // Rust 锚点在 `prepare_item` 的短路条件上（Node 的 `!item.overwrite` ⇒ Rust 的 `!overwrite`）。
    edits: [
      {
        file: RUST_EXEC_SRC,
        find: '        if self.env.skip_existing && !overwrite && find_translated_name(&dir, seq).is_some() {',
        replace: '        if self.env.skip_existing && find_translated_name(&dir, seq).is_some() {',
      },
    ],
    expect: ['R2b', 'R3'],
  },
  {
    name: 'M2 返工的 overwrite 标记不落到 item 上',
    edits: [
      {
        // 返工建单传 `true`；续做建单（`create_resume_task`）传 `false` —— 两条别互串。
        file: RUST_EXEC_SRC,
        find: '            .map(|c| disk_item(c.seq, &c.ext, c.byte_size, Some(c.original_file.clone()), true))',
        replace: '            .map(|c| disk_item(c.seq, &c.ext, c.byte_size, Some(c.original_file.clone()), false))',
      },
    ],
    expect: ['R2b', 'R3'],
  },
  {
    name: 'M3 译文写回时忽略 overwrite（恒用独占写，覆盖必失败）',
    edits: [
      {
        // Rust 的 `write_file_private` 对应 Node 的 `flag:'w'`，`write_new_private` 对应 `'wx'`。
        // 整段五行一起换（只换前两行会留下悬空的 `} else {`，编译不过）。
        file: RUST_EXEC_SRC,
        find:
          '    let res = if item.overwrite {\n' +
          '        super::write_file_private(&path, &translated.bytes, 0o600)\n' +
          '    } else {\n' +
          '        super::write_new_private(&path, &translated.bytes, 0o600)\n' +
          '    };',
        replace:
          '    let res = super::write_new_private(&path, &translated.bytes, 0o600); // refute：忽略 overwrite，恒用独占写',
      },
    ],
    expect: ['R3'],
  },
  {
    // ⚠️ 必须破坏 **retranslate_plan**（计划端点的取数口径），不是 create_retranslate_task。
    // R1 断言的是 `GET /library/{name}/retranslate` 的返回；改建单函数不会影响它 ⇒ 不会变红。
    // 这类"破坏点与断言点不在同一条路径上"的变异是反证脚本最常见的假阳性来源：
    // 变异确实破坏了代码，但被破坏的那段恰好不是这条断言盯着的地方。
    name: 'M4 返工计划取「缺页」而非「有原图的页」（对已译完的漫画报无可返工）',
    edits: [
      {
        // ⚠️ 锚点必须带 `let mut candidates` 那一行：`for f in self.list_dir(&dir) {` 在 store.rs 里
        //    出现两次（`next_seq_for` 与 `retranslate_plan`），裸行会命中**前一个**函数 ——
        //    破坏点落在与断言无关的路径上，正是"该红没红"的假阴性来源（本轮实测踩到）。
        file: RUST_STORE_SRC,
        find: '        let mut candidates: Vec<RetranslateCandidate> = Vec::new();\n        for f in self.list_dir(&dir) {',
        replace:
          '        let mut candidates: Vec<RetranslateCandidate> = Vec::new();\n        for f in Vec::<String>::new() {',
      },
    ],
    expect: ['R1', 'R2'],
  },
  {
    // 缩放改滚轮后，破坏点从「键盘修饰键门控」移到「滚轮修饰键门控」：
    // 去掉 ctrl/meta 判定 ⇒ 触控板双指滚动被当缩放，一滑就顶到 200%。
    name: 'M5 前端滚轮缩放去掉 Ctrl/⌘ 限定（裸滚轮也缩放，双指滑动一滑就顶格）',
    edits: [
      {
        file: VIEWER_SRC,
        find: '      if (e.ctrlKey || e.metaKey) {',
        replace: '      if (true) {',
      },
    ],
    expect: ['R6'],
  },
  {
    // 旧键盘缩放复活 ⇒ 与 useMusicHotkeys 的裸 ↑↓ 音量键抢
    name: 'M6 复活已废弃的 ↑/↓ 键盘缩放（与全局音量键抢键）',
    edits: [
      {
        file: VIEWER_SRC,
        find: "    window.addEventListener('wheel', onWheel, { passive: false });",
        replace:
          "    window.addEventListener('wheel', onWheel, { passive: false });\n    void (e: KeyboardEvent) => e.key === 'ArrowUp' || e.key === 'ArrowDown';",
      },
    ],
    expect: ['R6'],
  },
];

async function refute() {
  const originals = new Map();
  let red = 0;
  let total = 0;
  let skipped = 0;
  const falsePositives = [];
  const expectedTotal = MUTATIONS.reduce((a, m) => a + m.expect.length, 0);

  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  // 🔴 进反证轮前先确保「产物 == 磁盘源码」：否则基线跑的是上一份编译结果，
  //    而「变异全红」里有一部分红是被这份陈旧产物误打误撞造成的。
  const pre = buildRust();
  if (!pre.ok) {
    console.log(`✗ 开跑前 cargo build 失败，无法反证：${pre.log}`);
    process.exitCode = 1;
    return;
  }

  for (const mut of MUTATIONS) {
    let res = {};
    let roundErr = null;
    let applied = true;
    /**
     * 破坏必须**写磁盘**，不能只改内存覆盖层。
     *
     * 本脚本的 `runAll` 起的是**真子进程**（引擎 + box-service），子进程读的是磁盘 ——
     * 用 `overrideFile` 只改本进程的内存视图，子进程压根看不见，破坏等于没做，
     * 于是每条变异都会"该红没红"（本脚本第一版就栽在这，改了 0/7）。
     * 前端的源码断言也一并读磁盘（`fs.readFileSync`），同样要求真落盘。
     */
    try {
      for (const e of mut.edits) {
        if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
        const original = originals.get(e.file);
        const txt = original.toString('utf8');
        // CRLF 仓库：锚点按 LF 写，磁盘是 CRLF —— 折算后再比对，否则"锚点未找到"
        const eol = txt.includes('\r\n') ? '\r\n' : '\n';
        const find = e.find.split('\n').join(eol);
        const repl = e.replace.split('\n').join(eol);
        if (!txt.includes(find)) {
          console.log(`⚠ ${mut.name}\n    破坏锚点未找到（${path.relative(ROOT, e.file)}）—— 本条无法反证`);
          skipped += mut.expect.length;
          applied = false;
          break;
        }
        await writeRetry(e.file, txt.replace(find, repl));
      }
      if (applied) {
        // 🔴 改完 Rust 源码**必须重编**才作数：不编就等于拿旧产物跑断言，红的绿的都说明不了问题。
        const built = buildRust();
        if (!built.ok) {
          console.log(`⚠ ${mut.name}\n    破坏后编译失败（多半是锚点选错行），本条无法反证：${built.log}`);
          skipped += mut.expect.length;
          applied = false;
        }
      }
      if (applied) {
        await runAll();
        for (const r of results) res[r.id] = r;
      }
    } catch (err) {
      roundErr = err;
    } finally {
      // 还原一律进 finally：破坏若让 runAll() 抛异常，写在 try 之后的还原就不会执行
      for (const [f, snap] of originals) await writeRetry(f, snap);
    }
    if (!applied) continue;
    console.log(`🔴 ${mut.name}`);
    if (roundErr) {
      console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    }
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [f, snap] of originals) {
    const back = readBytes(f);
    const same = back != null && snap != null && back.equals(snap);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, f)} 字节${same ? '一致' : '不一致！'}`);
  }
  // 源码还原了，**产物也必须还原** —— 否则留下一个「源码是好的、跑起来是坏的」的机器。
  const rebuilt = buildRust();
  if (!rebuilt.ok) {
    restoreFail++;
    console.log(`  ✗ cargo build 还原失败：${rebuilt.log}`);
  } else console.log('  ✓ cargo build 已把靶子重编回未破坏状态');

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到 / 破坏后编译失败）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
}

async function main() {
  if (REFUTE) {
    // 反证轮需要基线：先跑一次正向，确认要反证的断言本来就是绿的
    await runAll();
    const green = results.filter((r) => r.ok).length;
    console.log(`基线：${green}/${results.length} 通过`);
    if (green !== results.length) {
      console.log('✗ 基线不绿，无法据此判定反证有效性（先把正向跑通）');
      process.exitCode = 1;
      return;
    }
    await refute();
    return;
  }

  await runAll();
  const width = results.reduce((a, r) => Math.max(a, r.id.length), 3);
  console.log('\n' + '─'.repeat(56));
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id.padEnd(width)} ${r.label}`);
    if (r.detail) console.log(`      ${r.detail}`);
  }
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
