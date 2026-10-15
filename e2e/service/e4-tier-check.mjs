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
 * ## 纯函数半边现在打哪（《05》F5 · Node 服务层摘除后）
 * 原先是**另起 node 子进程 import `service/src/engine-client.mjs`** 求值。该文件随 `service/`
 * 删除后无对象 ⇒ 改为问 Rust 靶子的**单源自证出口** `boxsvc --engine-selftest`：
 *   · `constants.TIER_LLM_MODELS` —— 档位→权重表（E4.1）
 *   · `pure.tierModelPath` —— 每档权重路径，未声明为 `null`（E4.2）
 *   · `pure.llmLaunchByTier` —— 每档解析一次 ③ 配方；未声明档位**显式报错**（E4.2）
 *   · `pure.availableTiers` —— 本进程真能跑的档位（E4.3）
 * E4.5 / E4.6 的 tiny 配方也取自 `pure.llmLaunchByTier`（**与 E4.2 同源**）：
 * 两处各取一份配方就等于允许"上报与拉起各说一套"，而那正是 E4.5-b 要抓的东西。
 *
 * 🔴 为什么**子进程**问而不是直接 import：ESM 按 URL 缓存模块 —— 反证轮改了 Rust 源码并
 *    重编译之后，父进程里任何"已加载的模块"都还是第一份缓存 ⇒ 断言不可能变红，
 *    而它看起来"跑过了"。这里每次都重新 exec 一次靶子，结论直接来自当次编译产物。
 *
 * ## 反证轮为什么多一步"重编译"
 * 破坏点搬到了 Rust 源码 ⇒ 光改文件没用，必须 `cargo build --bin boxsvc` 才算数
 * （dev profile 改一个源文件实测 ~5s，可接受）。改完不编就是"看起来反证过了"——
 * 比不反证更坏，因为报告会写"5 变异全红"。
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
 *   node e2e/service/e4-tier-check.mjs --refute    反证轮（破坏源文件 → 重编译 → 断言必须变红 → 按字节还原）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（box-service 的段）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子）
import { killTree, RUST_BIN, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CARGO_DIR = path.join(ROOT, 'src-tauri');
/** 反证轮要破坏的 Rust 源码（三处，作用各不相同，别合并）。 */
const RUST_ENGINE_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'engine.rs');
const RUST_STATE_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'engine', 'state.rs');
const RUST_SUP_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'engine', 'supervisor.rs');
const TOKEN = 'f'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-e4-'));
const REFUTE = process.argv.includes('--refute');

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

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

const portOpen = (port, timeoutMs = 300) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        s.destroy();
        resolve(v);
      }
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });

async function findFreePort(start, need = 2) {
  for (let p = start; p < start + 400; p += 1) {
    let ok = true;
    for (let i = 0; i < need; i += 1)
      if (await portOpen(p + i)) {
        ok = false;
        break;
      }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${need} 个连续空闲端口`);
}

function httpGetJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: token ? { 'X-Box-Token': token } : {},
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 问 Rust 靶子一次自证出口（`--engine-selftest`）。
 *
 * 🔴 为什么固定 real 协议：E4 考的是「清单里只有 Tiny 权重的**真档**」。mock 档的
 *    `resolve_mock_llm_launch` 压根不查 `TIER_LLM_MODELS`（每档都给 `sakura-mock:<tier>`），
 *    在那一档上问出来的"未声明档位"永远是假的。
 * 🔴 为什么显式删掉 `MIAO_LLM_MODEL` / `MIAO_LLM_BIN`：③ 配方的解析是
 *    `overrides.model ?? env.MIAO_LLM_MODEL ?? tier_model_path(tier)` —— 开发机上碰巧
 *    设过这两个环境变量的话，本脚本验的就不是"清单里有没有这档权重"，而是"环境变量填了什么"。
 */
function rustSelftest() {
  const env = { ...process.env, MIAO_ENGINE_PROTOCOL: 'real' };
  delete env.MIAO_LLM_MODEL;
  delete env.MIAO_LLM_BIN;
  const r = spawnSync(RUST_BIN, ['--engine-selftest'], {
    encoding: 'utf8',
    env,
    maxBuffer: 40 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return { __error: `靶子退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}` };
  // 🔴 去 BOM：Windows 上控制台管道可能给 stdout 盖一个 BOM，不剥掉 `JSON.parse` 会在
  //    第一个字符就抛 `Unexpected token`（D-203 修文档时踩过同族坑：报错信息里那个"怪字符"
  //    才是全部线索）。
  try {
    return JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim());
  } catch (e) {
    return { __error: `解析 --engine-selftest 输出失败：${String(e.message).slice(0, 200)}` };
  }
}

/** 编译 Rust 靶子（反证轮改完源码必须重编，否则断言验的是"上一份产物"）。 */
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
  const executor = net.createServer(() => {
    /* 哑 socket ⇒ running */
  });
  return { server, executor };
}

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));

function spawnService(env) {
  const child = spawnTarget(SERVICE_ENTRY, env);
  const st = { child, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) {
      try {
        st.ready = JSON.parse(m[1]);
      } catch {
        /* 继续等 */
      }
    }
  });
  child.stderr.on('data', (d) => {
    st.err += d.toString();
  });
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

  // ---- 纯函数半边：一次靶子自证出口喂四条断言（每次都重新 exec，不吃任何缓存）----
  const sel = rustSelftest();
  const models = sel?.constants?.TIER_LLM_MODELS;
  const modelPaths = Object.fromEntries((sel?.pure?.tierModelPath ?? []).map((x) => [x.tier, x.path]));
  const launches = Object.fromEntries((sel?.pure?.llmLaunchByTier ?? []).map((x) => [x.tier, x]));

  // ---- E4.1：未纳入清单的档位是 `null`，不是空串、不是 tiny 的文件名 ----
  check(
    'E4.1 档位→权重表里 Small/Medium **显式声明为 null**（不是"没这个键"，也不是顺手填了 tiny 的文件名）',
    typeof models?.tiny === 'string' &&
      models.tiny !== '' &&
      Object.prototype.hasOwnProperty.call(models, 'small') &&
      models.small === null &&
      Object.prototype.hasOwnProperty.call(models, 'medium') &&
      models.medium === null,
    JSON.stringify(models),
  );

  // ---- E4.2：未声明的档位必须**抛错**，不得静默回落 ----
  const smallLaunch = launches?.small;
  check(
    'E4.2 Small 权重未声明 ⇒ 路径为 null 且解析该档 ③ 配方时**显式报 TIER_MODEL_UNDECLARED**（绝不回落成 tiny 的权重）',
    modelPaths.small === null &&
      smallLaunch?.ok === false &&
      smallLaunch?.code === 'TIER_MODEL_UNDECLARED' &&
      Array.isArray(smallLaunch?.detail?.available),
    `tierModelPath('small')=${JSON.stringify(modelPaths.small)} / small 档配方=${JSON.stringify(smallLaunch)}`,
  );

  // ---- E4.3：本进程真能跑的档位范围 ----
  const avail = sel?.pure?.availableTiers;
  check(
    'E4.3 real 协议下 `availableTiers()` 恰为 ["tiny"]（= 清单里真有权重的那些；本机没有 Small/Medium 权重）',
    Array.isArray(avail) && avail.length === 1 && avail[0] === 'tiny',
    JSON.stringify(avail),
  );

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
      if (r.status === 200 && r.body?.sidecar?.state === 'running') {
        health = r.body;
        break;
      }
      await sleep(150);
    }
    const sc = health?.sidecar;

    check(
      'E4.4 `/health.sidecar.tier` 报的是**生效档位**（small 未纳入清单 ⇒ 夹回 tiny），不是用户配置的 small',
      sc?.tier === 'tiny',
      `配置=MIAO_ENGINE_TIER=small / 上报 tier=${JSON.stringify(sc?.tier)} / state=${JSON.stringify(sc?.state)}`,
    );

    // ---- E4.5：上报的 model 是**契约里的 model id 形态**（basename 去扩展名），不是本机绝对路径 ----
    // 契约《03》§5.1 的示例是 `"model": "sakura-1.5b-qwen2.5-v1.0-iq4xs"` —— 没有目录、没有扩展名。
    // 真档的 ③ 配方 `model` 却是**盘上绝对路径**（`tier_model_path()` 给的），`model_id_of`
    // 在"优先取 `launch.model`"这条分支上必须先 basename —— 否则
    // `…/runtimes/manga-translator/models/sakura/sakura-…-fp16` 整个泄进 `/health`。
    const tinyModel = launches?.tiny?.model ?? '';
    // 同时认正斜杠与反斜杠两种分隔符：Windows 盘上路径用反斜杠，只按 split(斜杠) 切会取到整条路径，
    // 于是「期望 id」变成绝对路径、E4.5 在 Windows 假红（本机即踩）。
    const tinyId = String(tinyModel)
      .split(/[\\/]/)
      .pop()
      .replace(/\.gguf$/i, '');
    const reported = sc?.model ?? '';
    check(
      'E4.5 `sidecar.model` == tiny 权重的 **model id**（basename 去扩展名），不得把本机绝对路径报给 `/health`',
      !!reported && reported === tinyId && !/[\\/]/.test(reported) && !/\.gguf$/i.test(reported),
      `sidecar.model=${JSON.stringify(sc?.model)} / 期望 id=${JSON.stringify(tinyId)} / 含路径分隔符=${/[\\/]/.test(reported)} / 配方全路径=${tinyModel}`,
    );

    // ---- E4.6：那个文件**真的在盘上**（"与实际加载权重一致"的可核对形式） ----
    const onDisk = tinyModel ? fs.existsSync(tinyModel) : false;
    const inSakuraDir = /[\\/]models[\\/]sakura[\\/][^\\/]+\.gguf$/.test(tinyModel);
    check(
      'E4.6 该权重文件**在盘上真实存在**，且落在 `models/sakura/` 下（缺权重请先 `npm run task -- fetch:models`）',
      onDisk && inSakuraDir,
      `${tinyModel} 存在=${onDisk} 目录符合=${inSakuraDir}`,
    );
  } finally {
    // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
    if (st.child.exitCode === null) killTree(st.child);
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
    // 🔴 破坏点选在 `tier_model_path`（③ 配方解析的**权重来源**）而不是报错分支：
    //    在这里改，未声明档位会一路拿到 tiny 的路径并**成功**解析出配方，
    //    `TIER_MODEL_UNDECLARED` 压根不会被触发 —— 这正是"静默假绿"的完整形态。
    name: 'E4.2：让 `tier_model_path` 对未声明档位**回落成 tiny 的权重**（"看起来更友好"、实际是静默假绿）',
    expect: [
      'E4.2 Small 权重未声明 ⇒ 路径为 null 且解析该档 ③ 配方时**显式报 TIER_MODEL_UNDECLARED**（绝不回落成 tiny 的权重）',
    ],
    edits: [
      {
        file: RUST_ENGINE_SRC,
        find: '    let name = TIER_LLM_MODELS.iter().find(|(k, _)| *k == tier).and_then(|(_, v)| *v)?;',
        replace:
          '    let name = TIER_LLM_MODELS.iter().find(|(k, _)| *k == tier).map(|(_, v)| v.unwrap_or(TIER_LLM_MODELS[0].1.unwrap())).unwrap(); // refute：静默回落成 tiny 的权重',
      },
    ],
  },
  {
    // 破坏点选在 **上报处**（`compose_sidecar` 取档位的那一行）而不是夹取处。
    // 🔴 本轮**实测过**动夹取处（`clamp_tier_to_available` 优先尊重配置）：编译能过，但服务
    //    **启动即崩** —— 未声明档位一路走到 ③ 配方解析，`runAll()` 抛异常、断言根本没机会跑。
    //    那种红是"服务都起不来了"，不是"断言抓到了上报 bug"，两回事。
    // 这里破坏的正是 E4.4 要防的那件事：**报用户配置的档位，而不是生效档位**。
    name: 'E4.4：让 `/health.sidecar.tier` 报**用户配置**的档位（而不是生效档位）',
    expect: ['E4.4 `/health.sidecar.tier` 报的是**生效档位**（small 未纳入清单 ⇒ 夹回 tiny），不是用户配置的 small'],
    edits: [
      {
        file: RUST_STATE_SRC,
        find: '        let tier = self.tier_ctl.current_tier();',
        replace:
          '        let tier = self.engine_tier_choice.clone().unwrap_or_else(|| self.tier_ctl.current_tier()); // refute：报配置档位',
      },
    ],
  },
  {
    // 这条盯的是 E4.5 的**形态**判据。恢复到"不做 basename"必须让 E4.5 变红，
    // 否则那条断言就只是把当前实现抄了一遍。
    name: 'E4.5-a：去掉 `model_id_of` 的 basename（把本机绝对路径泄进 `/health`）',
    expect: ['E4.5 `sidecar.model` == tiny 权重的 **model id**（basename 去扩展名），不得把本机绝对路径报给 `/health`'],
    edits: [
      {
        file: RUST_SUP_SRC,
        find: '        return Some(strip_gguf(&basename(m)));',
        replace: '        return Some(strip_gguf(m)); // refute：不 basename',
      },
    ],
  },
  {
    // 另一条分叉方式：上报一个**盘上不存在**的权重名（"看起来对得上配置、其实是编的"）。
    name: 'E4.5-b：让 `sidecar.model` 报一个盘上不存在的权重名（上报与实际拉起两处各说一套）',
    expect: ['E4.5 `sidecar.model` == tiny 权重的 **model id**（basename 去扩展名），不得把本机绝对路径报给 `/health`'],
    edits: [
      {
        file: RUST_STATE_SRC,
        find: [
          '        let model = if up {',
          '            snap.model.clone().or_else(|| tier_model_name(&tier))',
          '        } else {',
          '            None',
          '        };',
        ].join('\r\n'),
        replace: [
          '        let model = if up {',
          '            Some("sakura-7b-small-qwen2.5-v1.0-fp16".to_string()) // refute：报一个盘上没有的权重名',
          '        } else {',
          '            None',
          '        };',
        ].join('\r\n'),
      },
    ],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

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

  // 🔴 进反证轮前先确保「产物 == 磁盘源码」：否则基线跑的是别人留下的上一份编译结果，
  //    而"变异全红"里有一部分红是被这份陈旧产物误打误撞造成的。
  const pre = buildRust();
  if (!pre.ok) {
    console.log(`✗ 开跑前 cargo build 失败，无法反证：${pre.log}`);
    process.exitCode = 1;
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

  console.log('\n破坏 Rust 源码 → 重编译 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    let anchorMissing = false;
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(
          `⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`,
        );
        anchorMissing = true;
        skipped += mut.expect.length;
        break;
      }
      fs.writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    if (anchorMissing) continue;

    // 🔴 改完源码**必须重编**才作数：不编就等于拿旧产物跑断言，红的绿的都说明不了问题。
    const built = buildRust();
    if (!built.ok) {
      console.log(`⚠ ${mut.name}\n    破坏后编译失败（多半是锚点选错行），本条无法反证：${built.log}`);
      skipped += mut.expect.length;
      continue;
    }

    // 🔴 `runAll()` 必须包 try/catch：有的破坏（比如把档位夹取去掉）会让**服务进程启动即崩**，
    //    `waitReady()` 于是抛异常。若还原语句写在 try 之后，异常会把源文件**永久留成被破坏状态**。
    //    ⇒ 还原一律进 `finally`；异常本身也算"本轮判红"（服务都起不来了，断言自无变绿的可能），
    //      但要在输出里明说原因是异常，不与"断言精准命中"混为一谈。
    let res = {};
    let roundErr = null;
    try {
      res = await runAll();
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap);
    }
    console.log(`🔴 ${mut.name}`);
    if (roundErr)
      console.log(`   ⚠ 本轮 runAll 抛异常（源码已被破坏，故服务起不来）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id.slice(0, 20)}… 按预期变红${res[id] ? '' : '（因服务未起来）'}`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id.slice(0, 20)}… 该红没红 ← 假阳性`);
      }
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
  // 源码还原了，**产物也必须还原** —— 否则留下一个「源码是好的、跑起来是坏的」的机器。
  const rebuilt = buildRust();
  if (!rebuilt.ok) {
    restoreFail++;
    console.log(`  ✗ cargo build 还原失败：${rebuilt.log}`);
  } else console.log('  ✓ cargo build 已把靶子重编回未破坏状态');

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到 / 编译失败）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 项未恢复到原始状态`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(' / ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

await main();
