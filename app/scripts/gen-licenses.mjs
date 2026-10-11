#!/usr/bin/env node
/**
 * 生成第三方许可清单 → `app/src/generated/licenses.json`（台账 D-84）。
 *
 * 跑法：`npm run gen:licenses`
 *
 * ## 这个脚本**只做枚举**，不做核准
 *
 * 它读出来的每一条，都是**那个包自己声明的许可**（npm 的 `package.json#license`、
 * cargo registry 里 crate 的 `Cargo.toml#license`）。它**不判断**这些声明是否真实、
 * 是否与项目自己的分发方式相容 —— 那是人工复核的事（GPL 边界见台账 D-21）。
 * 所以清单顶部必须带 `disclaimer`，界面上也必须写出来。
 * **凭记忆列许可**是被明令禁止的（`catalog.ts` 的 `licenses.why` 里写着），
 * 本脚本的意义正在于把"许可"这件事变成"从文件里读出来的字段"。
 *
 * ## 为什么 Rust 侧会凑不齐（这是环境事实，不是脚本缺陷）
 *
 * `Cargo.lock` **不含 license 字段** —— 它只有 name / version / source / checksum。
 * license 要去每个 crate 解包后的 `Cargo.toml` 里读，而那些目录来自本地 registry 缓存
 * （`~/.cargo/registry/src/*`），**只有构建过的 crate 才会在**。
 * 本机实测：lock 里 517 个 crate，registry 里能对上 345 个。
 *
 * 曾经想用 `cargo metadata --format-version 1` 取全量，但它在离线状态下会因
 * 需要下载其它目标平台专属的 crate（如 `android_system_properties`）而失败。
 * 所以脚本**如实标注覆盖率**（`total` / `withLicense`），取不到的写 `license: null`，
 * 而不是把它们悄悄从清单里删掉 —— 删掉之后，"缺 172 个"这件事在界面上就消失了。
 *
 * ## 过期检测
 *
 * 清单是**生成物**：`npm install` 之后依赖变了、而没重跑本脚本，清单就会过期。
 * 脚本把来源文件的规模写进 `inputs`，`e2e/settings-media-check.mjs` 会重算一遍做对账
 * （不一致即红，提示重跑）。这是"生成物不会静默过期"的唯一机制。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');

const PKG_LOCK = path.join(APP, 'package-lock.json');
const CARGO_LOCK = path.join(APP, 'src-tauri', 'Cargo.lock');
const OUT = path.join(APP, 'src', 'generated', 'licenses.json');

/** 许可字段归一：npm 允许 `license: "MIT"` 或老式的 `licenses: [{type:"MIT"}]` */
function normNpmLicense(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return null;
}

/** 读 npm 侧：集合来自 lockfile（可判 dev），许可字段来自实际安装的 package.json */
function readNpm() {
  const lock = JSON.parse(readFileSync(PKG_LOCK, 'utf8'));
  const pkgs = [];
  let skippedDev = 0;
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue; // 跳过根包与自己
    if (meta.dev === true || meta.link === true) {
      skippedDev++;
      continue;
    }
    const manifest = path.join(APP, key, 'package.json');
    let license = null;
    if (existsSync(manifest)) {
      try {
        license = normNpmLicense(JSON.parse(readFileSync(manifest, 'utf8')));
      } catch {
        license = null;
      }
    }
    pkgs.push({
      name: meta.name ?? key.replace(/^.*node_modules\//, ''),
      version: meta.version ?? '',
      license,
    });
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name));
  return { pkgs, skippedDev, total: pkgs.length };
}

/** 读 cargo registry 里已解包的 crate → Map<'name-version', dir> */
function registryIndex() {
  const base = path.join(homedir(), '.cargo', 'registry', 'src');
  const dirs = existsSync(base)
    ? readdirSync(base).map((d) => path.join(base, d)).filter((d) => existsSync(d))
    : [];
  const index = new Map();
  for (const d of dirs) {
    for (const name of readdirSync(d)) index.set(name, path.join(d, name));
  }
  return index;
}

/** Cargo.lock → 第三方 crate（`source` 为空的是本仓自己的包，不计） */
function readRust() {
  const lock = readFileSync(CARGO_LOCK, 'utf8');
  const index = registryIndex();
  const pkgs = [];
  for (const block of lock.split('[[package]]').slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^\s*source\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    if (!name || !source) continue; // 本地 path 依赖不算第三方
    const dir = index.get(`${name}-${version}`);
    let license = null;
    if (dir) {
      const toml = path.join(dir, 'Cargo.toml');
      if (existsSync(toml)) {
        license = readFileSync(toml, 'utf8').match(/^\s*license\s*=\s*"([^"]+)"/m)?.[1]?.trim() ?? null;
      }
    }
    pkgs.push({ name, version, license });
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name));
  return { pkgs, total: pkgs.length };
}

/** 按许可字符串聚合（`null` 单列成"未取到"，因为它不是一种许可） */
function summarize(pkgs) {
  const byLicense = {};
  let unknown = 0;
  for (const p of pkgs) {
    if (!p.license) {
      unknown++;
      continue;
    }
    byLicense[p.license] = (byLicense[p.license] ?? 0) + 1;
  }
  // 计数降序；同数按名称升序 —— 让输出稳定（否则每次生成的文件都不同）
  const sorted = Object.fromEntries(
    Object.entries(byLicense).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
  return { byLicense: sorted, unknown, withLicense: pkgs.length - unknown };
}

const npm = readNpm();
const rust = readRust();

const data = {
  generatedAt: new Date().toISOString(),
  /**
   * ⚠️ 界面与文档都必须把这句话带出去 —— 清单是"包自己说的"，不是"我们核准过的"。
   */
  disclaimer:
    '以下是各依赖**自己声明**的许可，由 package-lock.json / Cargo.lock 与本地包元数据枚举得出，',
  sources: {
    npm: 'app/package-lock.json + app/node_modules/**/package.json（不含 devDependencies）',
    rust: 'app/src-tauri/Cargo.lock + ~/.cargo/registry/src/**/Cargo.toml',
  },
  /** 供门槛脚本对账：来源文件的规模（依赖变了而没重跑本脚本 ⇒ 不一致 ⇒ 红） */
  inputs: {
    npmProdPackages: npm.total,
    npmSkippedDev: npm.skippedDev,
    rustLockCrates: rust.total,
  },
  npm: { total: npm.total, ...summarize(npm.pkgs), packages: npm.pkgs },
  rust: { total: rust.total, ...summarize(rust.pkgs), packages: rust.pkgs },
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data), 'utf8');

console.log(`✓ ${path.relative(ROOT, OUT)}`);
console.log(
  `  npm  生产依赖 ${npm.total} 个（跳过 devDependencies ${npm.skippedDev} 个）· 有声明 ${data.npm.withLicense} 个`,
);
console.log(
  `  rust Cargo.lock ${rust.total} 个第三方 crate · 本机取到声明 ${data.rust.withLicense} 个（缺 ${data.rust.unknown} 个）`,
);
