#!/usr/bin/env node
/**
 * B4 · 「`pydensecrf` 预编译 wheel」钉子 —— 无编译器的机器也能装
 * =============================================================================
 * 对应计划文档 B4：用户自装的最大摩擦点（要 MSVC / Xcode CLT）。
 * 落点：按平台预构建 wheel 放镜像通道并**清单化 sha256**；**不随包**。
 *
 * ## 本脚本钉的是什么（以及为什么不钉"真装一次"）
 * 「真装一次并让引擎跑起来」需要一台**没有**编译器的目标机 + 真 wheel ——
 * 那只能在目标平台真机做（归 `check:e3:real` / 人工验收）。
 * 但这条链路上真正会静默失效的是**选择逻辑**，而它完全可以在秒级内被钉住：
 *
 *   WB.W2 清单为空 ⇒ 走源码编译（**回退是前提，不是降级**：清单空不该让装配整体失败）；
 *   WB.W3 有本平台条目且 **sha256 对得上** ⇒ 优先走 wheel（验收①的机器形态）；
 *   WB.W4 sha256 对不上 ⇒ **拒绝使用**、回退源码编译 —— 这一条证明"清单化 sha256"
 *         真的在起作用，而不只是一个躺在 JSON 里的字段；
 *   WB.W5 wheel 不在盘上 ⇒ 回退，不报错；
 *   WB.W6 清单里只有**别的平台**的条目 ⇒ 回退（不许在 Windows 上装 macOS 的 wheel，
 *         同 C3 那个教训：平台过滤只该有一处实现）。
 *
 * 🔴 全部断言都走 `--print-plan` 这个**产品自己的出口**，不是脚本里另写一遍判定 ——
 *    另写一遍就等于测"我抄得对不对"，而产品走的是另一条路。
 *
 * ## 反证轮（--refute）
 *   MB1 去掉 sha256 比对 ⇒ WB.W4 红；
 *   MB2 去掉平台/ABI 过滤 ⇒ WB.W6 红；
 *   MB3 命中条目也返回 `source` ⇒ WB.W3 红。
 *
 * 用法：node e2e/engine/pydensecrf-wheel-check.mjs [--refute]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const DEPS_MJS = path.join(ROOT, 'engine', 'scripts', 'install-engine-deps.mjs');
const WHEELS_JSON = path.join(ROOT, 'engine', 'wheels.manifest.json');
const GUIDE_WIN = path.join(ROOT, 'docs', 'install-guide-windows.md');
const GUIDE_MAC = path.join(ROOT, 'docs', 'install-guide-macos.md');
const MJS_ORIGINAL = fs.readFileSync(DEPS_MJS);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 跑产品的 `--print-plan`（夹具通过 `MIAO_*` 接缝注入），返回解析后的 JSON。 */
function printPlan(env = {}) {
  const r = spawnSync(process.execPath, [DEPS_MJS, '--print-plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const text = `${r.stdout ?? ''}`.trim();
  try {
    return { ...JSON.parse(text), code: r.status };
  } catch {
    return { parseError: true, code: r.status, out: text.slice(0, 300), err: String(r.stderr ?? '').slice(0, 300) };
  }
}

// ------------------------------------------------------------------ 夹具

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-wheel-'));
const wheelDir = path.join(tmp, 'wheels');
fs.mkdirSync(wheelDir, { recursive: true });

/** 先问产品"你是哪个平台"，再照它写夹具 —— 夹具自己推平台名就等于把判据抄了一遍。 */
const probe = printPlan({ MIAO_WHEELS_MANIFEST: path.join(tmp, 'empty.json') });
const PLATFORM = probe.platform;
const PY_TAG = probe.pythonTag;
if (!PLATFORM || !PY_TAG) {
  console.error(`无法从产品取得平台/ABI（--print-plan 输出异常）：${JSON.stringify(probe)}`);
  process.exit(1);
}

const REAL_FILE = `pydensecrf-2.2.2-${PY_TAG}-${PY_TAG}-fixture.whl`;
const otherFile = 'pydensecrf-2.2.2-cp311-cp311-other.whl';
const wheelBytes = Buffer.from('not a real wheel, but the hash is real\n');
fs.writeFileSync(path.join(wheelDir, REAL_FILE), wheelBytes);

function writeManifest(name, wheels, extra = {}) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify({ manifestVersion: 1, purpose: '夹具', wheels, ...extra }, null, 2));
  return p;
}

const envFor = (manifestPath) => ({ MIAO_WHEELS_MANIFEST: manifestPath, MIAO_WHEEL_DIR: wheelDir });

// ------------------------------------------------------------------ WB.W1 清单结构

{
  const j = JSON.parse(fs.readFileSync(WHEELS_JSON, 'utf8'));
  const problems = [];
  if (j.manifestVersion !== 1) problems.push('manifestVersion 不是 1');
  if (!Array.isArray(j.wheels)) problems.push('wheels 不是数组');
  if (!j.purpose) problems.push('缺 purpose（不写清它是什么，后来者会以为它必须非空）');
  if (!j.fillHowTo) problems.push('缺 fillHowTo（"怎么填一条"必须写在文件里，不能只活在对话里）');
  for (const w of j.wheels ?? []) {
    if (!w.platform) problems.push(`${w.id ?? '?'}: 缺 platform`);
    if (!w.pythonTag) problems.push(`${w.id ?? '?'}: 缺 pythonTag`);
    if (!w.file) problems.push(`${w.id ?? '?'}: 缺 file`);
    // 🔴 sha256 形态必须钉：凭记忆写一个假的比不写更坏（校验会拦下真 wheel，或者更糟：拦不住假的）
    if (!/^[0-9a-f]{64}$/.test(String(w.sha256 ?? ''))) problems.push(`${w.id ?? '?'}: sha256 不是 64 位小写十六进制`);
    if (!w.url) problems.push(`${w.id ?? '?'}: 缺 url（镜像通道的来源）`);
  }
  check('WB.W1 `engine/wheels.manifest.json` 结构合法：条目（若有）逐条带 platform / pythonTag / file / 64 位 sha256 / url，'
    + '且写清了 purpose 与 fillHowTo', problems.length === 0, problems);
}

// ------------------------------------------------------------------ WB.W2 空清单 ⇒ 回退源码编译

{
  const empty = writeManifest('empty.json', []);
  const plan = printPlan(envFor(empty));
  check('WB.W2 清单为空 ⇒ 走源码编译（**回退是前提**：清单空不该让装配整体失败），且 reason 说得出为什么',
    plan.route === 'source' && /还没有任何条目/.test(String(plan.reason)), plan);
}

// ------------------------------------------------------------------ WB.W3 命中 ⇒ 优先 wheel

{
  const ok = writeManifest('ok.json', [{
    id: 'fixture', platform: PLATFORM, pythonTag: PY_TAG, file: REAL_FILE,
    sha256: sha256(wheelBytes), sizeBytes: wheelBytes.length, url: 'https://example.invalid/whl',
  }]);
  const plan = printPlan(envFor(ok));
  check('WB.W3 有本平台条目且 sha256 对得上 ⇒ 走 **wheel**（不编译 —— 这正是"无编译器也能装"的全部意义）',
    plan.route === 'wheel' && /sha256 已核对/.test(String(plan.reason)) && plan.wheelAbs === path.join(wheelDir, REAL_FILE),
    plan);
}

// ------------------------------------------------------------------ WB.W4 sha256 不符 ⇒ 拒绝

{
  const bad = writeManifest('badhash.json', [{
    id: 'fixture', platform: PLATFORM, pythonTag: PY_TAG, file: REAL_FILE,
    sha256: '0'.repeat(64), sizeBytes: wheelBytes.length, url: 'https://example.invalid/whl',
  }]);
  const plan = printPlan(envFor(bad));
  check('WB.W4 sha256 与盘上不符 ⇒ **拒绝使用**并回退源码编译（宁可慢，也不装一个不是我们验过的东西）'
    + '—— 这一条证明"清单化 sha256"真的在起作用，不只是个字段',
    plan.route === 'source' && /sha256 与清单不符/.test(String(plan.reason)), plan);
}

// ------------------------------------------------------------------ WB.W5 wheel 不在盘上 ⇒ 回退

{
  const missing = writeManifest('missing.json', [{
    id: 'fixture', platform: PLATFORM, pythonTag: PY_TAG, file: 'not-downloaded-yet.whl',
    sha256: sha256(wheelBytes), sizeBytes: wheelBytes.length, url: 'https://example.invalid/whl',
  }]);
  const plan = printPlan(envFor(missing));
  check('WB.W5 清单有本平台条目但 wheel 不在盘上 ⇒ 回退源码编译（**不报错**：便利通道缺件不该让装配失败）',
    plan.route === 'source' && /不在盘上/.test(String(plan.reason)), plan);
}

// ------------------------------------------------------------------ WB.W6 别的平台的条目 ⇒ 不许用

{
  const other = PLATFORM === 'win32-x64' ? 'darwin-arm64' : 'win32-x64';
  const foreign = writeManifest('foreign.json', [{
    id: 'fixture', platform: other, pythonTag: PY_TAG, file: otherFile,
    sha256: sha256(wheelBytes), sizeBytes: wheelBytes.length, url: 'https://example.invalid/whl',
  }]);
  const plan = printPlan(envFor(foreign));
  check('WB.W6 清单里只有**别的平台**的条目 ⇒ 回退源码编译（不许在 Windows 上装 macOS 的 wheel —— 平台过滤只该有一处实现）',
    plan.route === 'source' && /没有本平台/.test(String(plan.reason)), { plan, other });
}

// ------------------------------------------------------------------ WB.W9 跨平台可问：`--print-plan` 不受平台闸门限制

{
  /*
   * macOS 引导里让用户先跑 `--print-plan` 看有没有 wheel —— 如果那条命令在 macOS 上
   * 因为平台闸门直接退出 2，文档就给了一条跑不通的指令（而且看起来"照做了却什么都没发生"）。
   */
  const mac = printPlan({ MIAO_PLATFORM: 'darwin-arm64', MIAO_WHEELS_MANIFEST: path.join(tmp, 'empty.json') });
  check('WB.W9 「非 Windows 就拒绝」的闸门**不覆盖** `--print-plan`：接缝设成 darwin-arm64 时它仍能打印计划',
    mac.code === 0 && mac.platform === 'darwin-arm64' && mac.route === 'source',
    { code: mac.code, platform: mac.platform, reason: mac.reason });

  // 反过来：默认调用（不带 `--print-plan`）在非 Windows 下**必须**仍被闸门拦下（D7 验收②）
  const refused = spawnSync(process.execPath, [DEPS_MJS], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, MIAO_PLATFORM: 'darwin-arm64' },
  });
  check('WB.W9b 同一接缝下**默认调用**仍被平台闸门拒绝（exit 2 + PLATFORM_UNSUPPORTED）—— 旁路只给只读的 `--print-plan`',
    refused.status === 2 && /PLATFORM_UNSUPPORTED/.test(`${refused.stdout}${refused.stderr}`),
    { code: refused.status });
}

// ------------------------------------------------------------------ WB.W7 文档

{
  const win = fs.readFileSync(GUIDE_WIN, 'utf8');
  const mac = fs.readFileSync(GUIDE_MAC, 'utf8');
  check('WB.W7 两份安装引导都把"预编译 wheel 通道 / 没有编译器也能装"写出来了（否则用户永远只知道要装 MSVC / Xcode CLT）',
    /wheel/i.test(win) && /wheel/i.test(mac) && /wheels\.manifest\.json/.test(win) && /wheels\.manifest\.json/.test(mac),
    { winHasWheel: /wheel/i.test(win), macHasWheel: /wheel/i.test(mac) });
}

// ------------------------------------------------------------------ WB.W8 单源

{
  const src = fs.readFileSync(DEPS_MJS, 'utf8');
  const planCalls = (src.match(/planCrf\(\)/g) ?? []).length;
  // `--print-plan` 与批 B 各调一次；再少就说明有一处自己另判了一遍
  check('WB.W8 `--print-plan` 与批 B **共用** `planCrf()`（>= 2 处调用），没有第二份"平台匹配 + 哈希比对"的实现',
    planCalls >= 2 && !/(w\.platform === key)/.test(src.replace(/function planCrf[\s\S]*?\n}/, '')),
    { planCalls });
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  function mutate(from, to) {
    const text = MJS_ORIGINAL.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：\n  ${from.slice(0, 90)}`);
    fs.writeFileSync(DEPS_MJS, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(DEPS_MJS, MJS_ORIGINAL);
  }

  const runForward = () => {
    const r = spawnSync(process.execPath, [SELF], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) => out.split('\n').filter((l) => l.trimStart().startsWith('✗')).map((l) => l.trim().slice(0, 44));

  const HASH_GUARD = 'if (got !== w.sha256) {';
  const PLATFORM_FILTER = 'w.platform === key && w.pythonTag === tag';
  const HIT_RETURN = "return { route: 'wheel', reason: `命中清单条目";

  // ---- MB1：不比对哈希（"清单里写了就信"）----
  {
    const restore = mutate(HASH_GUARD, 'if (false) {');
    const r = runForward();
    check('MB1 去掉 sha256 比对（"清单里写了就信"）⇒ WB.W4 红', r.code !== 0 && hasRed(r.out, 'WB.W4'),
      { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // ---- MB2：不过滤平台/ABI（跨平台装错 wheel）----
  {
    const restore = mutate(PLATFORM_FILTER, 'true');
    const r = runForward();
    check('MB2 去掉平台/ABI 过滤 ⇒ WB.W6 红（Windows 上会去装 macOS 的 wheel）',
      r.code !== 0 && hasRed(r.out, 'WB.W6'), { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // ---- MB3：命中也不走 wheel（便利通道形同虚设）----
  {
    const restore = mutate(HIT_RETURN, "return { route: 'source', reason: `命中清单条目");
    const r = runForward();
    check('MB3 命中条目也返回 `source` ⇒ WB.W3 红（wheel 通道形同虚设，等于没做）',
      r.code !== 0 && hasRed(r.out, 'WB.W3'), { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  check('R1 变异收尾：`install-engine-deps.mjs` 按字节还原', MJS_ORIGINAL.equals(fs.readFileSync(DEPS_MJS)), null);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
