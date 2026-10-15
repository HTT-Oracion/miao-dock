/**
 * 命令清单的读取层 —— `e2eScripts.json`（数据）的唯一事实源。
 *
 * ## 为什么要有这个文件（而不是每个脚本各读一遍 JSON）
 * `package.json` 的 scripts 收束成三类入口后，「某个命令是否已注册」这件事从
 * *一处手写的 scripts 表* 变成了 *`e2eScripts.json` + `package.json` 两处*。
 * 多处读取 = 多处解析 = 迟早有一处解析口径不同（把 `node a.mjs --x` 的 args 拆错、
 * 或漏掉派生的 `:refute`）⇒ 断言得出**与事实不同的结论**。所以解析只在这里做一次。
 *
 * ## 术语
 *   · **基条目**：清单里显式写下的那些（static 16 / service 44 / nightly 9 / supply 6 / dev 3）。
 *   · **派生条目**：基条目上 `refute: true` ⇒ `<id>:refute`（命令行追加 `--refute`）。
 *     派生而非手写，与 `_check-registry.mjs` 的派生规则同源：漏写一条 `refute: true`
 *     会被 `check:registry` 的覆盖断言抓到，而不是"少了一条命令却全绿"。
 *   · **保留命令**（`KEPT_SCRIPTS`）：留在 `package.json` 里的三类入口，**写死并断言**。
 *
 * ## 🔴 解析口径（故意收窄，宽口径 = 假绿）
 * `cmd` 只接受 `node <相对路径> [args…]`。不做 shell、不接 `&&`、不认 `npx`。
 * 复杂的串接请写进 `package.json` 的聚合入口，不要让"这一条到底跑了什么"需要解释。
 *
 * ## 宽容度分工（改断言/改执行器的人请守住这条线）
 *   `expandManifest()`  **不抛异常**：清单写坏时它照原样返回并把问题记在 `bad` 上，
 *     好让断言**逐条报红**（抛栈会连带毁掉反证轮：变异必须打红"某一条断言"）。
 *   `commandIndex()`    **抛异常**：执行器（`run-script.mjs`）宁可不跑，也不按一份
 *     自相矛盾的清单去跑。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 仓库根（本文件在 `e2e/` 下） */
export const ROOT = path.resolve(import.meta.dirname, '..');
export const MANIFEST_PATH = path.join(ROOT, 'e2eScripts.json');

/** 清单的分组：前三个是**分层门**（与 `_check-registry.mjs` 的 tier 同名同义），`refute` 是派生的，后两个不是分层门。 */
export const TIER_GROUPS = ['static', 'service', 'nightly'];
export const NON_TIER_GROUPS = ['supply', 'dev'];
export const GROUP_ORDER = [...TIER_GROUPS, 'refute', ...NON_TIER_GROUPS];

/**
 * **在注册表里有对应项**的那些分组（= 分层门 + 派生反证轮）。
 * 🔴 覆盖断言必须用这个而不是 `TIER_GROUPS`：反证轮的条目 group 是 `refute`，
 *    拿 `TIER_GROUPS` 去滤会把 58 条派生条目**整批漏掉** —— 而它们恰恰是最容易
 *    "注册表里有、清单里没有"的那一半（`check:docpaths:refute` 就是这么漏的）。
 */
export const CHECK_GROUPS = [...TIER_GROUPS, 'refute'];

/**
 * `package.json` 里**只允许**存在这些命令（三类入口）。写死的分母：
 * 把一条 check 加回 `package.json`、或漏搬一条，都由 `check:registry` 的 `PKG.kept` 打红。
 */
export const KEPT_SCRIPTS = [
  // ① 代码校验
  'prepare',
  'lint',
  'lint:fix',
  'format',
  'format:check',
  // ② app 启停与打包
  'app',
  'app:build',
  'app:build:mac',
  // ③ 测试 / 检查入口（分层聚合入口 + 清单派发入口）
  'check',
  'check:full',
  'check:nightly',
  'check:changed',
  'selftest',
  'test',
  'task',
];

/** 派发入口在 `package.json` 里的名字（`npm run task -- <id>`） */
export const DISPATCH_SCRIPT = 'task';

/** 读原始清单；连 JSON 都读不出来时抛错（此时任何断言都没有意义） */
export function loadManifest(file = MANIFEST_PATH) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`e2eScripts.json 不是合法 JSON：${e.message}`);
  }
}

/** `node <script> [args…]` → `{ script, args }`；别的形态返回 null（调用方据此报红） */
export function parseCmd(cmd) {
  if (typeof cmd !== 'string') return null;
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] !== 'node') return null;
  if (!parts[1] || parts[1].startsWith('-')) return null;
  return { script: parts[1], args: parts.slice(2) };
}

/** 清单里的脚本路径在仓库里真的存在 */
export const scriptExists = (script) => fs.existsSync(path.join(ROOT, script));

/** (script, args) 是清单 ↔ 注册表的**连接键** —— 两侧的 id 命名可以不统一，但跑的东西必须同一个 */
export const keyOf = (e) => `${e.script}|${(e.args ?? []).join(' ')}`;

/**
 * 展开清单：基条目 + 派生反证轮，按 `groups` 的书写顺序返回。
 * **不抛异常**（见文件头的"宽容度分工"）。
 *
 * 条目字段：`{ id, group, cmd, desc, refute, derived, script, args, bad }`
 *   `bad` 非空 = 这一条本身不合法（cmd 形态非法 / 指向的脚本不在盘上 / 分组未知）。
 */
export function expandManifest(raw) {
  const list = [];
  const groups = raw && typeof raw.groups === 'object' && raw.groups !== null ? raw.groups : {};
  for (const group of Object.keys(groups)) {
    const g = groups[group] ?? {};
    for (const e of g.cmds ?? []) {
      list.push(makeEntry(e, group, null));
      if (e.refute) {
        // 派生：`<id>:refute`，命令行追加 `--refute`
        list.push(
          makeEntry(
            { id: `${e.id}:refute`, cmd: `${e.cmd} --refute`, desc: `${e.desc ?? ''}（反证轮）` },
            'refute',
            e.id,
          ),
        );
      }
    }
  }
  return list;
}

function makeEntry(e, group, baseId) {
  const parsed = parseCmd(e.cmd);
  const problems = [];
  if (!GROUP_ORDER.includes(group)) problems.push(`未知分组 ${group}`);
  if (parsed && !scriptExists(parsed.script)) problems.push(`脚本不存在：${parsed.script}`);
  if (!parsed) problems.push(`cmd 不是 node 形态：${e.cmd}`);
  return {
    id: e.id,
    group,
    cmd: e.cmd,
    desc: e.desc ?? '',
    refute: !!e.refute,
    derived: baseId,
    script: parsed?.script ?? null,
    args: parsed?.args ?? [],
    bad: problems.length ? problems.join('；') : null,
  };
}

/** 读文件 + 展开（断言层用） */
export const buildCommands = (file = MANIFEST_PATH) => expandManifest(loadManifest(file));

/** `id → 条目`（含派生的）—— 执行器用，**清单自相矛盾时抛错**（宁可不跑） */
export function commandIndex(file = MANIFEST_PATH) {
  const list = buildCommands(file);
  const map = new Map();
  for (const c of list) {
    if (map.has(c.id)) throw new Error(`e2eScripts.json 里 id 重复：${c.id}`);
    if (c.bad) throw new Error(`e2eScripts.json 的条目本身不合法：${c.id} —— ${c.bad}`);
    map.set(c.id, c);
  }
  return map;
}

/**
 * 「这个命令存在吗」的**合并视图**：`package.json` 的 scripts ∪ 清单的 id → cmd。
 *
 * 🔴 用途仅限**注册类**断言（例：`gen:licenses` 有没有地方注册着）。
 *    它**不能**用来判文档里的 `npm run X` 能不能跑 —— 那条只能单独看 `pkg.scripts`：
 *    合并视图会把「`npm run check:units` 早就不存在了」判成存在，正是最坏的那种假绿。
 */
export function mergedScripts(pkgScripts, file = MANIFEST_PATH) {
  const merged = { ...pkgScripts };
  for (const c of buildCommands(file)) merged[c.id] = c.cmd;
  return merged;
}

/** 文档里写的 `npm run X` 真的能跑吗（只认 `package.json`；`task -- <id>` 派发形态另判） */
export const dispatchable = (pkgScripts, name) => Object.prototype.hasOwnProperty.call(pkgScripts, name);
