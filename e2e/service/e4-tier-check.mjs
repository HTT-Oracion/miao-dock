#!/usr/bin/env node
/**
 * E4 · 档位切换（《04》§14.2）
 * =============================================================================
 * 判据原文：**配置切 Tiny↔Small 后重启，`/health` 的 `sidecar.tier` 与实际加载权重一致**
 *
 * ## 这条判据里真正难的不是"切"，是"一致"
 * 把 `sidecar.tier` 报成"用户配置的那一档"是最省事、也最容易写的实现 ——
 * 它每次都能和界面上的下拉框对上，看起来永远正确。但它会和**事实**分叉：
 * 用户配 `small`、机器上却只有 Tiny 的权重，于是界面说"小档"、跑的是 1.5B。
 * 质量差异被静静吞掉，而"翻译变差了"这种反馈**根本追溯不到根因**。
 *
 * ⇒ 本脚本守两件事：
 *   ① `sidecar.tier` 是**生效档位**（与实际加载的权重同名同源），不是配置档位；
 *   ② **未纳入清单的档位必须显式报错**（`TIER_MODEL_UNDECLARED`），**不得回落**成 tiny 的权重。
 *
 * ## 为什么分成"纯函数半边 + 服务半边"
 * ② 可以纯函数验（秒级、可反证）；① 必须在**真服务**上读 `/health` 才算数 ——
 * 自己算一遍"应该等于 tiny"然后把 tiny 写进断言，那是把实现抄一遍，什么都没测到。
 * 服务半边用**假引擎**（只应答就绪探针、不翻译）：E4 考的是"上报的档位与权重对不对"，
 * 不需要真 Sakura（那要几 GB 与分钟级）。
 *
 * ## 真机半边的边界（必须明说）
 * `TIER_LLM_MODELS` 目前**只固化了 Tiny**（`small: null` / `medium: null`，见 S3 的固化范围）。
 * ⇒ 「切到 Small 后 `/health` 显示 small」这件事**本机做不到**，因为 Small 的权重文件名与
 * 校验值都还没有来源。本脚本因此**反向**取证：在这台机器上，`MIAO_ENGINE_TIER=small`
 * 必须被**夹回 tiny** 且**显式**（不能静默），而"切到 Small 真生效"这一半列在
 * `docs/engine-e2e-acceptance-report.md` 的 unverified register 里，**不计入已完成**。
 *
 * 用法：
 *   node e2e/service/e4-tier-check.mjs            正向
 *   node e2e/service/e4-tier-check.mjs --refute    反证轮（破坏源文件 → 断言必须变红 → 按字节还原）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（box-service 的段）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs');
const SERVER_SRC = path.join(ROOT, 'service', 'src', 'server.mjs');
const CLIENT_SRC = path.join(ROOT, 'service', 'src', 'engine-client.mjs');
const SUP_SRC = path.join(ROOT, 'service', 'src', 'settings', 'llm-supervisor.mjs');
const TOKEN = 'f'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-e4-'));
const REFUTE = process.argv.includes('--refute');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 声明的断言条数（分母写死：少执行一条即判红） */
const DECLARED = 6;

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`\n通过 ${pass} / 失败 ${results.length - pass} / 声明 ${DECLARED}`);
  return { pass, fail: results.length - pass };
}

// ------------------------------------------------------------------ 小工具

const portOpen = (port, timeoutMs = 300) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v); } };
  s.setTimeout(timeoutMs);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
});

async function findFreePort(start, need = 2) {
  for (let p = start; p < start + 400; p += 1) {
    let ok = true;
    for (let i = 0; i < need; i += 1) if (await portOpen(p + i)) { ok = false; break; }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${need} 个连续空闲端口`);
}

function httpGetJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: token ? { 'X-Box-Token': token } : {}, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 在**子进程**里问一次档位相关的纯函数。
 *
 * 🔴 为什么必须另起进程：ESM 按 URL 缓存模块 —— 反证轮改了 `engine-client.mjs` / `config.mjs`
 *    之后，父进程第二次 `import()` 仍拿到第一份缓存 ⇒ 断言不可能变红，
 *    而它看起来"跑过了"。这个坑在 E10 上先踩过一次，这里直接按结论写。
 */
function askChild(expr) {
  const js = `
    const m = await import(${JSON.stringify(new URL('../../service/src/engine-client.mjs', import.meta.url).href)});
    const out = (${expr});
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', js], {
      encoding: 'utf8',
      env: { ...process.env, MIAO_ENGINE_PROTOCOL: 'real' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { __error: String(e.message).slice(0, 300) };
  }
}

// ------------------------------------------------------------------ 假引擎 + 服务

/** 只应答就绪探针（TCP + POST /queue-size + 执行器端口），不做翻译 —— E4 不需要真翻译。 */
function startFakeEngine(port) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/queue-size') {
        const b = Buffer.from('0');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': b.length });
        return res.end(b);
      }
      res.writeHead(404, { 'Content-Length': 0 });
      res.end();
    });
  });
  const executor = net.createServer(() => { /* 哑 socket ⇒ running */ });
  return { server, executor };
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));

function spawnService(env) {
  const child = spawn(process.execPath, [SERVICE_ENTRY], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const st = { child, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) { try { st.ready = JSON.parse(m[1]); } catch { /* 继续等 */ } }
  });
  child.stderr.on('data', (d) => { st.err += d.toString(); });
  return st;
}

async function waitReady(st, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`服务未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

// ------------------------------------------------------------------ 断言体

async function runAll() {
  results.length = 0;

  const svcPort = await findFreePort(5350, 1);
  const engPort = await findFreePort(5450, 2);
  const fake = startFakeEngine(engPort);
  await listen(fake.server, engPort);
  await listen(fake.executor, engPort + 1);

  // ---- E4.1：未纳入清单的档位是 `null`，不是空串、不是 tiny 的文件名 ----
  const models = askChild('m.TIER_LLM_MODELS');
  check('E4.1 档位→权重表里 Small/Medium **显式声明为 null**（不是"没这个键"，也不是顺手填了 tiny 的文件名）',
    models && models.tiny && models.small === null && models.medium === null,
    JSON.stringify(models));

  // ---- E4.2：未声明的档位必须**抛错**，不得静默回落 ----
  const smallPath = askChild("m.tierModelPath('small')");
  const smallLaunch = askChild(`(() => { try { return { threw: false, model: m.resolveLlmLaunch({ tier: 'small' }).model }; }
    catch (e) { return { threw: true, code: e.code, message: String(e.message).slice(0, 200), detail: e.detail }; } })()`);
  check('E4.2 Small 权重未声明 ⇒ 路径为 null 且 `resolveLlmLaunch({tier:"small"})` **抛 TIER_MODEL_UNDECLARED**（绝不回落成 tiny 的权重）',
    smallPath === null && smallLaunch?.threw === true && smallLaunch?.code === 'TIER_MODEL_UNDECLARED'
      && Array.isArray(smallLaunch?.detail?.available),
    `tierModelPath('small')=${JSON.stringify(smallPath)} / launch=${JSON.stringify(smallLaunch)}`);

  // ---- E4.3：本进程真能跑的档位范围 ----
  const avail = askChild('m.availableTiers()');
  check('E4.3 real 协议下 `availableTiers()` 恰为 ["tiny"]（= 清单里真有权重的那些；本机没有 Small/Medium 权重）',
    Array.isArray(avail) && avail.length === 1 && avail[0] === 'tiny',
    JSON.stringify(avail));

  // ---- 服务半边：配置 small（未纳入清单）→ 必须夹回 tiny 且**显式** ----
  const st = spawnService({
    MIAO_ENGINE_PROTOCOL: 'real',
    MIAO_ENGINE_PORT: String(engPort),
    MIAO_ENGINE_PROBE_MS: '300',
    MIAO_ENGINE_TIER: 'small', // ← 用户"配置"了 Small
    MIAO_PORT: String(svcPort),
    MIAO_TOKEN: TOKEN,
    MIAO_STATE_DIR: path.join(TMP, 'state'),
    MIAO_ROOT: path.join(TMP, 'root'),
    MIAO_NO_LLM_AUTOSTART: '1',
  });

  try {
    const info = await waitReady(st);
    const PORT = info.port;

    // 等引擎被探到 running（假引擎在听，应该很快）
    let health = null;
    for (let i = 0; i < 50; i += 1) {
      const r = await httpGetJson(PORT, '/api/v1/health', TOKEN);
      if (r.status === 200 && r.body?.sidecar?.state === 'running') { health = r.body; break; }
      await sleep(150);
    }
    const sc = health?.sidecar;

    check('E4.4 `/health.sidecar.tier` 报的是**生效档位**（small 未纳入清单 ⇒ 夹回 tiny），不是用户配置的 small',
      sc?.tier === 'tiny',
      `配置=MIAO_ENGINE_TIER=small / 上报 tier=${JSON.stringify(sc?.tier)} / state=${JSON.stringify(sc?.state)}`);

    // ---- E4.5：上报的 model 是**契约里的 model id 形态**（basename 去扩展名），不是本机绝对路径 ----
    // 契约《03》§5.1 的示例是 `"model": "sakura-1.5b-qwen2.5-v1.0-iq4xs"` —— 没有目录、没有扩展名。
    // 真档的 `launch.model` 却是**盘上绝对路径**（`tierModelPath()` 给的），`modelIdOf` 在
    // "优先取 `launch.model`"这条分支上原先**没做 basename**，于是把
    // `…/runtimes/manga-translator/models/sakura/sakura-…-fp16` 整个泄进 `/health`。
    const tinyLaunch = askChild(`(() => {
      const l = m.resolveLlmLaunch({ tier: 'tiny' });
      const b = String(l.model).split('/').pop();
      return { model: l.model, base: b, id: b.replace(/\\.gguf$/i, '') };
    })()`);
    const reported = sc?.model ?? '';
    check('E4.5 `sidecar.model` == tiny 权重的 **model id**（basename 去扩展名），不得把本机绝对路径报给 `/health`',
      !!reported && reported === tinyLaunch?.id && !/[\\/]/.test(reported) && !/\.gguf$/i.test(reported),
      `sidecar.model=${JSON.stringify(sc?.model)} / 期望 id=${JSON.stringify(tinyLaunch?.id)} / 含路径分隔符=${/[\\/]/.test(reported)} / 配方全路径=${tinyLaunch?.model}`);

    // ---- E4.6：那个文件**真的在盘上**（"与实际加载权重一致"的可核对形式） ----
    const ggufPath = tinyLaunch?.model ?? '';
    const onDisk = ggufPath ? fs.existsSync(ggufPath) : false;
    const inSakuraDir = /[\\/]models[\\/]sakura[\\/][^\\/]+\.gguf$/.test(ggufPath);
    check('E4.6 该权重文件**在盘上真实存在**，且落在 `models/sakura/` 下（缺权重请先 `npm run fetch:models`）',
      onDisk && inSakuraDir,
      `${ggufPath} 存在=${onDisk} 目录符合=${inSakuraDir}`);
  } finally {
    if (st.child.exitCode === null) st.child.kill('SIGTERM');
    await sleep(150);
    await closeAll([fake.server, fake.executor]);
  }

  const map = {};
  for (const r of results) map[r.id] = r;
  return map;
}

// ------------------------------------------------------------------ 反证轮

const MUTATIONS = [
  {
    // 这条盯的是 E4 的**核心防线**：未声明档位不得悄悄用 tiny 的权重。
    // 改成"回落 tiny"之后，E4.2 必须红 —— 否则这条断言只是在复述注释。
    name: 'E4.2：让 `tierModelPath` 对未声明档位**回落成 tiny 的权重**（"看起来更友好"、实际是静默假绿）',
    expect: ['E4.2 Small 权重未声明 ⇒ 路径为 null 且 `resolveLlmLaunch({tier:"small"})` **抛 TIER_MODEL_UNDECLARED**（绝不回落成 tiny 的权重）'],
    edits: [{
      file: CLIENT_SRC,
      find: '  const name = TIER_LLM_MODELS[tier];',
      replace: '  const name = TIER_LLM_MODELS[tier] ?? TIER_LLM_MODELS.tiny; // refute：静默回落',
    }],
  },
  {
    // 破坏点选在 **上报处**（`tierCtl.currentTier()` → `desiredTier`）而不是夹取处：
    // 去掉夹取会让"未声明档位"一路走到 `resolveLlmLaunch` 把服务**启动即搞崩**，
    // 那样 `runAll()` 抛异常、断言根本没机会跑 —— 强是强，但不是"断言变红"的证据。
    // 这里破坏的正是 E4.4 要防的那件事：**报用户配置的档位，而不是生效档位**。
    name: 'E4.4：让 `/health.sidecar.tier` 报**用户配置**的档位（而不是生效档位）',
    expect: ['E4.4 `/health.sidecar.tier` 报的是**生效档位**（small 未纳入清单 ⇒ 夹回 tiny），不是用户配置的 small'],
    edits: [{
      file: SERVER_SRC,
      find: '  const tier = tierCtl.currentTier();',
      replace: '  const tier = desiredTier; // refute：报配置档位，不报生效档位',
    }],
  },
  {
    // 这条盯的是 E4.5 的**形态**判据。恢复到"不做 basename"（= 修之前的真实现）必须让 E4.5 变红，
    // 否则那条断言就只是把当前实现抄了一遍。
    name: 'E4.5-a：去掉 `modelIdOf` 的 basename（把本机绝对路径泄进 `/health`）',
    expect: ['E4.5 `sidecar.model` == tiny 权重的 **model id**（basename 去扩展名），不得把本机绝对路径报给 `/health`'],
    edits: [{
      file: SUP_SRC,
      find: "if (launch.model) return path.basename(String(launch.model)).replace(/\\.gguf$/i, '');",
      replace: "if (launch.model) return String(launch.model).replace(/\\.gguf$/i, ''); // refute：不 basename",
    }],
  },
  {
    // 另一条分叉方式：上报一个**盘上不存在**的权重名（"看起来对得上配置、其实是编的"）。
    name: 'E4.5-b：让 `sidecar.model` 报一个盘上不存在的权重名（上报与实际拉起两处各说一套）',
    expect: ['E4.5 `sidecar.model` == tiny 权重的 **model id**（basename 去扩展名），不得把本机绝对路径报给 `/health`'],
    edits: [{
      file: SERVER_SRC,
      find: 'model: up ? (snap.model ?? TIER_LLM_MODELS[tier] ?? null) : null,',
      replace: "model: up ? 'sakura-7b-small-qwen2.5-v1.0-fp16' : null, // refute：报一个盘上没有的权重名",
    }],
  },
];

const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

const main = async () => {
  console.log(`E4 档位切换（《04》§14.2）${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('E4 档位取证');
    const executed = results.length;
    if (executed !== DECLARED) console.log(`\n🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${executed} 条 —— 视为失败`);
    process.exitCode = fail === 0 && executed === DECLARED ? 0 : 1;
    return;
  }

  const base = await runAll();
  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const originals = new Map();

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        continue;
      }
      writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    // 🔴 `runAll()` 必须包 try/catch：有的破坏（比如把档位夹取去掉）会让**服务进程启动即崩**，
    //    `waitReady()` 于是抛异常。若还原语句写在 try 之后，异常会把源文件**永久留成被破坏状态** ——
    //    本轮实测踩到过（`server.mjs:1532` 停在被改写的行上），只能靠 `git checkout` 手工救回。
    //    ⇒ 还原一律进 `finally`；异常本身也算"本轮判红"（服务都起不来了，断言自无变绿的可能），
    //      但要在输出里明说原因是异常，不与"断言精准命中"混为一谈。
    let res = {};
    let roundErr = null;
    try {
      res = await runAll();
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) writeFileSync(f, snap);
    }
    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏，故服务起不来）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) { red++; console.log(`  ✓ ${id.slice(0, 20)}… 按预期变红${res[id] ? '' : '（因服务未起来）'}`); }
      else { falsePositives.push(id); console.log(`  ✗ ${id.slice(0, 20)}… 该红没红 ← 假阳性`); }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [f, snap] of originals) {
    const back = readBytes(f);
    const same = back != null && back.equals(snap);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, f)} 字节${same ? '一致' : '不一致！'}`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(' / ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

await main();
