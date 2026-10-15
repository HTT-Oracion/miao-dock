import { useState } from 'react';
import raw from '@/generated/licenses.json';
import type { SettingItem } from '@screens/settings/catalog';
import { Notice } from '@components/units';

/**
 * 设置页 ⑤ 关于 ·「第三方许可」项的块（台账 D-84）。
 *
 * ## 数据从哪来、以及它**不是**什么
 *
 * `app/src/generated/licenses.json` 由 `npm run gen:licenses` 从
 * `package-lock.json`、`node_modules` 下各级 `package.json`、`Cargo.lock`、
 * `~/.cargo/registry` 下各级 `Cargo.toml` 枚举得出（脚本见 `app/scripts/gen-licenses.mjs`）。
 *
 * ⚠️ 写注释时别把 `星号 斜杠` 连着写（例如 glob 里的 `任意目录` 通配）——
 * 那会**提前结束本段块注释**，后面的正文就地变成代码。这里刻意用中文描述代替 glob。
 *
 * 🔴 每一行都是**那个包自己声明的**许可 —— 不是我们核准过的结论。
 * 所以免责声明（`disclaimer`）**必须显示**，不能只写"第三方许可"四个字了事：
 * 前者是"事实陈列"，后者读起来像"我们查过了、没问题"。
 *
 * ## 为什么把"凑不齐"也显示出来
 *
 * Rust 侧本机只能取到一部分 crate 的声明：`Cargo.lock` 本身**不含 license 字段**，
 * 要去本地 registry 里解包后的 `Cargo.toml` 读，而只有构建过的 crate 才会在。
 * 于是清单必然有缺口 —— 缺口**写在界面上**（"342 / 516"），而不是把取不到的那些
 * 悄悄删掉：删掉之后，"少了一部分"这件事就再也看不见了，而那正是最需要被看见的事。
 *
 * ## 为什么清单要"展开"才显示
 *
 * 五百多行铺开会把整组顶成一屏接一屏的清单，而用户来这一趟要的通常只是
 * 一个总数与大致构成。默认给聚合，展开给全量 —— 与「组说明折叠」同一条思路。
 */
interface LicensesFile {
  generatedAt: string;
  disclaimer: string;
  sources: { npm: string; rust: string; engine: string };
  inputs: { npmProdPackages: number; npmSkippedDev: number; rustLockCrates: number; engineAssets: number };
  npm: LicenseScope;
  rust: LicenseScope;
  engine: EngineLicenses;
}

interface LicensePkg {
  name: string;
  version: string;
  license: string | null;
}

interface LicenseScope {
  total: number;
  withLicense: number;
  unknown: number;
  byLicense: Record<string, number>;
  packages: LicensePkg[];
}

/** 引擎 / 模型资产的一条（C5）：许可逐条来自 `models.manifest.json`，随包与否来自打包配置。 */
interface EngineAsset {
  id: string;
  set: string | null;
  platform: string | null;
  sizeBytes: number | null;
  license: string | null;
  spdx: string | null;
  bundled: boolean;
}

interface EngineLicenses {
  assets: EngineAsset[];
  upstream: { key: string; license: string; spdx: string | null }[];
  total: number;
  withLicense: number;
  unknown: number;
  bySpdx: Record<string, number>;
  /** 🔴 C5 的正面陈述：随包分发物里的模型权重数（必须是 0）。 */
  bundledCount: number;
  engineCommit: string | null;
}

/** JSON 断言：不做 `as const` 级的字面量推断（五百多条的深推断只会拖慢 tsc） */
const DATA = raw as unknown as LicensesFile;

/** 聚合行：`MIT 49 · OFL-1.1 3 · …`，最多给 6 类，其余并入「其他 N 类」 */
function summarize(s: LicenseScope): string {
  const entries = Object.entries(s.byLicense);
  const head = entries.slice(0, 6).map(([k, v]) => `${k} ${v}`);
  const rest = entries.length - head.length;
  const parts = [...head];
  if (rest > 0) parts.push(`其他 ${rest} 类`);
  if (s.unknown > 0) parts.push(`未取到声明 ${s.unknown}`);
  return parts.join(' · ');
}

function Scope({ name, s }: { name: string; s: LicenseScope }) {
  return (
    <div className="set-lic-scope">
      <div className="set-lic-scope-head">
        <span className="set-lic-scope-name">{name}</span>
        <span className="set-lic-scope-num">
          {s.withLicense} / {s.total}
        </span>
      </div>
      <div className="set-lic-sum">{summarize(s)}</div>
    </div>
  );
}

export function LicensesBlock({ item }: { item: SettingItem }) {
  const [open, setOpen] = useState(false);

  /*
   * 引擎侧的「禁止商用」不是靠写死的字面量点名，而是**从 `bySpdx` 的键里筛**：
   * 许可串换成别的写法（SPDX 表达式的 `NC`）时，这里跟着变 ——
   * 写死一份"CC-BY-NC / CC BY-NC-SA"的名字，下次换档（nllb → m2m100，MIT）就会开始撒谎。
   */
  const ncScopes = Object.keys(DATA.engine.bySpdx).filter((k) => /(^|[-\s])NC([-\s]|$)/.test(k));

  return (
    <div className="set-lic">
      <div className="set-lic-head">
        <div className="set-lic-name">{item.label}</div>
        <button type="button" className="set-lic-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起清单' : '查看清单'}
        </button>
      </div>

      <div className="set-lic-scopes">
        <Scope name="npm 运行依赖" s={DATA.npm} />
        <Scope name="Rust crate" s={DATA.rust} />
        <Scope
          name="引擎与模型资产"
          s={{
            total: DATA.engine.total,
            withLicense: DATA.engine.withLicense,
            unknown: DATA.engine.unknown,
            byLicense: DATA.engine.bySpdx,
            packages: [],
          }}
        />
      </div>

      {/*
        引擎与模型那一段有一条**硬约束**：禁止商用（R13）。它不是脚注 ——
        对外分发前必须换成可商用档位，而这句话此前在界面上根本不存在。
      */}
      {ncScopes.length > 0 ? (
        <Notice className="set-lic-note is-bad">
          引擎与模型中有 {ncScopes.length} 类**禁止商用**许可（{ncScopes.join(' / ')}）：本机自用 /
          内测可以，对外分发前必须换档并出法务结论（见「分发许可结论」）。
        </Notice>
      ) : null}

      {/*
        免责声明用 `notice`（与设置页其它提示同一形状），不用行内小字 ——
        它说的是"这份清单的效力边界"，重要性高于一条脚注。
      */}
      <Notice className="set-lic-note">{DATA.disclaimer}</Notice>

      {open ? (
        <div className="set-lic-list">
          <div className="set-lic-list-head">
            生成于 {new Date(DATA.generatedAt).toLocaleString()}
            {DATA.rust.unknown > 0
              ? ` · Rust 侧有 ${DATA.rust.unknown} 个 crate 本机取不到声明（Cargo.lock 不含许可字段，需 registry 里已解包）`
              : ''}
          </div>
          {DATA.npm.packages.length > 0 ? (
            <>
              <div className="set-lic-list-title">npm（不含 devDependencies）</div>
              {DATA.npm.packages.map((p) => (
                <div className="set-lic-row" key={`npm:${p.name}`}>
                  <span className="set-lic-pkg">
                    {p.name}@{p.version}
                  </span>
                  <span className={p.license ? 'set-lic-val' : 'set-lic-val is-unknown'}>
                    {p.license ?? '未取到声明'}
                  </span>
                </div>
              ))}
            </>
          ) : null}
          <div className="set-lic-list-title">Rust（Cargo.lock 的第三方 crate）</div>
          {DATA.rust.packages.map((p) => (
            <div className="set-lic-row" key={`rust:${p.name}`}>
              <span className="set-lic-pkg">
                {p.name}@{p.version}
              </span>
              <span className={p.license ? 'set-lic-val' : 'set-lic-val is-unknown'}>{p.license ?? '未取到声明'}</span>
            </div>
          ))}
          <div className="set-lic-list-title">引擎上游与模型（版本锁的声明，逐条）</div>
          {DATA.engine.upstream.map((u) => (
            <div className="set-lic-row" key={`up:${u.key}`}>
              <span className="set-lic-pkg">{u.key}</span>
              <span className="set-lic-val">{u.spdx ?? u.license}</span>
            </div>
          ))}
          <div className="set-lic-list-title">
            引擎与模型资产（{DATA.engine.total} 条 · 随包分发 {DATA.engine.bundledCount} 条）
          </div>
          {DATA.engine.assets.map((a) => (
            <div className="set-lic-row" key={`eng:${a.id}`}>
              <span className="set-lic-pkg">
                {a.id}
                {a.platform ? ` [${a.platform}]` : ''}
                {a.bundled ? ' · 随包' : ''}
              </span>
              <span className={a.license ? 'set-lic-val' : 'set-lic-val is-unknown'}>
                {a.spdx ?? a.license ?? '未取到声明'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
