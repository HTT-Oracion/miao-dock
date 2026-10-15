#!/usr/bin/env node
/**
 * macOS 签名 / 公证**打包前自检**（E1）
 * =============================================================================
 * 跑法：`npm run task -- sign:preflight`
 *
 * ## 为什么要有这一步（它防的是一个很贵的"沉默"）
 * 签名与公证的失败方式全都**不显眼**：
 *   · 没设 `APPLE_SIGNING_IDENTITY` ⇒ tauri 出一个**ad-hoc 签名**的包。装到别人机器上
 *     会被 Gatekeeper 拦住，而我们这边一切正常 —— 因为本机不校验自己签的东西。
 *   · 证书/描述文件过期 ⇒ 打包**成功**、分发时才炸。
 *   · 公证缺 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 三件套里任意一件 ⇒
 *     tauri 会**跳过**公证（不是报错），产出一个"签名了但没公证"的包 ——
 *     它装得上、跑不起来（Gatekeeper 拦未公证的下载件）。
 * 所以这里把"打包前必须成立的事"逐项点名，**缺任何一项就非零退出**。
 *
 * ## 不在这里做的事（刻意）
 * 不做证书校验（`security find-identity` 只有 macOS 有，本仓在 Windows 上开发 ——
 * 一条只在某平台跑得起来的自检会让另一平台的人以为自己验过了）。
 * 只检查**跨平台可判定的事实**：配置文件是否就位、entitlements 是否合法、
 * 环境变量是否齐（后者可以显式声明"本次不公证"，`MIAO_NOTARIZE=0`）。
 *
 * ## 环境变量（与 tauri 的约定一致）
 *   APPLE_SIGNING_IDENTITY  "Developer ID Application: …"（不设 ⇒ 只能 ad-hoc，会被拦出）
 *   APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   公证三件套
 *   MIAO_NOTARIZE=0         显式声明"这次不公证"（本机自用打包）⇒ 只告警，不失败
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const CONF = path.join(APP, 'src-tauri', 'tauri.conf.json');

/** entitlements 里必须有的四条 —— 缺哪条的症状都是"引擎起不来"，与缺 entitlement 看不出关系。 */
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-dyld-environment-variables',
];

const problems = [];
const warnings = [];

const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
const mac = conf?.bundle?.macOS ?? {};
if (mac.hardenedRuntime !== true) {
  problems.push('tauri.conf.json 的 `bundle.macOS.hardenedRuntime` 不是 true（公证要求 hardened runtime）');
}
if (!mac.entitlements) {
  problems.push('tauri.conf.json 的 `bundle.macOS.entitlements` 没指向 entitlements.plist');
} else {
  const p = path.resolve(path.dirname(CONF), mac.entitlements);
  if (!fs.existsSync(p)) {
    problems.push(`entitlements 文件不存在：${p}`);
  } else {
    const text = fs.readFileSync(p, 'utf8');
    for (const key of REQUIRED_ENTITLEMENTS) {
      // 判据是「key 出现且紧跟 true」——只判出现的话，把 true 改成 false 也不会被发现
      const re = new RegExp(`<key>\\s*${key.replace(/\./g, '\\.')}\\s*</key>\\s*<true\\s*/>`);
      if (!re.test(text)) problems.push(`entitlements 缺少（或不是 true）：${key}`);
    }
    /*
     * ⚠️ 判据必须是「**键存在**」，不是「文件里出现过这个词」：那个 plist 的注释里正讨论着
     * "刻意不加 app-sandbox"，拿裸词当判据会让自检**永远失败**（而这类"自检恒红"最终
     * 会被人用 `|| true` 绕过 —— 比没有自检更坏）。
     */
    if (/<key>\s*com\.apple\.security\.app-sandbox\s*<\/key>/.test(text)) {
      problems.push('entitlements 里出现了 app-sandbox 键 —— 它会把"拉起用户自装的外部可执行"整条路堵死');
    }
  }
}

const notarize = (process.env.MIAO_NOTARIZE ?? '1') !== '0';
const env = {
  APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY,
  APPLE_ID: process.env.APPLE_ID,
  APPLE_PASSWORD: process.env.APPLE_PASSWORD,
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
};
const missing = Object.entries(env)
  .filter(([, v]) => !String(v ?? '').trim())
  .map(([k]) => k);
if (missing.length) {
  if (notarize) {
    problems.push(
      `缺签名/公证所需的变量：${missing.join('、')} —— ` +
        '缺 APPLE_SIGNING_IDENTITY 会产出 ad-hoc 签名的包（本机不报错、别人机器上被拦）；' +
        '缺公证三件套时 tauri 会**跳过**公证而不是报错 ⇒ 包装得上、跑不起来。' +
        '本机自用打包请显式设 MIAO_NOTARIZE=0。',
    );
  } else {
    warnings.push(`MIAO_NOTARIZE=0：本次不公证，缺 ${missing.join('、')} —— 产物只能本机自用，不得对外分发`);
  }
}

for (const w of warnings) console.log(`⚠ ${w}`);
if (problems.length) {
  console.error('✗ 打包前自检未通过：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(
  `✓ 打包前自检通过（hardenedRuntime + entitlements 四项就位${notarize ? '，签名/公证变量齐' : '，本次不公证'}）`,
);
