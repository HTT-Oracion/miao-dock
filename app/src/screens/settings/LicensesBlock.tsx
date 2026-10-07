import { useState } from 'react';
import raw from '@/generated/licenses.json';
import type { SettingItem } from '@screens/settings/catalog';

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
  sources: { npm: string; rust: string };
  inputs: { npmProdPackages: number; npmSkippedDev: number; rustLockCrates: number };
  npm: LicenseScope;
  rust: LicenseScope;
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

  return (
    <div className="set-lic">
      <div className="set-lic-head">
        <div className="set-lic-name">{item.label}</div>
        <button
          type="button"
          className="set-lic-fold"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起清单' : '查看清单'}
        </button>
      </div>

      <div className="set-lic-scopes">
        <Scope name="npm 运行依赖" s={DATA.npm} />
        <Scope name="Rust crate" s={DATA.rust} />
      </div>

      {/*
        免责声明用 `notice`（与设置页其它提示同一形状），不用行内小字 ——
        它说的是"这份清单的效力边界"，重要性高于一条脚注。
      */}
      <div className="notice set-lic-note">{DATA.disclaimer}</div>

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
              <span className={p.license ? 'set-lic-val' : 'set-lic-val is-unknown'}>
                {p.license ?? '未取到声明'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
