/**
 * 随包资源寻址（A1）与随包资产清单（A2）—— 三环境取证 + 源码钉
 *
 * ## 它钉的是什么
 * 打包后 `repo_root()` **算不出真仓库根**：它向上找"同时含 `service/` 与 `engine/`"的目录，
 * 而 F5 之后这两样一个字节都没进包 ⇒ 向上永远找不到 ⇒ 退回 cwd ⇒ 清单/引擎/venv 路径全错位，
 * 而用户看到的报错停在几层之外（"连接失败" / "启动超时"）。
 *
 * A1 让 Rust **先查资源目录**（`$RESOURCE`），A2 保证那个目录里**有东西**。
 * 两者缺一都等于没做：只有 A1 是"找到了一个空目录"，只有 A2 是"东西在包里但没人去找"。
 *
 * ## 为什么必须三环境取证
 * 只跑 dev 态 ⇒ 资产就在仓库里，代码会回退过去 ⇒ **永远绿**，打包态的错测不出来（这是假绿）。
 * 只跑"模拟打包" ⇒ 又会把 dev 态误判成缺失（假红）。
 * ⇒ 判据必须是「**最终拿不拿得到**」：资源目录里有 ⇒ resource；否则仓库里有 ⇒ repo；都没有 ⇒ 缺失。
 *
 * ## 反证轮（`--refute`）
 * - R1 建了资源目录但**不放**资产 ⇒ 打包态必须红
 *   （抓"只判 `resource_dir().is_dir()` 就通过"这种最容易写出来的假绿）。
 * - R2 删掉 `service.rs` 启动前置门里的 `missing_assets()` 调用 ⇒ 源码钉 S1 变红
 *   （抓"自检写了但没人调用"——A1 的最坏失效形态）。
 * - R3 把启动门的报错文本改成"连接失败" ⇒ 源码钉 S2 变红
 *   （抓"报错离根因极远"，那正是 A1 要消灭的东西）。
 *
 * 用法：
 *   node e2e/resources-check.mjs            正向跑（期望全绿）
 *   node e2e/resources-check.mjs --refute   反证轮（破坏 → 变红 → 按字节还原）
 *
 * 约束：纯 Node 零依赖；子进程只起 `boxsvc --check-assets`（**不起服务、不绑端口**，毫秒级）。
 *       源码钉不起进程；反证轮结束**必须**按字节还原。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(
  ROOT,
  'app',
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32' ? 'boxsvc.exe' : 'boxsvc',
);
const SERVICE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'service.rs');
const BASE_CONF = path.join(ROOT, 'app', 'src-tauri', 'tauri.conf.json');

const REFUTE = process.argv.includes('--refute');

/// 必需资产 —— 必须与 Rust 侧 `paths::REQUIRED_ASSETS` 和 `check:bundle` 的常量逐项一致。
/// 🔴 这是**第二处事实源**（Rust 常量读不进 node），所以 X1 做交叉验证：
///    拿 `boxsvc --check-assets` 报出来的必需资产与这里比对，漂移即红。
const REQUIRED_ASSETS = ['engine/models.manifest.json', 'engine/runtime.manifest.json', 'engine/patches.json'];

const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

// ------------------------------------------------------------------ 子进程取证

function runBin(env) {
  return new Promise((res) => {
    // 🔴 必须**异步** spawn：本机沙箱里 `spawnSync`/`execFileSync` 起子进程会 EBUSY。
    const p = spawn(BIN, ['--check-assets'], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      out = '';
      err = String(e && e.message);
      res({ code: -1, out, err });
    });
    p.on('close', (code) => res({ code, out, err }));
  });
}

const parseReport = (out) => {
  try {
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
};

/// 造一棵模拟的资源目录树。`withAsset=false` 时**只建目录不放资产**（R1 的夹具）。
function makeFixture(name, { withAsset = true, dirOnly = false } = {}) {
  const base = path.join(ROOT, '.tmp', 'resources-check', name);
  fs.rmSync(base, { recursive: true, force: true });
  if (dirOnly) return { resources: path.join(base, 'Resources'), repo: path.join(base, 'empty') };
  fs.mkdirSync(path.join(base, 'Resources', 'engine'), { recursive: true });
  fs.mkdirSync(path.join(base, 'empty'), { recursive: true });
  if (withAsset) {
    // 🔴 按 `REQUIRED_ASSETS` **逐条**铺，不写死文件名：新增必需资产时忘了改这里 ⇒
    //    D2 假红（「配好了却报缺失」），而这种红会把人引去查 A1/A2 的实现 ——
    //    其实只是夹具没跟上。G2 加 `engine/runtime.manifest.json` 时就是这么红过一次。
    for (const rel of REQUIRED_ASSETS) {
      const segs = rel.split('/');
      const dst = path.join(base, 'Resources', ...segs);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, ...segs), dst);
    }
  }
  return { resources: path.join(base, 'Resources'), repo: path.join(base, 'empty') };
}

// ------------------------------------------------------------------ 正向断言

async function runDynamic() {
  if (!fs.existsSync(BIN)) {
    check('D0', '`boxsvc` 可执行存在（先 `cargo build --bin boxsvc`）', false, `缺失：${BIN}`);
    return;
  }

  // ---- D1 dev 态：**不误报**（资产就在仓库里）----
  //     🔴 反证点：若 `missing_assets()` 只查资源目录，这里会红（假红），
  //     而那种"永远报缺失"的报错会把真缺失淹没掉。
  {
    const r = await runBin({});
    const rep = parseReport(r.out);
    const item = rep && Array.isArray(rep.assets) ? rep.assets[0] : null;
    check(
      'D1',
      'dev 态**不报**资源缺失，且资产来源 = `repo`（证明 dev 态回退到仓库路径，行为未变）',
      r.code === 0 && !!rep && rep.ok === true && item && item.source === 'repo',
      rep
        ? `exit=${r.code} ok=${rep.ok} source=${item && item.source}`
        : `exit=${r.code} 输出非 JSON：${r.err || r.out}`,
    );
  }

  // ---- D2 打包态齐备：资源目录里有 ⇒ 来源 = `resource` ----
  {
    const f = makeFixture('packaged-ok');
    const r = await runBin({ MIAO_RESOURCE_DIR: f.resources, MIAO_REPO_ROOT: f.repo });
    const rep = parseReport(r.out);
    const item = rep && Array.isArray(rep.assets) ? rep.assets[0] : null;
    check(
      'D2',
      '打包态齐备：资源目录里有资产 ⇒ ok=true 且来源 = `resource`（A1 真的在用它，不是还在用仓库）',
      r.code === 0 && !!rep && rep.ok === true && item && item.source === 'resource',
      rep ? `exit=${r.code} ok=${rep.ok} source=${item && item.source}` : `exit=${r.code} ${r.err || r.out}`,
    );
  }

  // ---- D3 打包态缺失：两边都没有 ⇒ 报缺失且退出码非 0 ----
  //     🔴 反证点：这就是「A2 漏配」的形态 —— dev 态**永远测不出来**，只能这样模拟。
  {
    const f = makeFixture('packaged-missing', { withAsset: false });
    const r = await runBin({ MIAO_RESOURCE_DIR: f.resources, MIAO_REPO_ROOT: f.repo });
    const rep = parseReport(r.out);
    check(
      'D3',
      '打包态缺失：报 `RESOURCE_MISSING` 且退出码 ≠ 0（A2 漏配时**必须**喊出来，不许静默回退）',
      r.code !== 0 && r.err.includes('RESOURCE_MISSING') && !!rep && rep.ok === false,
      `exit=${r.code} stderr=${r.err.trim() || '（空）'}`,
    );
  }

  // ---- D4 两边都有 ⇒ 资源目录**优先**（否则打包后仍在用仓库里那份旧的）----
  {
    const f = makeFixture('both');
    const r = await runBin({ MIAO_RESOURCE_DIR: f.resources, MIAO_REPO_ROOT: ROOT });
    const rep = parseReport(r.out);
    const item = rep && Array.isArray(rep.assets) ? rep.assets[0] : null;
    check(
      'D4',
      '资源目录与仓库**都有**时取资源目录（优先级反了 ⇒ 打包后读的是开发态那份）',
      !!rep && item && item.source === 'resource',
      rep ? `source=${item && item.source}` : `输出非 JSON：${r.out}`,
    );
  }

  // ---- X1 必需资产交叉验证：Rust 侧与配置/e2e 侧不得漂移 ----
  {
    const r = await runBin({});
    const rep = parseReport(r.out);
    const names = rep && Array.isArray(rep.assets) ? rep.assets.map((a) => a.name).sort() : null;
    const want = [...REQUIRED_ASSETS].sort();
    check(
      'X1',
      'Rust 侧 `paths::REQUIRED_ASSETS` 与本脚本/`check:bundle` 的常量**逐项一致**（三处事实源，漂移即红）',
      !!names && names.length === want.length && names.every((n, i) => n === want[i]),
      `rust=${JSON.stringify(names)} 期望=${JSON.stringify(want)}`,
    );
  }
}

// ------------------------------------------------------------------ 源码钉

/// 剥注释：本仓库注释**主动写出了被禁的写法**，不剥就是把注释当代码匹配（D-149 同源）。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function runSourcePins() {
  const src = fs.readFileSync(SERVICE_RS, 'utf8');
  const code = stripComments(src);

  // ---- S1 启动前置门真的调了 `missing_assets()` ----
  //     🔴 最坏失效形态：自检函数写了、单测也绿，但**产品启动路径没调用它** ⇒ 打包后照旧静默错。
  const startIdx = code.indexOf('fn start_blocking');
  const body = startIdx >= 0 ? code.slice(startIdx, startIdx + 4000) : '';
  check(
    'S1',
    '`service.rs::start_blocking` 里调用了 `paths::missing_assets()`（自检不接进启动路径 = 形同虚设）',
    body.includes('paths::missing_assets()'),
    startIdx >= 0
      ? `在 start_blocking 内${body.includes('paths::missing_assets()') ? '找到' : '未找到'}调用`
      : '未找到 start_blocking',
  );

  // ---- S2 报错文本指向「资源缺失」，不是连接失败 ----
  //     A1 验收②的原话：报错必须明确指向「资源缺失」，**不是** `Connection error`。
  const hasMissingText = /资源缺失/.test(body);
  const saysConnection = /Connection error|连接失败|连接错误/.test(body);
  check(
    'S2',
    '启动前置门的报错文本明确写「资源缺失」，且**不含**「连接失败/Connection error」这类离根因极远的说法',
    hasMissingText && !saysConnection,
    `含「资源缺失」=${hasMissingText} 含连接类措辞=${saysConnection}`,
  );

  // ---- S3 自检必须在**起任何子进程之前**（否则报错会被子进程的输出盖掉）----
  const mi = body.indexOf('missing_assets()');
  const si = body.indexOf('load_plan(');
  check(
    'S3',
    '资产自检排在取启动配方（`load_plan`）**之前**（先起子进程再自检 ⇒ 报错被子进程输出淹没）',
    mi >= 0 && si >= 0 && mi < si,
    mi >= 0 && si >= 0 ? `missing@${mi} < load_plan@${si}` : `missing=${mi} load_plan=${si}`,
  );
}

// ------------------------------------------------------------------ 输出

function printResults(title) {
  console.log(`\n【${title}】`);
  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${results.length - fail} / 失败 ${fail}`);
  return { fail };
}

// ------------------------------------------------------------------ 反证

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

/// 每条变异 = 把某一处**改回缺陷形态**，并声明哪几条断言必须因此变红。
const MUTATIONS = [
  {
    name: 'R1 资源目录建了但**不放**资产（抓"只判目录存在就通过"的假绿）',
    kind: 'fixture',
    expect: ['D2'],
    async run() {
      const f = makeFixture('packaged-ok', { withAsset: false });
      const r = await runBin({ MIAO_RESOURCE_DIR: f.resources, MIAO_REPO_ROOT: f.repo });
      const rep = parseReport(r.out);
      const item = rep && Array.isArray(rep.assets) ? rep.assets[0] : null;
      return !(r.code === 0 && rep && rep.ok === true && item && item.source === 'resource');
    },
  },
  {
    name: 'R2 删掉启动前置门里的 `missing_assets()` 调用（自检写了但没人调）',
    edits: [
      {
        file: SERVICE_RS,
        find: '        let missing = paths::missing_assets();',
        replace: '        let missing: Vec<String> = Vec::new();',
      },
    ],
    expect: ['S1', 'S3'],
  },
  {
    name: 'R3 启动门的报错改成「连接失败」（离根因极远的说法）',
    edits: [
      {
        file: SERVICE_RS,
        find: '资源缺失：{}；资源目录={dir}。安装包不完整或引擎资产未随包，请重新安装喵坞',
        replace: '连接失败：{}；资源目录={dir}',
      },
    ],
    expect: ['S2'],
  },
];

const main = async () => {
  console.log(`随包资源寻址（A1/A2）${REFUTE ? ' · 反证轮' : ''}`);

  await runDynamic();
  runSourcePins();

  if (!REFUTE) {
    const { fail } = printResults('随包资源 · 三环境取证 + 源码钉');
    process.exitCode = fail === 0 ? 0 : 1;
    return;
  }

  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  const falsePositives = [];
  const originals = new Map();

  console.log('\n破坏 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    if (mut.kind === 'fixture') {
      const turnedRed = await mut.run();
      total += mut.expect.length;
      if (turnedRed) {
        red += mut.expect.length;
        console.log(`🔴 ${mut.name}\n    ✓ ${mut.expect.join(' / ')} 按预期变红`);
      } else {
        falsePositives.push(mut.name);
        console.log(`🔴 ${mut.name}\n    ✗ 仍是绿的 —— 该条抓不到它声称的缺陷`);
      }
      continue;
    }

    let missing = false;
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const buf = originals.get(e.file);
      const txt = buf.toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(
          `⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`,
        );
        missing = true;
      }
    }
    if (missing) {
      falsePositives.push(`${mut.name}（锚点缺失）`);
      total += mut.expect.length;
      continue;
    }

    for (const e of mut.edits) {
      const buf = originals.get(e.file);
      fs.writeFileSync(e.file, buf.toString('utf8').replace(e.find, e.replace));
    }

    results.length = 0;
    await runDynamic();
    runSourcePins();
    const nowRed = {};
    for (const r of results) nowRed[r.id] = !r.ok;

    for (const id of mut.expect) {
      total++;
      if (wasGreen[id] !== true) {
        falsePositives.push(`${mut.name}（${id} 基线上就不是绿的）`);
      } else if (nowRed[id]) {
        red++;
        console.log(`🔴 ${mut.name}\n    ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(`${mut.name} → ${id}`);
        console.log(`🔴 ${mut.name}\n    ✗ ${id} 仍是绿的 —— 该条抓不到它声称的缺陷`);
      }
    }
  }

  console.log('\n恢复校验');
  for (const [f, buf] of originals) {
    fs.writeFileSync(f, buf);
    const now = readBytes(f);
    console.log(`  ${now && now.equals(buf) ? '✓' : '✗'} ${path.relative(ROOT, f)} 字节一致`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红`);
  if (falsePositives.length) {
    console.log(`✗ 有 ${falsePositives.length} 条未能反证：${falsePositives.join('；')}`);
    process.exitCode = 1;
  } else {
    console.log('✓ 全部反证成立：每条断言都能捕捉到它声称捕捉的机制。');
  }
};

await main();
