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
const BASE_CONF = path.join(ROOT, 'app', 'src-tauri', 'tauri.conf.json');
const WIN_CONF = path.join(ROOT, 'app', 'src-tauri', 'tauri.windows.conf.json');
/** NSIS 安装器钩子文件（E2/E3）—— 与 `tauri.windows.conf.json` 里那条引用同一处。 */
const NSIS_HOOKS = path.join(ROOT, 'app', 'src-tauri', 'nsis', 'hooks.nsh');

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
///    `check:resources` 会拿 `boxsvc --check-assets` 报的必需资产与这里比对，
///    两边漂移就变红 —— 单一事实源做不到，就退而求其次让它**可观测地漂移**。
const REQUIRED_ASSETS = ['engine/models.manifest.json'];

/// `bundle.resources` 的目录（src 相对它解析）。
const CONF_DIR = path.dirname(BASE_CONF);

/// 模型清单（C5 的交叉判据要读它）。
const MODELS_MANIFEST = path.join(ROOT, 'engine', 'models.manifest.json');

/// Windows 安装引导（E2 的 SmartScreen / 长路径说明）。
const GUIDE_WIN = path.join(ROOT, 'docs', 'install-guide-windows.md');

/// NSIS 安装器钩子（E2/E3）的配置入口与文件（`q` 与配置文件同目录解析）。
const nsisHooksRef = (win) => {
  const p = win && win.bundle && win.bundle.windows && win.bundle.windows.nsis
    ? win.bundle.windows.nsis.installerHooks
    : undefined;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
};
const nsisHooksFile = (win) => {
  const ref = nsisHooksRef(win);
  return ref ? path.resolve(path.dirname(WIN_CONF), ref) : null;
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
    copied.length ? `复制了：${copied.join(', ')}` : `顶层键=${JSON.stringify(topKeys)} bundle 键=${JSON.stringify(winBundleKeys)}`,
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
    nodeish.length ? `混进了：${JSON.stringify(nodeish)}` : `base=${JSON.stringify(resBase)} win=${JSON.stringify(resWin)}`,
  );

  // ---- W6：产品运行期**必需**的资产必须随包（A2）----
  //    A1 让 Rust 能找到资源目录，A2 保证目录里有东西 —— 缺了 A2，A1 只是"找到了一个空目录"。
  //    🔴 失效形态：dev 态**永远测不出来**（资产就在仓库里，代码会回退过去），
  //    所以只能钉在**配置**上：这里漏一条，打包后 `boxsvc --check-assets` 才会报缺失。
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
  const payloads = [
    ...resStrings(resBase),
    ...resStrings(resWin),
    ...resTargets(resBase),
    ...resTargets(resWin),
  ];
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

  // ---- W8/W9/W10：NSIS 安装器钩子（E2 长路径提示 / E3 卸载提示）+ W11 文档 ----
  //    这三条都在**配置与钩子文件**上钉：真跑一次安装器要分钟级 + 真要弹窗，而"提示语
  //    写错一处"（默认按钮落在「删」那一支）的代价是用户几十分钟的装配成果没了。
  const hooksRef = nsisHooksRef(win);
  const hooksFile = nsisHooksFile(win);
  check(
    'W8',
    'Windows 平台配置把 NSIS 安装器钩子接上了（`bundle.windows.nsis.installerHooks` → 文件真实存在）',
    !!hooksRef && !!hooksFile && fs.existsSync(hooksFile),
    `ref=${hooksRef} exists=${hooksFile ? fs.existsSync(hooksFile) : false}`,
  );

  const nsh = hooksFile && fs.existsSync(hooksFile) ? read(hooksFile) : '';
  /*
   * 🔴 判据只看**代码**，不看注释：`;` 开头的整行是 NSIS 注释。
   * 不剥注释的话会两头出错 —— ① 注释里提一句 `Pictures` 就让"绝不碰作品目录"假红
   * （本文件尾注就写明了不碰它）；② 反过来，把检查注释掉也能让断言照绿。
   */
  const nshCode = nsh.split(/\r?\n/).filter((l) => !l.trim().startsWith(';')).join('\n');
  const nshFacts = [
    `ReadRegDWORD=${/ReadRegDWORD/.test(nshCode)}`,
    `LongPathsEnabled=${/LongPathsEnabled/.test(nshCode)}`,
    `SetRegView=${/SetRegView/.test(nshCode)}`,
    `New-ItemProperty=${/New-ItemProperty/.test(nshCode)}`,
    `WriteRegDWORD=${/WriteRegDWORD/.test(nshCode)}`,
  ].join(' ');
  check(
    'W9',
    '钩子里有**长路径开关的只读检查**（读 64 位视图 + 给出可执行修复命令），且**不替用户改系统设置**'
      + '（写 `HKLM` 要提权，安装器是当前用户模式 ⇒ 只提示）',
    /ReadRegDWORD/.test(nshCode) && /LongPathsEnabled/.test(nshCode) && /SetRegView/.test(nshCode)
      && /New-ItemProperty/.test(nshCode) && !/WriteRegDWORD/.test(nshCode),
    nshFacts,
  );

  // 🔴 E3 的两条硬要求：① 默认是**保留**；② 删除动作只发生在用户明确点「是」之后。
  //    第 ② 条用结构判据：`RMDir /r` 必须出现在某个 `IDYES` **之后**（而不是无条件执行）。
  const rmAt = nshCode.indexOf('RMDir /r "$LOCALAPPDATA\\runtimes');
  const yesAt = rmAt >= 0 ? nshCode.lastIndexOf('IDYES', rmAt) : -1;
  check(
    'W10',
    '卸载提示：默认**保留**（`MB_DEFBUTTON2`）+ 删除只在明确选「是」之后（`RMDir` 出现在 `IDYES` 之后）+ 绝不碰作品目录',
    /MB_DEFBUTTON2/.test(nshCode) && rmAt > 0 && yesAt > 0 && !/Pictures/i.test(nshCode),
    `defaultKeep=${/MB_DEFBUTTON2/.test(nshCode)} rmAt=${rmAt} yesAt=${yesAt} touchesPictures=${/Pictures/i.test(nshCode)}`,
  );

  /*
   * ---- W12：每个弹窗之前必须有 `IfSilent` 守卫（E2/E3 的**挂死**风险）----
   * NSIS 的 `MessageBox` 在 `/S` 静默安装/卸载下**照样弹窗并阻塞**（`/SD` 只决定"默认按钮是谁"）。
   * 不守卫的后果不是变红，而是 `npm run check:packaged` 的静默安装/卸载**永远不返回** ——
   * "时红时绿"已经够坏，"挂住"更坏（CI 上表现为超时被 kill，根因却在一行 MessageBox）。
   *
   * ⚠️ 判据必须**剥 NSIS 注释**（`;` 到行尾）：本文件的注释里正写着"`IfSilent` 必须在任何
   * `MessageBox` 之前"——拿原文判的话，`indexOf` 命中的是注释里的那两个词，判据恒绿。
   */
  const macros = [...nshCode.matchAll(/!macro\s+(\w+)([\s\S]*?)!macroend/g)].map((m) => ({ name: m[1], body: m[2] }));
  const unguarded = [];
  for (const mac of macros) {
    const at = mac.body.indexOf('MessageBox');
    if (at < 0) continue;
    const silent = mac.body.indexOf('IfSilent');
    if (silent < 0 || silent > at) unguarded.push(mac.name);
  }
  check(
    'W12',
    '每个 `MessageBox` 之前都有 `IfSilent` 守卫（静默安装/卸载不得被弹窗挂住 —— 那不是变红，是不返回）',
    macros.length > 0 && unguarded.length === 0,
    { macros: macros.map((m) => m.name), unguarded },
  );

  const guide = fs.existsSync(GUIDE_WIN) ? read(GUIDE_WIN) : '';
  check(
    'W11',
    'Windows 安装引导里写清了两件事：SmartScreen 怎么过 + 长路径为什么必须开',
    /SmartScreen/.test(guide) && /LongPathsEnabled/.test(guide),
    `smartScreen=${/SmartScreen/.test(guide)} longPaths=${/LongPathsEnabled/.test(guide)}`,
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
        replace:
          '"resources": {\n      "../service/": "service/",\n      "../vendor/node.zip": "node.zip",',
      },
    ],
    expect: ['W5'],
  },
  {
    name: 'M6 必需资产的条目被换成别的（A2 漏配：A1 找到的将是个空目录）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../../engine/models.manifest.json": "engine/models.manifest.json"',
        replace: '"../../engine/VERSIONS.lock": "engine/VERSIONS.lock"',
      },
    ],
    expect: ['W6'],
  },
  {
    name: 'M7 条目 target 写对但 src 指到不存在的文件（打包阶段才炸，报错离根因极远）',
    edits: [
      {
        file: BASE_CONF,
        find: '"../../engine/models.manifest.json": "engine/models.manifest.json"',
        replace: '"../../engine/nope.json": "engine/models.manifest.json"',
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
        replace: '"resources": {\n      "../../engine/models/sakura-1.5b-q4.gguf": "models/sakura-1.5b-q4.gguf",',
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
          '"resources": {\n      "../../engine/models-store/translators/nllb/models--facebook--nllb-200-distilled-600M/blobs/c266c2cfd19758b6d09c1fc31ecdf1e485509035f6b51dfe84f1ada83eefcc42": "models/c266c2cfd19758b6d09c1fc31ecdf1e485509035f6b51dfe84f1ada83eefcc42.json",',
      },
    ],
    expect: ['W7b'],
  },
  {
    // ⚠️ 锚点一律**单行**：本脚本的变异器不做 EOL 折算（配置与 .nsh 都是 CRLF），
    //    多行锚点会被判成"未找到"而**静默跳过** —— 跳过 ≠ 通过。
    name: 'E2：把 NSIS 安装器钩子的接线摘掉（长路径提示与卸载提示都不会再出现）',
    edits: [{ file: WIN_CONF, find: '"installerHooks": "nsis/hooks.nsh"', replace: '"installerHooksOff": "nsis/hooks.nsh"' }],
    expect: ['W8'],
  },
  {
    name: 'E2：钩子指向一个不存在的文件（打包阶段才会炸，报错离根因很远）',
    edits: [{ file: WIN_CONF, find: '"nsis/hooks.nsh"', replace: '"nsis/nope.nsh"' }],
    expect: ['W8'],
  },
  {
    name: 'E2：长路径检查被删掉（用户一路装到一半才报"文件名太长"）',
    edits: [
      {
        file: NSIS_HOOKS,
        find: '  ReadRegDWORD $0 HKLM "SYSTEM\\CurrentControlSet\\Control\\FileSystem" "LongPathsEnabled"',
        replace: '  ;M12 长路径检查被删',
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
        file: NSIS_HOOKS,
        find: '  ReadRegDWORD $0 HKLM "SYSTEM\\CurrentControlSet\\Control\\FileSystem" "LongPathsEnabled"',
        replace: '  WriteRegDWORD HKLM "SYSTEM\\CurrentControlSet\\Control\\FileSystem" "LongPathsEnabled" 1\n  ReadRegDWORD $0 HKLM "SYSTEM\\CurrentControlSet\\Control\\FileSystem" "LongPathsEnabled"',
      },
    ],
    expect: ['W9'],
  },
  {
    // 🔴 E3 最危险的一种写法：默认按钮落在「是」上 ⇒ 用户回车就删掉几十分钟的装配成果。
    name: 'E3：卸载提示的默认按钮落在「删除」上（回车 = 删掉引擎运行时）',
    edits: [{ file: NSIS_HOOKS, find: '|MB_DEFBUTTON2', replace: '' }],
    expect: ['W10'],
  },
  {
    name: 'E3：删除动作变成无条件（提示还在，但还没等用户选就删了）',
    edits: [
      {
        file: NSIS_HOOKS,
        find: '  IfFileExists "$LOCALAPPDATA\\runtimes\\manga-translator\\*.*" 0 moor_no_runtimes',
        replace:
          '  IfFileExists "$LOCALAPPDATA\\runtimes\\manga-translator\\*.*" 0 moor_no_runtimes\n'
          + '    RMDir /r "$LOCALAPPDATA\\runtimes\\manga-translator"',
      },
    ],
    expect: ['W10'],
  },
  {
    // 🔴 去掉静默守卫 ⇒ 静默卸载被 MessageBox 拦死 ⇒ `check:packaged` 的收尾永远跑不完。
    //    "挂住"是最坏的一种失败：没有红字，只有超时。
    name: 'E3：卸载弹窗去掉 `IfSilent` 守卫（静默卸载会挂住，不是变红）',
    edits: [{ file: NSIS_HOOKS, find: '  IfSilent moor_keep_runtimes', replace: '  ;M 守卫被摘' }],
    expect: ['W12'],
  },
  {
    name: 'E2：安装后长路径提示去掉 `IfSilent` 守卫（静默安装会挂住）',
    edits: [{ file: NSIS_HOOKS, find: '  IfSilent moor_longpath_done', replace: '  ;M 守卫被摘' }],
    expect: ['W12'],
  },
  {
    name: 'E2：把 SmartScreen 的说明从安装引导里删掉（用户看到"Windows 已保护你的电脑"就卡住）',
    edits: [
      {
        file: GUIDE_WIN,
        find: '### 1.1 安装包首次运行会被 SmartScreen 拦一下（正常现象）',
        replace: '### 1.1 安装包首次运行说明',
      },
    ],
    expect: ['W11'],
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
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        missing = true;
        continue;
      }
      fs.writeFileSync(e.file, txt.replace(e.find, e.replace));
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
