#!/usr/bin/env node
/**
 * E1 · 「macOS 签名 + 公证」钉子 —— 别产出"装得上、跑不起来"的包
 * =============================================================================
 * 对应计划文档 E1：`Contents/` 内所有可执行逐个签名 + hardened runtime + entitlements，
 * 写进构建脚本。真机验收两条：① 从下载的 dmg 安装后引擎能起；② `codesign --verify --deep
 * --strict` 通过。
 *
 * ## 🔴 落点已经变了（必须记账，别照抄计划原文）
 * E1 写于 **F5 / B1 之前**：那时引擎运行时（Python / `llama-server`）还打算随包放进
 * `Contents/`。现在它们由用户自己装到 `~/Library/Application Support/runtimes/manga-translator/`
 * —— **包内已经几乎没有可执行对象**（只剩 app 自己）。所以：
 *   · "对 `Contents/` 内所有可执行逐个签名"这一条**没有对象了**；
 *   · 但多出来一条**新的、更难的**：父进程带 hardened runtime 时，能不能拉起
 *     **用户自己装的、未签名的** python / llama-server？这条只能真机回答。
 * 两条都**不在**本脚本的能力范围内，如实记在 `unverified` 里（W6）。
 *
 * ## 本脚本钉的是"打包前必须成立的事"（都可跨平台验）
 *   W1 entitlements 四项**且都为 true**（少一条的症状都是"引擎起不来"）
 *   W2 tauri.conf 接线（hardenedRuntime + entitlements 指向真实文件）
 *   W3 打包前自检在**缺变量**时非零退出并逐项点名（这个沉默很贵：缺公证三件套时
 *      tauri 会**跳过**公证而不是报错 ⇒ 包装得上、跑不起来）
 *   W4 `MIAO_NOTARIZE=0`（本机自用）⇒ 放行但**告警"不得对外分发"**
 *   W5 变量齐 ⇒ 放行
 *   W6 `unverified` 记账在位
 *   W7 `package.json` 注册了 `sign:preflight`，且 `app:build:mac` 串上了它（"写进构建脚本"）
 *
 * ## 反证轮（--refute）
 *   M1 entitlements 少一条 ⇒ W1 红；M2 conf 摘掉 entitlements ⇒ W2 红；
 *   M3 自检恒通过（`if (false)`）⇒ W3 红；M4 构建脚本不再串自检 ⇒ W7 红。
 *
 * 用法：node e2e/service/macos-signing-check.mjs [--refute]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const CONF = path.join(ROOT, 'app', 'src-tauri', 'tauri.conf.json');
const PLIST = path.join(ROOT, 'app', 'src-tauri', 'entitlements.plist');
const PREFLIGHT = path.join(ROOT, 'app', 'scripts', 'mac-signing-preflight.mjs');
const PKG = path.join(ROOT, 'package.json');
const SPEC_NOTES = path.join(ROOT, 'docs', 'spec-notes-1.md');
const CONF_ORIGINAL = fs.readFileSync(CONF);
const PLIST_ORIGINAL = fs.readFileSync(PLIST);

const REQUIRED = [
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-dyld-environment-variables',
];

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

/** 跑打包前自检（显式清空 APPLE_*，否则本机偶然设了它们会让断言不确定）。 */
function runPreflight(extraEnv = {}) {
  const env = {
    ...process.env,
    APPLE_SIGNING_IDENTITY: '',
    APPLE_ID: '',
    APPLE_PASSWORD: '',
    APPLE_TEAM_ID: '',
    ...extraEnv,
  };
  for (const k of ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!(k in extraEnv)) env[k] = '';
  }
  if (!('MIAO_NOTARIZE' in extraEnv)) delete env.MIAO_NOTARIZE;
  const r = spawnSync(process.execPath, [PREFLIGHT], { cwd: ROOT, encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ------------------------------------------------------------------ W1 entitlements

{
  const text = fs.readFileSync(PLIST, 'utf8');
  const missing = REQUIRED.filter(
    (k) => !new RegExp(`<key>\\s*${k.replace(/\./g, '\\.')}\\s*</key>\\s*<true\\s*/>`).test(text),
  );
  check(
    'W1 entitlements 四项必备且**都为 true**（缺任一条的症状都是"引擎起不来"，与缺 entitlement 看不出关系）',
    missing.length === 0,
    { missing },
  );
  /*
   * ⚠️ 判据必须是「**键存在**」，不是「文件里出现过这个词」：
   * entitlements 的 doc 注释里正讨论着"刻意不加 app-sandbox"，拿裸词当判据会恒红
   * （同 `W10 绝不碰作品目录` 那次踩到的坑：判据只看代码，不看注释）。
   */
  check(
    'W1b entitlements **不含** app-sandbox 键（加了它，"拉起用户自装的外部可执行"整条路被堵死）',
    !/<key>\s*com\.apple\.security\.app-sandbox\s*<\/key>/.test(text),
    null,
  );
}

// ------------------------------------------------------------------ W2 配置接线

{
  const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
  const mac = conf?.bundle?.macOS ?? {};
  const ent = mac.entitlements ? path.resolve(path.dirname(CONF), mac.entitlements) : null;
  check(
    'W2 tauri.conf 的 `bundle.macOS` 接线到位：hardenedRuntime=true 且 entitlements 指向真实存在的文件',
    mac.hardenedRuntime === true && !!ent && fs.existsSync(ent),
    { hardenedRuntime: mac.hardenedRuntime, entitlements: mac.entitlements, exists: ent ? fs.existsSync(ent) : false },
  );
}

// ------------------------------------------------------------------ W3/W4/W5 打包前自检的三种形态

{
  const r = runPreflight();
  const names = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  check(
    'W3 缺变量时**非零退出**，且把缺的那几个逐个点名（缺公证三件套时 tauri 会跳过公证而不是报错）',
    r.code === 1 && names.every((n) => r.out.includes(n)),
    { code: r.code, out: r.out.slice(0, 300) },
  );
}

{
  const r = runPreflight({ MIAO_NOTARIZE: '0' });
  check(
    'W4 `MIAO_NOTARIZE=0`（本机自用打包）⇒ 放行，但**必须告警"不得对外分发"**（不能悄悄放行）',
    r.code === 0 && /不得对外分发/.test(r.out),
    { code: r.code, out: r.out.slice(0, 300) },
  );
}

{
  const r = runPreflight({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
    APPLE_ID: 'dev@example.invalid',
    APPLE_PASSWORD: 'app-specific-password',
    APPLE_TEAM_ID: 'TEAM123456',
  });
  check('W5 变量齐 ⇒ 放行，且**不再**提"本次不公证"', r.code === 0 && !/本次不公证/.test(r.out), {
    code: r.code,
    out: r.out.slice(0, 300),
  });
}

// ------------------------------------------------------------------ W7 写进构建脚本

{
  const scripts = JSON.parse(fs.readFileSync(PKG, 'utf8')).scripts ?? {};
  check(
    'W7 `sign:preflight` 已注册，且 `app:build:mac` **串上了它**（"写进构建脚本"= 打包路径上真的会跑）',
    /mac-signing-preflight\.mjs/.test(scripts['sign:preflight'] ?? '') &&
      /sign:preflight/.test(scripts['app:build:mac'] ?? ''),
    { sign_preflight: scripts['sign:preflight'], app_build_mac: scripts['app:build:mac'] },
  );
}

// ------------------------------------------------------------------ W6 unverified 记账

{
  const notes = fs.existsSync(SPEC_NOTES) ? fs.readFileSync(SPEC_NOTES, 'utf8') : '';
  /*
   * ⚠️ 「E1」与「unverified」各自出现在文件不同角落**不算**记账：那份台账里两者本来就都有。
   *    判据要求它们**在同一段**（400 字内）共现 —— 那才说明"E1 这条被标成未验"。
   */
  check(
    'W6 真机签名/公证**未验**这件事被如实记账（`unverified` 与 `E1` 在同一段共现），不许静默计入"已验"',
    /E1[\s\S]{0,400}unverified|unverified[\s\S]{0,400}E1/.test(notes),
    null,
  );
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改文件 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  function mutateFile(file, from, to) {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：${file}\n  ${from.slice(0, 80)}`);
    fs.writeFileSync(file, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(file, original);
  }

  const runForward = () => {
    const r = spawnSync(process.execPath, [SELF], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) =>
    out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('✗'))
      .map((l) => l.trim().slice(0, 44));

  const KEEP_JIT = '<key>com.apple.security.cs.allow-jit</key>';
  const CONF_ENT = '"entitlements": "entitlements.plist"';
  const PREFLIGHT_GATE = 'if (problems.length) {';

  // ---- M1：少一条 entitlement（而且只看"键在不在"是抓不到的：把 true 改成 false）----
  {
    const restore = mutateFile(PLIST, `${KEEP_JIT}\n  <true/>`, `${KEEP_JIT}\n  <false/>`);
    const r = runForward();
    check(
      'M1 把一条 entitlement 从 true 改成 false ⇒ W1 红（恒 true 的判据抓不到它）',
      r.code !== 0 && hasRed(r.out, 'W1'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- M2：conf 摘掉 entitlements ----
  {
    const restore = mutateFile(CONF, CONF_ENT, '"entitlementsOff": "entitlements.plist"');
    const r = runForward();
    check('M2 tauri.conf 的 entitlements 接线被摘掉 ⇒ W2 红', r.code !== 0 && hasRed(r.out, 'W2'), {
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
  }

  // ---- M3：自检恒通过（最危险的形态：看起来有自检，其实什么都不拦）----
  {
    const restore = mutateFile(PREFLIGHT, PREFLIGHT_GATE, 'if (false) {');
    const r = runForward();
    check(
      'M3 打包前自检恒通过（`if (false)`）⇒ W3 红 —— 一个不拦任何东西的自检比没有更坏',
      r.code !== 0 && hasRed(r.out, 'W3'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- M4：构建脚本不再串自检 ----
  {
    const restore = mutateFile(
      PKG,
      'npm run sign:preflight && npm --prefix app run tauri build',
      'npm --prefix app run tauri build',
    );
    const r = runForward();
    check(
      'M4 `app:build:mac` 不再跑自检 ⇒ W7 红（自检存在但打包路径上不会执行）',
      r.code !== 0 && hasRed(r.out, 'W7'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  check(
    'R1 变异收尾：四个文件按字节还原',
    CONF_ORIGINAL.equals(fs.readFileSync(CONF)) && PLIST_ORIGINAL.equals(fs.readFileSync(PLIST)),
    null,
  );
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
