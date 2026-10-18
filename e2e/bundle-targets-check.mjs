#!/usr/bin/env node
/**
 * Windows 打包配置的**根因钉子** —— 且必须可反证
 * ================================================================
 * ## 为什么钉配置，而不是"打个包看看"
 *
 * 「Windows 不能打包」这条缺陷的成因**全在配置里**，而验证它的代价是**一次完整 release
 * 构建 + Tauri 下载 NSIS 工具链**（分钟级、且要联网）。把成因钉在配置上，改错立刻变红，
 * 不必每次都真打一次包。
 *
 * 钉的**不是风格**，是**成因**（每条对应一个真实机制）：
 *
 *   W1 `tauri.windows.conf.json` 存在且 `bundle.targets === ["nsis"]`。
 *      基座 `tauri.conf.json` 的 targets 是 `["app","dmg"]` —— **这两个都是 macOS 专有包型**，
 *      Windows 上没有任何可用包型 ⇒ `npm run app:build` 在 Windows 直接没有可产出的包。
 *      Windows 侧的修法见 W2。
 *
 *   W2 基座 `tauri.conf.json` 的 targets **仍是 `["app","dmg"]`**（不许被改成 `"all"` 或塞进 `nsis`）。
 *      「支持 Windows」**必须走平台分叉**（`tauri.windows.conf.json`，Tauri 按
 *      JSON Merge Patch 合并、**数组整体替换**），而不是改基座 —— 后者会连 macOS 的打包行为
 *      一起改掉，违反本仓 D-85「平台分叉一律只加分支（macOS 逐字节不变）」。
 *
 *   W3 基座 `bundle.icon` 含 `.ico`。
 *      Windows 打包要 `.ico`（macOS 用 `.icns`，Linux 用 `.png`）。三份图标缺一不可，
 *      缺了会在**打包阶段**报错而不是启动时。
 *
 *   W4 `tauri.windows.conf.json` 只放 Windows 特有的键，**不复制**基座里已有的键
 *      （`productName` / `identifier` / `icon` / `active` / `macOS`…）。
 *      平台配置一旦把基座的键也抄一份，同一事实就有了两处来源，必然漂移 ——
 *      例如基座换了图标而 windows 配置还指着旧文件。**注意**：允许新增 Windows 专有键
 *      （如 `bundle.windows.nsis`），本条只禁「复制基座已有键」。
 *
 *   W5 基座与 Windows 配置的 `bundle.resources` 里**没有** Node 服务（`service/`）与
 *      `node.zip` —— F5.8 的验收标准③。服务已全部由 Rust 提供（`check:routes` 的完成门
 *      证明转发数 = 0），往随包里再放一份 Node 就是「功能照常、e2e 全绿、但包里永久躺一份
 *      没人调的服务」——正是计划文档 R3 要防的那个形态。
 *      🔴 判据取**配置**而不是"文件在不在"：`vendor/node.zip` 从来就没有过（D-08），
 *      所以"文件不存在"是一条永远绿的空断言；真正会把它带进包里的**唯一途径**就是
 *      `bundle.resources` 里列了它。
 *
 *   W7 / W7b 随包里 **0 个模型权重**（C5 验收①）：
 *      W7  后缀黑名单（`.gguf` / `.safetensors` / `.ckpt` / …）；
 *      W7b 与 `engine/models.manifest.json` **逐条交叉** —— 清单是"哪些是资产"的权威，
 *          凡是清单里声明过的资产出现在随包里就是错的，无论它被改成什么名字。
 *      🔴 两条判据叠着用、且**都做过反证**：M8（塞 `sakura-*.gguf`）只打红 W7，
 *      M9（把清单里的权重改个后缀夹带进来）只打红 W7b —— 这说明两条各挡一类，
 *      少了任一条就会有一类漏网。
 *      🔴 W7b 里显式断言"清单解析成功且资产名非空"：清单读不到时交叉集合为空 ⇒
 *      判据**永远绿**（空断言），那比没有更坏。
 *
 *   W14 产品 Rust 源码里**不存在**指向 node 解释器的字面量（`"node"` / `'node'` / `node.exe`），
 *      除非它就在 `MIAO_NODE_EXEC`（① ② 的 mock 替身解释器）或 `MIAO_SERVICE_IMPL`
 *      （退役门，只做字符串比较、不派进程）的**上下文窗口**里 —— D-209 的源码级钉子。
 *      🔴 为什么不能只钉"配置里没有 node 载荷"（W5）：配置只描述**随包**有什么。真正会回归的
 *      形态是"代码里悄悄把 node 拉回来"（新增一处 `Command::new("node")`，或把退路从
 *      `resolve_mangasvc()` 退回 `service/src/server.mjs`）—— 那时包还是干净的，W5 全绿，
 *      而用户机上一重启就多一个 node 进程。W5 钉的是"**装进去了什么**"，
 *      W14 钉的是"**产品路径还会不会拉起 node**"，两条各挡一类。
 *      ⚠️ 判据必须**先剥 `#[cfg(test)]`**：测试夹具里写 `vec!["node", "x.mjs"]` 是正常的
 *      （`supervisor.rs` 的替身启动用例），不剥会把它算成产品路径 ⇒ 常红 ⇒ 断言迟早被注释掉。
 *      ⚠️ 判据取**字面量**而不是"有没有 spawn"：本仓的派生态是
 *      `LaunchSpec { cmd: vec![node_exec, …] }`（真正 fork 发生在 `supervisor.rs`，那里看不到
 *      "node"），钉 spawn 点会**一条都钉不住**。
 *
 * ## 反证轮（`--refute`）
 *   逐条把上面的写法**改回缺陷形态** → 对应断言**必须变红** → 按字节还原。
 *
 * ⚠️ 边界，别误读：本脚本证明的是**"打包配置被钉住了、且没被改基座污染"**，
 *   **不是**"`npm run app:build` 真的产出了 NSIS 安装包" —— 那条只能靠真跑一次 release 构建。
 *   （已手工真跑过一次：2026-10-08 带 MSVC 环境 release 构建，产出
 *   `target/release/bundle/nsis/喵坞_2.0.0_x64-setup.exe`；详见台账 D-93 §六。
 *   ⚠️ 那次构建还暴露出一个环境坑：**沙箱 shell 没设 `INCLUDE`/`LIB` 时 `ring` 编不过**
 *   （`cl.exe` 报 `C1034`，但诊断走 stdout、cargo 的 stderr 段是空的）—— 见 D-93 §四。）
 *
 * 用法：
 *   node e2e/bundle-targets-check.mjs            正向跑（期望全绿）
 *   node e2e/bundle-targets-check.mjs --refute   反证轮（破坏 → 变红 → 还原）
 *
 * 约束：纯 Node、零依赖、不起任何进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const WIN_CONF = path.join(ROOT, 'src-tauri', 'tauri.windows.conf.json');
/** NSIS 安装器钩子的历史落点 —— 2026-10-18 起已退役（安装器自带载荷自解包）。
 *  W8 要断言的就是「它不在、也没被重新接线」：留着接线等于同一件事有两套实现。 */
const NSIS_HOOKS = path.join(ROOT, 'installer', 'hooks.nsh');

const REFUTE = process.argv.includes('--refute');

const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => {
  try {
    return JSON.parse(read(f));
  } catch {
    return null;
  }
};
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/// 基座里**不该被 windows 配置复制**的键（复制 = 同一事实两处来源）。
/// ⚠️ **`targets` 刻意不在表里** —— 它正是平台配置**应该**覆盖的那个键
///   （基座 `["app","dmg"]` 是 macOS 专有包型，Windows 必须换成 `["nsis"]`）。
///   把它列进来会让本断言在**基线上就红**（自己写错、不是实现坏）。
const BASE_OWNED_KEYS = ['productName', 'identifier', 'version', 'icon', 'active', 'macOS', 'resources'];

/// 随包资源里**不该**出现的 Node 载荷（F5.8 验收标准③）。
/// 大小写不敏感地按子串判：`service/` 与 `service\` 两种写法都要挡住（配置里可能写成 Windows 路径）。
const NODE_PAYLOAD = ['service/', 'service\\', 'node.zip'];

/// 产品运行期**必需**的随包资产（A2）—— 必须与 Rust 侧 `paths::REQUIRED_ASSETS` 逐项一致。
/// 🔴 这里是**第二处事实源**（Rust 常量读不进 node），所以另有一道交叉验证：
///    `check:resources` 会拿 `mangasvc --check-assets` 报的必需资产与这里比对，
///    两边漂移就变红 —— 单一事实源做不到，就退而求其次让它**可观测地漂移**。
const REQUIRED_ASSETS = ['engine/models.manifest.json', 'engine/runtime.manifest.json', 'engine/patches.json'];

/// `bundle.resources` 的目录（src 相对它解析）。
const CONF_DIR = path.dirname(BASE_CONF);

/// 产品 Rust 源码根（W14 的扫描面）。
const RUST_SRC = path.join(ROOT, 'src-tauri', 'src');

/// 允许 node 字面量出现的**上下文标记**（见文件头 W14 条）。
const NODE_LITERAL_ALLOW = ['MIAO_NODE_EXEC', 'MIAO_SERVICE_IMPL'];
/// 上下文窗口半径（行）—— 取值要够宽到盖住"取解释器 → 拼 launch spec"的那几行。
const NODE_LITERAL_WINDOW = 8;

/// 某个目录下所有产品 `.rs`（递归；目录不在时返回空表，不抛 —— 让判据自己红）
function rustSourcesIn(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.rs')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/// 仓库里所有产品 `.rs`（不含 `target/`）。
function rustSources() {
  return rustSourcesIn(RUST_SRC);
}

/**
 * 取某个 `fn name(` 的**函数体**（含大括号，按配对切）。
 *
 * 为什么要切函数而不是整文件判：W10 的两条判据（"闸在删除之前"、"静默档不碰数据"）
 * 说的都是**某一段代码内部**的顺序与内容；整文件判的话，"静默档删数据"这种最危险的回归
 * 会被别处的正常调用盖住 ⇒ 判据恒绿。
 */
function sliceFn(src, name) {
  const at = src.indexOf(`fn ${name}(`);
  if (at < 0) return '';
  const brace = src.indexOf('{', at);
  if (brace < 0) return '';
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  return src.slice(brace);
}

/**
 * 剥掉被 `#[cfg(test)]` 卫住的**整个条目**（含大括号配对）。
 * 🔴 只删那一行不行：测试体留在文本里，W14 会被夹具常红 —— 而假红的终点是
 *    "这条断言被注释掉"，比没有更糟。
 * 括号配对是**启发式**（不认字符串/注释里的括号）：本仓的测试体里没有裸 `{`/`}`
 * 字符串，够用；真要误判，症状是**剥多**（W14 少扫几行）而不是剥少（假红）。
 */
function stripCfgTest(src) {
  let s = src;
  for (;;) {
    const at = s.indexOf('#[cfg(test)]');
    if (at < 0) return s;
    let i = at + '#[cfg(test)]'.length;
    while (i < s.length && /\s/.test(s[i])) i += 1;
    const semi = s.indexOf(';', i);
    const brace = s.indexOf('{', i);
    if (brace < 0 || (semi >= 0 && semi < brace)) {
      s = s.slice(0, at) + s.slice(semi + 1);
      continue;
    }
    let depth = 0;
    let j = brace;
    for (; j < s.length; j += 1) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    s = s.slice(0, at) + s.slice(j);
  }
}

/// 模型清单（C5 的交叉判据要读它）。
const MODELS_MANIFEST = path.join(ROOT, 'engine', 'models.manifest.json');

/// wheel 清单（G3 的交叉判据要读它）—— "哪些 wheel 声明随包"的**权威事实源**。
const WHEELS_MANIFEST = path.join(ROOT, 'engine', 'wheels.manifest.json');

/// Windows 安装引导（E2 的 SmartScreen / 长路径说明）。
const GUIDE_WIN = path.join(ROOT, 'docs', 'install-guide-windows.md');

/// NSIS 安装器钩子（E2/E3）的配置入口与文件（`q` 与配置文件同目录解析）。
const nsisHooksRef = (win) => {
  const p =
    win && win.bundle && win.bundle.windows && win.bundle.windows.nsis
      ? win.bundle.windows.nsis.installerHooks
      : undefined;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
};

/// 模型权重的**后缀黑名单**（C5：别把 NC 权重打进包）。
/// ⚠️ 有意**不含** `.bin`：它太宽（工具链的普通数据也叫 `.bin`），而"清单里那几条真资产"
///    由下面的逐条交叉断言覆盖。一条过宽的黑名单早晚会被后来者删掉，那比没有更坏。
const WEIGHT_SUFFIXES = ['.gguf', '.safetensors', '.ckpt', '.pth', '.pt', '.onnx'];

/**
 * 清单里**每一条模型资产**的文件名（`dest` / `linkTo` / `url` 三种写法的 basename）。
 *
 * 为什么用「与清单交叉」而不是再列一张扩展名表：扩展名表只能挡住"你预先想到的格式"，
 * 而清单是**唯一的权威事实源** —— 凡是清单里声明为资产的，出现在随包里就是错的，
 * 无论它叫什么。两条判据叠起来：黑名单挡"新格式的权重"，交叉挡"清单里的老资产"。
 */
function manifestAssetNames() {
  const m = readJson(MODELS_MANIFEST);
  const names = new Set();
  for (const f of (m && m.files) || []) {
    for (const key of ['dest', 'linkTo']) {
      const v = f[key];
      if (typeof v === 'string' && v) names.add(path.basename(v).toLowerCase());
    }
    if (typeof f.url === 'string' && f.url.includes('/')) names.add(f.url.split('/').pop().toLowerCase());
  }
  return { parsed: !!m, names };
}

/// `resources` 的形状：数组 **或** map（src→target）都合法（Tauri v2 两种都支持）。
const isResShape = (r) => Array.isArray(r) || (!!r && typeof r === 'object');

/// 摊平为「所有路径字符串」—— 用于查**有没有 node 载荷**（src 侧与 target 侧都要看）。
const resStrings = (r) => {
  if (Array.isArray(r)) return r.map(String);
  if (r && typeof r === 'object') return Object.entries(r).flatMap(([k, v]) => [String(k), String(v)]);
  return [String(r)];
};

/// 落到**资源目录里的相对路径**（target 侧）。数组形式下 Tauri 会**重建原目录结构**，
/// 并把 `../` 转义成 `_up_/`（官方行为）—— 判据必须照它算，否则会假红。
const resTargets = (r) => {
  if (Array.isArray(r)) return r.map(String).map((p) => p.replace(/^\.\.\//, '_up_/'));
  if (r && typeof r === 'object') return Object.values(r).map(String);
  return [];
};

/// 源文件相对路径（src 侧）。
const resSources = (r) => {
  if (Array.isArray(r)) return r.map(String);
  if (r && typeof r === 'object') return Object.keys(r).map(String);
  return [];
};

// ------------------------------------------------------------------ 正向断言

function runAll() {
  results.length = 0;

  const base = readJson(BASE_CONF);
  const win = readJson(WIN_CONF);

  // ---- W1：Windows 平台配置存在且指定 nsis ----
  const winTargets = win && win.bundle ? win.bundle.targets : undefined;
  check(
    'W1',
    '`tauri.windows.conf.json` 存在，且 `bundle.targets === ["nsis"]`（否则 Windows 上没有可产出的包型）',
    !!win && eqArr(winTargets, ['nsis']),
    win ? `windows targets=${JSON.stringify(winTargets)}` : '文件缺失或不是合法 JSON',
  );

  // ---- W2：基座 targets 未被改动（macOS 逐字节不变）----
  const baseTargets = base && base.bundle ? base.bundle.targets : undefined;
  check(
    'W2',
    '基座 `tauri.conf.json` 的 `bundle.targets` **仍是 `["app","dmg"]`**（Windows 支持必须走平台分叉，不许改基座污染 macOS）',
    eqArr(baseTargets, ['app', 'dmg']),
    `base targets=${JSON.stringify(baseTargets)}`,
  );

  // ---- W3：图标含 .ico ----
  const icons = (base && base.bundle && base.bundle.icon) || [];
  check(
    'W3',
    '基座 `bundle.icon` 含 `.ico`（Windows 打包必需；缺了会在打包阶段报错）',
    Array.isArray(icons) && icons.some((p) => String(p).toLowerCase().endsWith('.ico')),
    `icon=${JSON.stringify(icons)}`,
  );

  // ---- W4：windows 配置只放 Windows 专有键，不复制基座的键 ----
  const winBundleKeys = win && win.bundle ? Object.keys(win.bundle) : [];
  const topKeys = win ? Object.keys(win).filter((k) => k !== '$schema') : [];
  const copied = [...topKeys, ...winBundleKeys].filter((k) => BASE_OWNED_KEYS.includes(k));
  check(
    'W4',
    '`tauri.windows.conf.json` **不复制**基座已有的键（`productName`/`identifier`/`icon`/`active`/`macOS`/`resources`）—— 同一事实两处来源必漂移',
    copied.length === 0,
    copied.length
      ? `复制了：${copied.join(', ')}`
      : `顶层键=${JSON.stringify(topKeys)} bundle 键=${JSON.stringify(winBundleKeys)}`,
  );

  // ---- W5：随包资源里不得再有 Node（F5.8 验收标准③）----
  //    生效配置 = JSON Merge Patch(基座, windows)，所以**两边都要看** —— 只看基座会漏掉
  //    "在平台配置里补一条 resources" 这条路。
  //    ⚠️ `resources` 既可以是数组也可以是 map（src→target）；判据必须**两种都吃得下**，
  //    否则换成 map 就会让 W5 假红 —— 而它真正要钉的是"不许有 node 载荷"，不是数据结构。
  const resBase = (base && base.bundle && base.bundle.resources) || [];
  const resWin = (win && win.bundle && win.bundle.resources) || [];
  const resAll = [...resStrings(resBase), ...resStrings(resWin)];
  const nodeish = resAll.filter((p) => NODE_PAYLOAD.some((k) => p.toLowerCase().includes(k)));
  check(
    'W5',
    '`bundle.resources`（基座 + windows 配置）里**没有** Node 服务（`service/`）与 `node.zip` —— F5.8 已摘除 Node，服务由 Rust 提供',
    isResShape(resBase) && isResShape(resWin) && nodeish.length === 0,
    nodeish.length
      ? `混进了：${JSON.stringify(nodeish)}`
      : `base=${JSON.stringify(resBase)} win=${JSON.stringify(resWin)}`,
  );

  // ---- W6：产品运行期**必需**的资产必须随包（A2）----
  //    A1 让 Rust 能找到资源目录，A2 保证目录里有东西 —— 缺了 A2，A1 只是"找到了一个空目录"。
  //    🔴 失效形态：dev 态**永远测不出来**（资产就在仓库里，代码会回退过去），
  //    所以只能钉在**配置**上：这里漏一条，打包后 `mangasvc --check-assets` 才会报缺失。
  const targets = new Set([...resTargets(resBase), ...resTargets(resWin)]);
  const absent = REQUIRED_ASSETS.filter((a) => !targets.has(a));
  // src 侧也要真存在：配置写了但文件挪走了 ⇒ 打包阶段才炸，且报错离根因很远。
  const srcs = [...resSources(resBase), ...resSources(resWin)];
  const missingSrc = srcs.filter((s) => !fs.existsSync(path.resolve(CONF_DIR, s)));
  check(
    'W6',
    `随包资源必须含产品运行期**必需**的资产（${REQUIRED_ASSETS.join('、')}），且源文件真实存在 —— A1 找到资源目录后，A2 负责那里有东西`,
    absent.length === 0 && missingSrc.length === 0,
    absent.length
      ? `缺条目：${JSON.stringify(absent)}`
      : missingSrc.length
        ? `源文件不存在：${JSON.stringify(missingSrc)}`
        : `targets=${JSON.stringify([...targets])}`,
  );

  // ---- W7/W7b：随包里 **0 个模型权重**（C5：别把 NC 权重打进包）----
  //    两个方向都封：① 后缀黑名单挡"新格式的权重"；② 与清单逐条交叉挡"清单里的老资产"。
  //    🔴 反向的坑：清单读不到时交叉判据的集合为空 ⇒ **永远绿**（空断言）。
  //       所以 W7b 里显式断言"清单解析成功且资产名非空" —— 那是这条判据**有意义**的前提。
  const payloads = [...resStrings(resBase), ...resStrings(resWin), ...resTargets(resBase), ...resTargets(resWin)];
  const bySuffix = payloads.filter((p) => WEIGHT_SUFFIXES.some((s) => p.toLowerCase().endsWith(s)));
  const { parsed, names: assetNames } = manifestAssetNames();
  const byManifest = payloads.filter((p) => assetNames.has(path.basename(p).toLowerCase()));

  check(
    'W7',
    `随包资源里**没有**模型权重后缀（${WEIGHT_SUFFIXES.join(' / ')}）—— 权重一律由用户自下（C 组主路径）`,
    bySuffix.length === 0,
    bySuffix.length ? `混进了：${JSON.stringify(bySuffix)}` : `resources=${JSON.stringify(payloads)}`,
  );

  check(
    'W7b',
    '随包资源里**没有**清单声明的任何一条模型资产（与 `models.manifest.json` 逐条交叉），且这条判据非空转',
    parsed && assetNames.size > 0 && byManifest.length === 0,
    !parsed
      ? '清单读不到 ⇒ 交叉判据会**永远绿**（空断言），必须当作失败'
      : assetNames.size === 0
        ? '清单里没有任何资产名 ⇒ 同上'
        : byManifest.length
          ? `混进了：${JSON.stringify(byManifest)}`
          : `与清单 ${assetNames.size} 个资产名逐条比过，0 命中`,
  );

  // ---- W13：清单里声明"随包"的 wheel 必须真的在随包资源里（G3）----
  //    事实源是 `wheels.manifest.json`（不是这里的常量）：清单说有 ⇒ 包里必须有。
  //    🔴 漏配的后果**不是变红而是静默退化**：用户机上既没有 `.download-cache`、也没有编译器，
  //       依赖安装会退回源码编译 ⇒ 在没装 MSVC / Xcode CLT 的机器上装到一半失败，离根因极远。
  //    反证 M12 把那条资源删掉 ⇒ 本断言红。
  const wheelsManifest = readJson(WHEELS_MANIFEST);
  const wheelsMisread = !wheelsManifest || !Array.isArray(wheelsManifest.wheels);
  const bundledWheels = wheelsMisread ? [] : wheelsManifest.wheels.filter((w) => w && w.bundled === true);
  const wheelTargets = bundledWheels.map((w) => `engine/wheels/${path.basename(String(w.path || w.file || ''))}`);
  const wheelAbsent = wheelTargets.filter((t) => !targets.has(t));
  check(
    'W13',
    '`wheels.manifest.json` 里标了 `bundled: true` 的 wheel **确实在随包资源里**（G3：零编译器机器上包内那一份是唯一来源）',
    !wheelsMisread && bundledWheels.length > 0 && wheelAbsent.length === 0,
    wheelsMisread
      ? '清单读不到 ⇒ 判据会**永远绿**（空断言），必须当作失败'
      : bundledWheels.length === 0
        ? '清单里没有任何 bundled 条目 ⇒ 同上'
        : wheelAbsent.length
          ? `缺条目：${JSON.stringify(wheelAbsent)}`
          : `随包 wheel：${JSON.stringify(wheelTargets)}`,
  );

  // ---- W13b：wheel 清单本身必须随包 ----
  //    为什么单独一条：产品侧选路（`mangasvc/engine/wheels.rs::plan_crf`）**要读这份清单**
  //    才能决定走 wheel 还是源码编译。清单不在包里 ⇒ 选路恒回退源码编译。
  //    🔴 失效形态与 W13 同样**不是变红而是静默退化**，且比 W13 更隐蔽：
  //       wheel 明明在包里，产品却"看不见"它。
  //    🔴 包内落点刻意用 `engine/wheel-manifest.json` 而不是 `engine/wheels.manifest.json`：
  //       Tauri 的 NSIS 打包把**文件** `wheels.manifest.json` 与**目录** `wheels/` 当同名项
  //       —— 真机复现：release 产物两份都在，静默安装后清单不见了（wheel 在）。
  //       这条钉子同时钉住"落点不能改回那个会冲突的名字"（反证 M15）。
  //    🔴 刻意**不进** `REQUIRED_ASSETS`：那是「缺了就不许起服务」的口径，而 wheel 缺件
  //       有源码编译的合法回退 —— 塞进去会把「装不了」升级成「起不来」（同 wheels.manifest.json 的纪律）。
  const WHEELS_MANIFEST_TARGET = 'engine/wheel-manifest.json';
  check(
    'W13b',
    'wheel 清单**本身在随包资源里**且落点为 `engine/wheel-manifest.json`（产品侧 plan_crf 要读它才能选中包内 wheel；落点不许改回与 wheels/ 目录同名的 `wheels.manifest.json` —— NSIS 安装后它会消失）',
    targets.has(WHEELS_MANIFEST_TARGET),
    targets.has(WHEELS_MANIFEST_TARGET)
      ? `targets 含 ${WHEELS_MANIFEST_TARGET}`
      : `缺该条目；当前 targets=${JSON.stringify([...targets])}`,
  );

  // ---- W8/W9/W10/W12：干活的人从 NSIS 钩子换成了两个宿主程序（2026-10-18）----
  //    安装器自带载荷（单文件 exe）自解包安装、卸载器自己删入口与注册表项后再自删，
  //    于是 NSIS 钩子 `hooks.nsh` 整个退役。三条判据随之**搬家到宿主源码**上 ——
  //    钉「谁在真的干活」，而不是钉一个已经没人读的 `.nsh`。
  //      · 长路径提示 → 安装器 Rust 只读探测 + 前端给的可复制命令（W9）；
  //      · 「删数据前必须有闸」→ 卸载器 Rust 的 `guard()` 与"静默档不碰数据"（W10）；
  //      · 「静默档不许被弹窗挂住」→ 宿主源码里**没有阻塞式弹窗**（W12）。
  const installerSrcDir = path.join(ROOT, 'installer', 'src-tauri', 'src');
  const uninstallerSrcDir = path.join(ROOT, 'uninstaller', 'src-tauri', 'src');

  const hooksRef = nsisHooksRef(win);
  check(
    'W8',
    'Windows 打包**不再接** NSIS 安装器钩子（`bundle.windows.nsis.installerHooks` 未接线 + `installer/hooks.nsh` 已退役）' +
      '—— 两套安装逻辑并存时，用户会看到哪一套取决于谁先跑完',
    !hooksRef && !fs.existsSync(NSIS_HOOKS),
    `ref=${hooksRef} hooksExists=${fs.existsSync(NSIS_HOOKS)}`,
  );

  /*
   * ---- W9：长路径开关**只读**（迁自 hooks.nsh）----
   * 安装器探测 `LongPathsEnabled` 只为"要不要提示"，**不许替用户改**：那是系统级设置，
   * 改它要提权，且改坏了影响的是整台机器。
   * 判据两层：
   *   ① 真有读取：出现 `"LongPathsEnabled"` **字符串字面量**的文件里必须有 `RegQueryValueExW`；
   *   ② 绝无写入：同一批文件里不许出现任何写注册表调用（`RegSetValueExW` / `RegCreateKeyExW`）。
   * 🔴 认**带引号的字面量**而不是裸词：注释里写一句 `LongPathsEnabled` 就该算"读过它"吗？
   *    不算 —— 实测过：把 `const VALUE` 改名成 `LongPathsDisabled` 后，光靠注释里的裸词
   *    这条判据照样绿（假阳性）。字面量才代表"真的要读这个键"。
   * 🔴 第 ② 条按**整文件**判而不是逐行：写调用与那个常量在源码里天然不在同一行，
   *    逐行判会漏掉"常量在文件头、写调用在下方函数里"这种最可能的写法。
   */
  const installerFiles = rustSourcesIn(installerSrcDir);
  const longPathFiles = installerFiles.filter((f) => /["']LongPathsEnabled["']/.test(read(f)));
  const longPathReads = longPathFiles.filter((f) => /RegQueryValueExW/.test(read(f)));
  const longPathWrites = longPathFiles.filter((f) => /RegSetValueExW|RegCreateKeyExW/.test(read(f)));
  // 修复命令（可复制）在向导前端里；它是"不替用户改"的另一半 —— 总得告诉人怎么开
  const wizardData = read(path.join(ROOT, 'installer', 'src', 'data.ts'));
  const fixCommand = /LongPathsEnabled/.test(wizardData) && /New-ItemProperty/.test(wizardData);
  check(
    'W9',
    '长路径开关**只读**：安装器宿主读到它（`RegQueryValueExW`）且提到它的文件里**没有任何写注册表调用**，' +
      '向导给出可复制的修复命令（`New-ItemProperty`）',
    longPathReads.length > 0 && longPathWrites.length === 0 && fixCommand,
    `readFiles=${longPathReads.map((f) => path.basename(f))} writeFiles=${longPathWrites.map((f) => path.basename(f))} fixCommand=${fixCommand}`,
  );

  /*
   * ---- W10：删用户数据前必须有闸（迁自 hooks.nsh 的"默认保留 + 明确选是才删"）----
   * 现在的删除由卸载页勾选驱动、由卸载器 Rust 执行，所以判据钉在 `uninstaller/src-tauri/src/main.rs`：
   *   ① 逐项删除循环里 `guard(&dir)?` 必须**先于** `remove_dir_safely(&dir)?`；
   *   ② 静默档（`--silent`）**不许碰**用户数据（与旧 NSIS `/S` 同语义，e2e 靠它取证）；
   *   ③ 直接 `fs::remove_dir_all` 全仓只许出现一次（就在 `remove_dir_safely` 里，
   *      链接只摘链接、不许递归跟进去删）。
   */
  const uninstallerMain = read(path.join(uninstallerSrcDir, 'main.rs'));
  const uninstallBody = sliceFn(uninstallerMain, 'uninstall');
  const silentBody = sliceFn(uninstallerMain, 'run_silent');
  const guardAt = uninstallBody.indexOf('guard(&dir)?');
  const removeAt = uninstallBody.indexOf('remove_dir_safely(&dir)?');
  const guardFirst = guardAt >= 0 && removeAt >= 0 && guardAt < removeAt;
  const silentTouchesData = /data_dir\(|remove_dir_safely/.test(silentBody);
  const rawRemoveAll = uninstallerMain.split('fs::remove_dir_all').length - 1;
  /*
   * ④ 删程序文件之前**必须先结束占用 exe 的进程**（2026-10-18 用户实测的回归形态）：
   *    `miao-dock.exe` / `mangasvc.exe` 还在跑 ⇒ 删到一半报错 ⇒ 进度停在第 2 步、
   *    目录留下残缺内容，而且再也不会被清。
   *    界面档与静默档都要做，所以两段各判一次。
   */
  const killAt = uninstallBody.indexOf('terminate_running_app()');
  const filesAt = uninstallBody.indexOf('remove_program_files(');
  const killsFirst = killAt >= 0 && filesAt >= 0 && killAt < filesAt;
  const silentKills = /terminate_running_app\(\)/.test(silentBody);
  check(
    'W10',
    '删用户数据前必过安全闸（`guard()` 先于删除）+ 静默档不碰数据 + 直接 `remove_dir_all` 只有一处（在带链接判定的 `remove_dir_safely` 里）' +
      ' + 删程序文件前先结束运行中的程序（界面档与静默档都要 —— 否则占用导致删一半、进度卡住、目录留残）',
    guardFirst && !silentTouchesData && rawRemoveAll === 1 && killsFirst && silentKills,
    `guardFirst=${guardFirst} silentTouchesData=${silentTouchesData} rawRemoveAll=${rawRemoveAll} ` +
      `killsFirst=${killsFirst} silentKills=${silentKills}`,
  );

  /*
   * ---- W12：宿主源码里**没有阻塞式弹窗**（迁自 hooks.nsh 的 `IfSilent` 守卫）----
   * 旧坑：NSIS 的 `MessageBox` 在 `/S` 静默档下照样弹窗并阻塞 ⇒ `check:packaged` 的
   * 静默安装/卸载**永远不返回**（不是变红，是超时）。
   * 新形态下静默档由 `--silent` 参数决定、全程不开窗口，唯一允许的模态交互是
   * **用户主动点出来的选目录对话框**。所以判据是：两个宿主的 Rust 源码里
   * 出现 `MessageBox` / `blocking_show` 即红；`blocking_pick_folder` 只许出现在安装器
   * 那个 `pick_dir` 命令的实现里。
   */
  const hostFiles = [...rustSourcesIn(installerSrcDir), ...rustSourcesIn(uninstallerSrcDir)];
  const modalHits = hostFiles.filter((f) => /MessageBox|blocking_show/.test(read(f)));
  const pickerFiles = hostFiles.filter((f) => /blocking_pick_folder/.test(read(f)));
  const pickerOk =
    pickerFiles.length === 0 ||
    (pickerFiles.length === 1 &&
      pickerFiles[0] === path.join(installerSrcDir, 'main.rs') &&
      /fn pick_dir\(/.test(read(pickerFiles[0])));
  check(
    'W12',
    '宿主源码里没有阻塞式弹窗（`MessageBox` / `blocking_show`）；`blocking_pick_folder` 只出现在安装器的 `pick_dir` 里' +
      ' —— 静默档被弹窗拦住的失败形态是**不返回**，不是变红',
    modalHits.length === 0 && pickerOk,
    `modal=${modalHits.map((f) => path.basename(f))} picker=${pickerFiles.map((f) => path.basename(f))} pickerOk=${pickerOk}`,
  );

  const guide = fs.existsSync(GUIDE_WIN) ? read(GUIDE_WIN) : '';
  check(
    'W11',
    'Windows 安装引导里写清了两件事：SmartScreen 怎么过 + 长路径为什么必须开',
    /SmartScreen/.test(guide) && /LongPathsEnabled/.test(guide),
    `smartScreen=${/SmartScreen/.test(guide)} longPaths=${/LongPathsEnabled/.test(guide)}`,
  );

  /*
   * ---- W14：产品 Rust 源码里**零 node 字面量**（D-209）----
   * W5 钉的是"随包里没装 node"；这条钉的是"产品路径**再也不会**拉起 node"。
   * 判据、窗口、以及"为什么钉字面量而不是 spawn 点"见文件头 W14 条。
   */
  const sources = rustSources();
  const nodeHits = [];
  for (const f of sources) {
    const lines = stripCfgTest(read(f)).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/"node"|'node'|node\.exe/.test(lines[i])) continue;
      const lo = Math.max(0, i - NODE_LITERAL_WINDOW);
      const win = lines.slice(lo, i + NODE_LITERAL_WINDOW + 1).join('\n');
      if (NODE_LITERAL_ALLOW.some((m) => win.includes(m))) continue;
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      nodeHits.push(`${rel}:${i + 1} ${lines[i].trim()}`);
    }
  }
  check(
    'W14',
    '产品 Rust 源码（已剥 `#[cfg(test)]`）里没有指向 node 解释器的字面量 —— 只允许出现在' +
      ' `MIAO_NODE_EXEC`（①② 的 mock 替身解释器）或 `MIAO_SERVICE_IMPL`（退役门）的上下文里',
    sources.length > 0 && nodeHits.length === 0,
    nodeHits.length
      ? `产品路径里的 node 字面量：${nodeHits.join(' ｜ ')}`
      : `扫了 ${sources.length} 个 .rs（已剥 #[cfg(test)]）`,
  );

  /*
   * ---- W15：产品版本号只有一处事实源（2026-10-18）----
   * 交付名改成 `MiaoDock_<版本>_<架构>-setup.exe` 之后，版本号**直接进了文件名** ——
   * 于是"三份 tauri.conf / 两份 Cargo.toml / 两份 package.json / 两处前端文案"里任何一处漏改，
   * 都会得到「包名 2.3.0、界面印 2.2.1」这种最难发现的形态（两处各自都"正常"，只有人去对才发现）。
   *
   * 判据三层：
   *   ① 三份 `tauri.conf.json` 的 `version` 必须相等；
   *   ② 两个宿主的 `Cargo.toml` 的 `[package] version` 与两份 `package.json` 的 `version` 也要相等 ——
   *      宿主侧 `env!("CARGO_PKG_VERSION")` 给界面用的就是它；
   *   ③ 两个前端源码里**不许**再出现那个版本号字面量：界面版本一律由宿主探测注入
   *      （预览替身写的是 `0.0.0-preview`，故意与真版本不同 ⇒ 一眼能看出是浏览器预览）。
   * 🔴 第 ③ 条是这轮的实际修法：`data.ts` 里原本各写死一份 `'2.2.1'`。
   */
  const versionOf = (confFile) => {
    const conf = readJson(confFile);
    return conf && typeof conf.version === 'string' ? conf.version : null;
  };
  const cargoVersionOf = (file) => {
    if (!fs.existsSync(file)) return null;
    const hit = read(file).match(/^version\s*=\s*"([^"]+)"/m);
    return hit ? hit[1] : null;
  };
  const versionSources = {
    'tauri.conf.json（基座）': versionOf(BASE_CONF),
    'installer/tauri.conf.json': versionOf(path.join(ROOT, 'installer', 'src-tauri', 'tauri.conf.json')),
    'uninstaller/tauri.conf.json': versionOf(path.join(ROOT, 'uninstaller', 'src-tauri', 'tauri.conf.json')),
    'installer/Cargo.toml': cargoVersionOf(path.join(ROOT, 'installer', 'src-tauri', 'Cargo.toml')),
    'uninstaller/Cargo.toml': cargoVersionOf(path.join(ROOT, 'uninstaller', 'src-tauri', 'Cargo.toml')),
    'installer/package.json': versionOf(path.join(ROOT, 'installer', 'package.json')),
    'uninstaller/package.json': versionOf(path.join(ROOT, 'uninstaller', 'package.json')),
  };
  const declared = versionSources['tauri.conf.json（基座）'];
  const drifted = Object.entries(versionSources)
    .filter(([, v]) => v !== declared)
    .map(([name, v]) => `${name}=${v ?? '读不到'}`);
  // ③ 前端源码里不许出现这个版本号字面量
  const frontendFiles = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  };
  const frontendLeaks = [];
  for (const dir of [path.join(ROOT, 'installer', 'src'), path.join(ROOT, 'uninstaller', 'src')]) {
    for (const file of frontendFiles(dir)) {
      if (declared && read(file).includes(declared)) {
        frontendLeaks.push(`${path.relative(ROOT, file)} 含 ${declared}`);
      }
    }
  }
  check(
    'W15',
    '产品版本号只有一处事实源：三份 `tauri.conf.json` + 两个 `Cargo.toml` + 两份 `package.json` 必须一致，' +
      '且两个前端源码里**不许**出现该版本号字面量（界面版本由宿主注入）',
    !!declared && drifted.length === 0 && frontendLeaks.length === 0,
    `版本=${declared ?? '读不到'} 漂移=${drifted.length ? drifted.join('、') : '无'} ` +
      `前端硬编码=${frontendLeaks.length ? frontendLeaks.join('、') : '无'}`,
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

/// 每条变异 = 把某一处**改回缺陷形态**，并声明哪几条断言必须因此变红。
/// 注意：W1 的两条变异分别破坏「存在」与「取值」两种形态，覆盖两种真实回退方式。
const MUTATIONS = [
  {
    name: 'M1 windows 配置的 targets 退回空数组（等于没配）',
    edits: [{ file: WIN_CONF, find: '"targets": ["nsis"]', replace: '"targets": []' }],
    expect: ['W1'],
  },
  {
    name: 'M2 用改基座的方式"支持 Windows"（targets 改成 "all"）',
    edits: [{ file: BASE_CONF, find: '"targets": ["app", "dmg"]', replace: '"targets": "all"' }],
    expect: ['W2'],
  },
  {
    name: 'M3 从基座图标里删掉 .ico',
    edits: [{ file: BASE_CONF, find: '"icons/icon.ico", ', replace: '' }],
    expect: ['W3'],
  },
  {
    name: 'M4 windows 配置把基座的 icon 也抄了一份（埋下漂移）',
    edits: [
      {
        file: WIN_CONF,
        find: '"targets": ["nsis"]',
        replace: '"targets": ["nsis"],\n    "icon": ["icons/icon.ico"]',
        // 注意：JSON 里 "icon" 与 "targets" 同级（都在 bundle 下），复制它即触发 W4
      },
    ],
    expect: ['W4'],
  },
  {
    name: 'M5 把 Node 服务塞回随包资源（F5 摘除 Node 的回归）',
    edits: [
      {
        file: BASE_CONF,
        find: '"resources": {',
        replace: '"resources": {\n      "../service/": "service/",\n      "../vendor/node.zip": "node.zip",',
      },
    ],
    expect: ['W5'],
  },
  {
    name: 'M6 必需资产的条目被换成别的（A2 漏配：A1 找到的将是个空目录）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../engine/models.manifest.json": "engine/models.manifest.json"',
        replace: '"../engine/VERSIONS.lock": "engine/VERSIONS.lock"',
      },
    ],
    expect: ['W6'],
  },
  {
    name: 'M7 条目 target 写对但 src 指到不存在的文件（打包阶段才炸，报错离根因极远）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../engine/models.manifest.json": "engine/models.manifest.json"',
        replace: '"../engine/nope.json": "engine/models.manifest.json"',
      },
    ],
    expect: ['W6'],
  },
  {
    // C5 验收②：把一份 NC 权重塞进 `resources`。**必须变红**，否则"包内 0 权重"就是空的。
    name: 'M8 把一份 Sakura 权重（`*.gguf`）塞进随包资源（C5：许可边界被踩）',
    edits: [
      {
        file: BASE_CONF,
        find: '"resources": {',
        replace: '"resources": {\n      "../engine/models/sakura-1.5b-q4.gguf": "models/sakura-1.5b-q4.gguf",',
      },
    ],
    expect: ['W7'],
  },
  {
    // 后缀黑名单**挡不住**这条（目标名是 `.json`）—— 它只有"与清单交叉"才能抓到。
    // 没有这条变异，W7b 就是一条"看起来在防、其实永远绿"的断言。
    name: 'M9 用改名方式夹带清单里的权重（后缀黑名单挡不住 ⇒ 只能靠与清单交叉）',
    edits: [
      {
        file: BASE_CONF,
        find: '"resources": {',
        replace:
          '"resources": {\n      "../engine/models-store/translators/nllb/models--facebook--nllb-200-distilled-600M/blobs/c266c2cfd19758b6d09c1fc31ecdf1e485509035f6b51dfe84f1ada83eefcc42": "models/c266c2cfd19758b6d09c1fc31ecdf1e485509035f6b51dfe84f1ada83eefcc42.json",',
      },
    ],
    expect: ['W7b'],
  },
  {
    // G3：清单声明"随包"，而资源里那条被改成了别的名字 ⇒ 包内那份没进包。
    // 失效形态是**静默退化**（用户机上退回源码编译，在没有编译器的机器上装不上），
    // 不是"看起来缺个文件"—— 所以必须有这条变异。
    name: 'M10 抹掉随包 wheel 的资源条目（G3：包内那一份没进包 ⇒ 用户机静默退回源码编译）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../engine/wheels/pydensecrf-1.0-cp311-cp311-win_amd64.whl": "engine/wheels/pydensecrf-1.0-cp311-cp311-win_amd64.whl"',
        replace: '"../engine/wheels/other.whl": "engine/wheels/other.whl"',
      },
    ],
    expect: ['W13'],
  },
  {
    // W13b 的反证一：**wheel 清单本身**没进包。wheel 明明在包里，产品却读不到清单
    // ⇒ 选路恒回退源码编译。这条比 M10 更隐蔽（产物看着是全的），所以必须单独有一条变异。
    // ⚠️ 锚点**单行且不含换行**：本脚本的变异器不做 EOL 折算，带 `\n` 的锚点在 CRLF
    //    文件里匹配不上 ⇒ 会被判成"未找到"而**静默跳过**（跳过 ≠ 通过）。
    name: 'M14 抹掉 wheel 清单的资源条目（W13b：产品读不到清单 ⇒ 包内 wheel 明明在却选不中）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../engine/wheels.manifest.json": "engine/wheel-manifest.json",',
        replace: '"../engine/wheels.manifest.json.off": "engine/wheel-manifest.json.off",',
      },
    ],
    expect: ['W13b'],
  },
  {
    // W13b 的反证二：把落点**改回**与 `wheels/` 目录同名的 `wheels.manifest.json`。
    // 这不是"理论上不好"—— 真机复现过：那样打包出来，静默安装后清单会消失（wheel 还在），
    // 而消失的表现是目标机上静默退回源码编译。没有这条变异，"换个落点"随时可能被改回去。
    name: 'M15 把 wheel 清单的包内落点改回 wheels.manifest.json（W13b：与 wheels/ 目录同名 ⇒ NSIS 安装后清单消失）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../engine/wheels.manifest.json": "engine/wheel-manifest.json",',
        replace: '"../engine/wheels.manifest.json": "engine/wheels.manifest.json",',
      },
    ],
    expect: ['W13b'],
  },
  {
    // ⚠️ 锚点一律**单行**：本脚本的变异器不做 EOL 折算（配置是 CRLF），
    //    多行锚点会被判成"未找到"而**静默跳过** —— 跳过 ≠ 通过。
    // 回归形态：把钩子接线加回来。两套安装逻辑并存时，用户看到哪一套取决于谁先跑完。
    name: 'E2：把 NSIS 安装器钩子的接线加回来（两套安装逻辑并存）',
    edits: [
      {
        file: WIN_CONF,
        find: '"targets": ["nsis"]',
        replace: '"targets": ["nsis"], "windows": { "nsis": { "installerHooks": "../installer/hooks.nsh" } }',
      },
    ],
    expect: ['W8'],
  },
  {
    // 回归形态：长路径探测被删。用户一路装到一半才报"文件名太长"，报错位置离根因很远。
    name: 'E2：安装器不再读系统长路径开关（用户装到一半才报「文件名或扩展名太长」）',
    edits: [
      {
        file: path.join(ROOT, 'installer', 'src-tauri', 'src', 'main.rs'),
        find: 'const VALUE: &str = "LongPathsEnabled";',
        replace: 'const VALUE: &str = "LongPathsDisabled";',
      },
    ],
    expect: ['W9'],
  },
  {
    // 「顺手替用户开一下」看起来是善意的，但它是**系统级**设置且要提权 ——
    // 安装器不声不响改 HKLM，与"只提示"是两回事。
    name: 'E2：安装器**替用户改**系统级长路径开关（提权 + 不声不响改 HKLM）',
    edits: [
      {
        file: path.join(ROOT, 'installer', 'src-tauri', 'src', 'main.rs'),
        find: 'const VALUE: &str = "LongPathsEnabled";',
        replace:
          'const VALUE: &str = "LongPathsEnabled";\n' +
          '    fn _w(key: windows_sys::Win32::System::Registry::HKEY) {\n' +
          '        let one: u32 = 1;\n' +
          '        unsafe { windows_sys::Win32::System::Registry::RegSetValueExW(key, std::ptr::null(), 0, 4, &one as *const u32 as *const u8, 4) };\n' +
          '    }',
      },
    ],
    expect: ['W9'],
  },
  {
    // 🔴 最危险的一种回归：安全闸被摘掉。删的是用户几十分钟的装配成果与译稿。
    name: 'E3：卸载器删数据前不再过 `guard()`（路径闸被摘 ⇒ 可能删到安装目录之外）',
    edits: [
      {
        file: path.join(ROOT, 'uninstaller', 'src-tauri', 'src', 'main.rs'),
        find: '        guard(&dir)?;',
        replace: '        // M：安全闸被摘',
      },
    ],
    expect: ['W10'],
  },
  {
    // 静默档（`QuietUninstallString` / 包管理器）悄悄删数据 —— 用户没点过任何勾选。
    name: 'E3：静默卸载也删用户数据（`--silent` 不再"只删程序"）',
    edits: [
      {
        file: path.join(ROOT, 'uninstaller', 'src-tauri', 'src', 'main.rs'),
        find: 'fn run_silent() -> i32 {',
        replace: 'fn run_silent() -> i32 {\n    let _ = remove_dir_safely(&root_dir());',
      },
    ],
    expect: ['W10'],
  },
  {
    // 回归形态：不先结束运行中的主程序就删文件 ⇒ 删一半报错、进度卡住、目录留残。
    name: 'E3：卸载前不结束运行中的主程序（删一半报错，目录留残）',
    edits: [
      {
        file: path.join(ROOT, 'uninstaller', 'src-tauri', 'src', 'main.rs'),
        find: '    let killed = terminate_running_app();',
        replace: '    let killed = 0usize;',
      },
    ],
    expect: ['W10'],
  },
  {
    // 🔴 阻塞弹窗在静默档里"挂住"是最坏的一种失败：没有红字，只有超时。
    name: 'E2：安装器宿主里塞一个阻塞弹窗（静默档会挂住，不是变红）',
    edits: [
      {
        file: path.join(ROOT, 'installer', 'src-tauri', 'src', 'main.rs'),
        find: 'fn close_window(window: tauri::Window) {',
        replace:
          'fn close_window(window: tauri::Window) {\n' +
          '    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), 0) };',
      },
    ],
    expect: ['W12'],
  },
  {
    name: 'E2：把 SmartScreen 的说明从安装引导里删掉（用户看到"Windows 已保护你的电脑"就卡住）',
    edits: [
      {
        file: GUIDE_WIN,
        find: 'SmartScreen',
        replace: '系统保护提示',
        // 🔴 必须 all：引导里有两处（§1.1 标题 + § troubleshooting 正文），只改第一处
        //    断言照绿 ⇒ 这条反证会变成假反证（实测过）。
        all: true,
      },
    ],
    expect: ['W11'],
  },
  {
    /*
     * 🔴 D-209 要防的**真实回归形态**：`resolve_mangasvc()` 是"退路"的落点 —— F5.8 曾在这里
     *    留过"拿不到 mangasvc 就退回 Node 服务"的路（那段注释现在还在函数上方）。把退路加回去
     *    是**一次看起来最合理的改动**：包仍然干净（W5 绿）、e2e 仍全绿（开发态 mangasvc 就在
     *    同目录、根本走不到退路），只有用户机上会多一个 node 进程。
     *    ⚠️ 锚点故意选在离 `MIAO_SERVICE_IMPL` 二十多行的地方：若插在退役门旁边，
     *    W14 的允许窗口会把它盖住 ⇒ 该条违反"反证必须真能打红"。
     */
    name: 'M13 把 Node 服务退路加回 `resolve_mangasvc()`（包干净、e2e 全绿，只有用户机上多一个 node 进程）',
    edits: [
      {
        file: path.join(RUST_SRC, 'service', 'mod.rs'),
        find: '    let name = if cfg!(windows) { "mangasvc.exe" } else { "mangasvc" };',
        replace:
          '    let _ = std::process::Command::new("node").arg("service/src/server.mjs").spawn();\n' +
          '    let name = if cfg!(windows) { "mangasvc.exe" } else { "mangasvc" };',
      },
    ],
    expect: ['W14'],
  },
  {
    // W15 的反证一：**宿主侧**版本漂移。包名会变成 MiaoDock_9.9.9_...，而主应用还是 2.2.1。
    name: 'W15：安装器宿主的版本号与主应用不一致（包名 9.9.9、主程序 2.2.1）',
    edits: [
      {
        file: path.join(ROOT, 'installer', 'src-tauri', 'tauri.conf.json'),
        find: '"version": "2.2.1"',
        replace: '"version": "9.9.9"',
      },
    ],
    expect: ['W15'],
  },
  {
    // W15 的反证二：**前端**把版本号又写死回去。这条与上一条各挡一类 ——
    // 只改后端 conf 时界面读到的是新值，而前端写死的那份永远是旧值。
    name: 'W15：前端把版本号写死回去（界面印 2.2.1、包名却是新版本）',
    edits: [
      {
        file: path.join(ROOT, 'installer', 'src', 'data.ts'),
        find: "winTitle: '喵坞 安装向导',",
        replace: "winTitle: '喵坞 安装向导',\n  version: '2.2.1',",
      },
    ],
    expect: ['W15'],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

const main = () => {
  console.log(`Windows 打包配置钉子${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    runAll();
    const { fail } = printResults('Windows 打包 · 配置钉子');
    process.exitCode = fail === 0 ? 0 : 1;
    return;
  }

  runAll();
  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const originals = new Map();

  console.log('\n破坏配置文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    let missing = false;
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(
          `⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`,
        );
        skipped += mut.expect.length;
        missing = true;
        continue;
      }
      /*
       * `all: true` 用于「同一处改错在文件里天然出现多遍」的情形 —— 只改第一处时
       * 断言仍然绿，这条反证就退化成**假反证**（看起来覆盖到了，其实什么都没测到）。
       * 实例：SmartScreen 在安装引导里有标题与正文两处，只改标题那处 ⇒ W11 照绿。
       */
      fs.writeFileSync(e.file, e.all ? txt.split(e.find).join(e.replace) : txt.replace(e.find, e.replace));
    }
    if (missing) {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap); // 还原已改的那几处
      continue;
    }

    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    配置文件会永久留成被破坏状态。
    let res = {};
    let roundErr = null;
    try {
      runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap);
    }

    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
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

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

try {
  main();
} catch (err) {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
