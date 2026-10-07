#!/usr/bin/env node
/**
 * 「公共组件抽离到 app/src/components/units/」结构断言 —— 且必须**可反证**。
 *
 * 为什么需要它：
 *   把一批组件搬进 `units/` 这件事，验收标准不是「文件建好了」，而是三件互不覆盖的
 *   事实同时成立——少任何一件，抽离就只是「看起来干净」：
 *
 *     LAYOUT   清单齐、旧路径消失、桶文件能解析 —— 少一个文件，调用点在打包时才炸。
 *     PURITY   单元不得依赖业务数据层（store/ipc/types/platform/@hooks/nav）
 *              —— 这是「该不该放 units」的**唯一硬判据**，靠人自觉必然漏。
 *              import 说明符同时覆盖**相对路径与路径别名**（@components/@music/@/…）：
 *              引用全面别名化之后，只认相对路径的判据等于对一半的 import 失明。
 *     NAMING   类名迁移到 `ui-` 前缀、历史中性名（.btn/.badge/...）不被顺手改名
 *              —— 命名写错不报错，只在视觉上悄悄错位。
 *     CALLERS  调用点真的从 units 引、且原文件不再重复定义那些控件
 *              —— 定义还在、import 也补了，会出现"两个 Select"，编译能过、行为看运气。
 *     KEEP     **反向**断言：没抽过头 —— 音乐语义件/设置页排版件/应用级组件必须留下。
 *              只断言"该走的走了"，会奖励把所有东西都搬进 units 的过度抽离。
 *
 *   因此本脚本逐组断言，并配一次可反证的破坏轮：破坏后对应断言**必须变红**，否则
 *   它测的不是它声称的东西（D-31：假阳性比没测试更危险）。
 *
 * 用法：
 *   node e2e/units-structure-check.mjs            正向跑（期望 LAYOUT/PURITY/NAMING/CALLERS/KEEP/HOOKS/ALIAS/STATE 全绿）
 *   node e2e/units-structure-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节恢复）
 *
 * 约束：纯 Node、零依赖；只读 `app/src/**`（--refute 轮临时破坏并保证按字节还原）。
 * 本脚本源码里刻意**不出现**任何被禁的历史品牌标识（需要提及时一律写「参考实现」）。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { readStyleSource } from "./_styles-source.mjs";
import { cachedReadText, cachedReadBytes, overrideFile, clearOverrides } from "./_file-cache.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "app");
const SRC = path.join(APP, "src");

const F = {
  units: path.join(SRC, "components", "units"),
  components: path.join(SRC, "components"),
  app: path.join(SRC, "App.tsx"),
  viteConfig: path.join(APP, "vite.config.ts"),
  tsconfig: path.join(APP, "tsconfig.json"),
  queueScreen: path.join(SRC, "screens", "QueueScreen.tsx"),
  rightPanel: path.join(SRC, "screens", "music", "RightPanel.tsx"),
  queueDrawer: path.join(SRC, "screens", "music", "QueueDrawer.tsx"),
  sections: path.join(SRC, "screens", "settings", "sections.tsx"),
  quitConfirm: path.join(SRC, "components", "QuitConfirm.tsx"),
  parts: path.join(SRC, "screens", "settings", "parts.tsx"),
  shared: path.join(SRC, "screens", "music", "shared.tsx"),
  loginModal: path.join(SRC, "screens", "music", "LoginModal.tsx"),
  legacyAtoms: path.join(SRC, "components", "atoms.tsx"),
  legacyVirtualList: path.join(SRC, "screens", "music", "VirtualList.tsx"),
  hooksDir: path.join(SRC, "hooks"),
  hooksFile: path.join(SRC, "hooks.ts"),
  hooksIndex: path.join(SRC, "hooks", "index.ts"),
  platformMenu: path.join(SRC, 'screens', 'music', 'PlatformMenu.tsx'),
  // ── 灵动岛（拍板第 4 项）
  island: path.join(SRC, 'components', 'DynamicIsland.tsx'),
  toastBus: path.join(SRC, 'toastBus.ts'),
  musicToast: path.join(SRC, 'screens', 'music', 'Toast.tsx'),
  // 断言读到的 s.appCss 是全分片拼接（见下方 readStyleSource 调用处）；
  // 下面这个 musicScss **只给反证机制用**（按 file 路径临时改源文件）。
  // 灵动岛的样式在 music.scss 里（.di-capsule 等），故反证指向它。
  musicScss: path.join(SRC, 'styles', 'music.scss'),
  stylesDir: path.join(SRC, 'styles'),
};

// ── 冻结的契约（负责人冻结，本脚本照抄，不改口径） ────────────────────────
/** units 目录应恰有的 11 个文件（多一个/少一个都判红；useEsc 已迁 src/hooks，D-41） */
const MANIFEST = [
  "atoms.tsx",
  "Select.tsx",
  "Switch.tsx",
  "Range.tsx",
  "Swatches.tsx",
  "ColorPicker.tsx",
  "IconButton.tsx",
  "PlayModeButton.tsx",
  "NumberInput.tsx",
  "Empty.tsx",
  "VirtualList.tsx",
  "index.ts",
];
/** 桶文件应统一出口的名字（useEsc 的出口在 @hooks/useEsc，不再经 units 桶） */
const BARREL_EXPORTS = [
  "Badge",
  "Btn",
  "Dot",
  "MagicCircle",
  "Pill",
  "ColorPicker",
  "Empty",
  "IconButton",
  "NumberInput",
  "Range",
  "Select",
  "Swatches",
  "Switch",
  "ROW_GAP",
  "ROW_H",
  "VirtualList",
];
/** src/hooks/ 应恰有的文件（hooks 唯一收口，D-41） */
const HOOKS_MANIFEST = ["index.ts", "useEsc.ts", "useCoverColor.ts", "useMusicHotkeys.ts"];
/** hooks/index.ts 业务桶应出口的业务 hook 名 */
const HOOKS_BARREL_EXPORTS = [
  "useService",
  "useTasks",
  "useLibrary",
  "useQuitRequest",
  "useToasts",
];
/** 允许被 units import 的裸包（其余裸包一律判红：新依赖需负责人确认） */
const PKG_ALLOW = [/^react(\/.+)?$/, /^react-dom(\/.+)?$/, /^lucide-react$/];
/** 允许的 scoped 包前缀 */
const PKG_ALLOW_SCOPE = ["@radix-ui/"];
/** 相对导入唯一允许"越出 units"的目标（theme/tokens 是设计令牌，纯数据）。
 *  对别名形式（`@/theme/tokens`）同样成立：正则只看"以 theme/tokens 结尾"。 */
const THEME_TOKENS_RE = /(^|\/)theme\/tokens(\.\w+)?$/;

/** 路径别名 → 真实目录（与 app/vite.config.ts、app/tsconfig.json **三处保持一致**）。
 *  前缀互不重叠（匹配要求「相等 或 前缀后紧跟 /」），'@tauri' 不会吃掉 '@tauri-apps/*' 包。 */
const ALIASES = {
  "@tauri": path.join(APP, "src-tauri"),
  "@components": path.join(SRC, "components"),
  "@screens": path.join(SRC, "screens"),
  "@music": path.join(SRC, "music"),
  "@hooks": path.join(SRC, "hooks"),
  "@": SRC,
};

/** 把 import 说明符解析为仓库内绝对路径；裸包（react、@radix-ui/…、@tauri-apps/…）返回 null */
function resolveSpec(baseDir, spec) {
  if (/^\.\.?(\/|$)/.test(spec)) return path.resolve(baseDir, spec);
  const keys = Object.keys(ALIASES).sort((a, b) => b.length - a.length); // 长前缀先试，防御性
  for (const k of keys) {
    if (spec === k) return ALIASES[k];
    if (spec.startsWith(k + "/"))
      return path.join(ALIASES[k], spec.slice(k.length + 1));
  }
  return null;
}

/** 调用点必须真的从 units 引 */
const CALLER_IMPORT_FILES = {
  "App.tsx": F.app,
  "screens/QueueScreen.tsx": F.queueScreen,
  "screens/music/RightPanel.tsx": F.rightPanel,
  "screens/music/QueueDrawer.tsx": F.queueDrawer,
  "screens/settings/sections.tsx": F.sections,
  "components/QuitConfirm.tsx": F.quitConfirm,
};

// ── 读文件 ───────────────────────────────────────────────────────────────
const readMaybe = cachedReadText;
const readBytes = cachedReadBytes;
const listFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

/**
 * 去掉 // 与 /\\* *\\/ 注释（带字符串状态机）——**必须在取字符串字面量/导入语句前先做**。
 *
 * 为什么要状态机而不是简单正则：units 文件的注释里就出现了带引号的片段，
 * 例如 Range.tsx 的注释写了 `` `.music-prog-bar` ``。若直接扫全文找 `music-`，
 * 注释会让 NAMING 断言在**完全合法**的源码上误红（这也是本类脚本最容易犯的假阳性）。
 */
function stripComments(src) {
  let out = "";
  let state = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "*") {
        state = "block";
        out += "  ";
        i++;
        continue;
      }
      if (c === "/" && c2 === "/") {
        state = "line";
        out += "  ";
        i++;
        continue;
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out += c;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out += "  ";
        i++;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += "\n";
        continue;
      }
      out += " ";
      continue;
    }
    // 字符串内：转义后整体保留
    if (c === "\\") {
      out += c + (c2 ?? "");
      i++;
      continue;
    }
    if (state === "sq" && c === "'") state = "code";
    else if (state === "dq" && c === '"') state = "code";
    else if (state === "tpl" && c === "`") state = "code";
    out += c;
  }
  return out;
}

/** 收集源码里全部字符串字面量的内容（注释已剔除，故不会误收注释里的引号片段） */
function stringLiterals(stripped) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of stripped.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** 把字符串字面量切成"类名样式"的 token（music-empty / ui-range-fill / btn …） */
function classTokens(stripped) {
  const set = new Set();
  for (const lit of stringLiterals(stripped)) {
    for (const m of lit.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) set.add(m[0]);
  }
  return set;
}

/** 收集源码里所有 `from '<spec>'` 与副作用 `import '<spec>'` 的模块说明符 */
function importSpecifiers(stripped) {
  const out = [];
  for (const m of stripped.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g))
    out.push(m[1]);
  for (const m of stripped.matchAll(/\bimport\s+['"]([^'"]+)['"]/g))
    out.push(m[1]);
  return out;
}

/** 是否"声明"了某顶层名字（function/const/let/var/class）—— 与参数名/变量名解耦 */
function declaresName(stripped, name) {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc(name)}\\b`,
  );
  return re.test(stripped);
}

/** 是否"导出"了某顶层名字 */
function exportsName(stripped, name) {
  const re = new RegExp(
    `(?:^|\\n)\\s*export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc(name)}\\b`,
  );
  return re.test(stripped);
}

const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 解析一个 import 说明符（相对或别名）是否命中真实文件 */
function resolvesToFile(baseDir, spec) {
  const p = resolveSpec(baseDir, spec);
  if (!p) return false;
  const cands = [
    p,
    `${p}.tsx`,
    `${p}.ts`,
    `${p}.jsx`,
    `${p}.js`,
    path.join(p, "index.tsx"),
    path.join(p, "index.ts"),
  ];
  return cands.some((c) => existsSync(c));
}

/** 某一 units 文件里出现的违规 import（越出 units 且非 theme/tokens，或非法裸包）。
 *  别名按 ALIASES 还原成真实路径后判定 —— 否则 '@music/store' 会被当成"未知裸包"，口径就错了。 */
function badImportsOf(absFile, text) {
  const stripped = stripComments(text);
  const dir = path.dirname(absFile);
  const bad = [];
  for (const spec of importSpecifiers(stripped)) {
    const resolved = resolveSpec(dir, spec);
    if (resolved != null) {
      const inside =
        resolved === F.units || resolved.startsWith(F.units + path.sep);
      if (!inside && !THEME_TOKENS_RE.test(spec)) bad.push(spec);
    } else {
      const ok =
        PKG_ALLOW.some((re) => re.test(spec)) || PKG_ALLOW_SAFE_SCOPE(spec);
      if (!ok) bad.push(spec);
    }
  }
  return bad;
}
const PKG_ALLOW_SAFE_SCOPE = (spec) =>
  PKG_ALLOW_SCOPE.some((p) => spec.startsWith(p));

// ── 载入快照 ─────────────────────────────────────────────────────────────
function loadSources() {
  const s = {};
  s.unitsDirMissing = !existsSync(F.units);
  s.unitsFiles = listFiles(F.units); // 全量（含非 ts 文件，便于抓"改名残留"）
  s.units = new Map(); // 仅 .ts/.tsx → 注释已剥 + 原文
  for (const name of s.unitsFiles) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const text = readMaybe(path.join(F.units, name));
    s.units.set(name, {
      raw: text,
      stripped: stripComments(text),
      abs: path.join(F.units, name),
    });
  }
  s.index = s.units.get("index.ts")?.raw ?? "";
  s.parts = readMaybe(F.parts);
  s.shared = readMaybe(F.shared);
  s.loginModal = readMaybe(F.loginModal);
  s.callers = Object.fromEntries(
    Object.entries(CALLER_IMPORT_FILES).map(([k, p]) => [k, readMaybe(p)]),
  );
  s.componentsFiles = listFiles(F.components);
  s.legacyAtomsExists = existsSync(F.legacyAtoms);
  s.legacyVirtualListExists = existsSync(F.legacyVirtualList);
  // hooks 收口（D-41）：目录清单 + 旧单文件必须不存在 + 业务桶原文
  s.hooksDirFiles = listFiles(F.hooksDir);
  s.hooksFileExists = existsSync(F.hooksFile);
  s.hooksIndex = readMaybe(F.hooksIndex);
  s.platformMenu = readMaybe(F.platformMenu);
  // 灵动岛（拍板第 4 项）
  s.island = readMaybe(F.island);
  s.toastBus = readMaybe(F.toastBus);
  s.musicToast = readMaybe(F.musicToast);
  // 全分片拼接（顺序 = index.scss 的 @use 顺序 = 层叠顺序）。
  // app.css 已按模块拆成六个分片，读单文件会集体变红（读不到 ≠ 真回归），故走拼接。
  s.appCss = readStyleSource(F.stylesDir);
  // STYLE（样式分层）：入口的 @use 声明 + 各分片剥注释后的代码 + 目录里实际存在的分片
  s.styleIndex = readMaybe(path.join(F.stylesDir, "index.scss"));
  s.styleShards = listFiles(F.stylesDir)
    .filter((f) => f.endsWith(".scss") && f !== "index.scss")
    .map((f) => f.replace(/\.scss$/, ""))
    .sort();
  s.styleShardCode = {};
  for (const f of listFiles(F.stylesDir).filter((f) => f.endsWith(".scss"))) {
    s.styleShardCode[f] = stripComments(readMaybe(path.join(F.stylesDir, f)));
  }
  // ALIAS（D-40）：两处别名声明 + 全 src 的"相对上跳"引用
  s.viteConfig = readMaybe(F.viteConfig);
  s.tsconfig = readMaybe(F.tsconfig);
  s.srcRelativeUp = [];
  // STATE（D-42）：全 src 的 React Context 用法
  s.srcReactContext = [];
  // ALIAS：误用 @tauri/… 别名的 import（前端不该 import src-tauri；多为把 @tauri-apps/* 写错）
  s.srcTauriAliasSpecs = [];
  // STATE：zustand 引用（证明状态库确实是 zustand，而不是"没 Context 也没 store"）
  s.srcZustandImports = [];
  // HOOKS：全 src 里 use* 命名的文件若不在 hooks/ 内即违规（D-41）
  s.srcMisplacedHooks = [];
  // 需要全量扫描的三件事：旧位置深引 useEsc / 相对上跳引用 / React Context
  s.srcUnitsEscImports = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = path.relative(ROOT, p);
        const st = stripComments(readMaybe(p));
        for (const spec of importSpecifiers(st)) {
          if (/units\/useEsc$/.test(spec)) s.srcUnitsEscImports.push(`${rel} → ${spec}`);
          // 相对上跳：'..' 或 '../...'。同目录 './x' 是允许的（见《09》§2.3.1）
          if (/^\.\.(\/|$)/.test(spec)) s.srcRelativeUp.push(`${rel} → ${spec}`);
          // 注意正则：'@tauri-apps/…' 不含 '@tauri/'，故不会误报（npm 包与别名必须区分开）
          if (/^@tauri\//.test(spec)) s.srcTauriAliasSpecs.push(`${rel} → ${spec}`);
          if (spec === "zustand") s.srcZustandImports.push(rel);
        }
        if (/\b(?:createContext|useContext)\s*\(/.test(st)) s.srcReactContext.push(rel);
        // use* 命名的文件必须住在 src/hooks/ 内（否则 D-41 只是句口号）
        if (/^use[A-Z]/.test(e.name) && path.basename(dir) !== 'hooks') s.srcMisplacedHooks.push(rel);
      }
    }
  };
  walk(SRC);
  return s;
}

// ── 断言表 ───────────────────────────────────────────────────────────────
const A = [];
const add = (id, group, run) => A.push({ id, group, run });

// ============================ LAYOUT ============================
add("LAYOUT.files", "LAYOUT", (s) => {
  if (s.unitsDirMissing)
    return { ok: false, detail: `目录不存在：${path.relative(ROOT, F.units)}` };
  const got = new Set(s.unitsFiles);
  const want = new Set(MANIFEST);
  const missing = MANIFEST.filter((n) => !got.has(n));
  const extra = s.unitsFiles.filter((n) => !want.has(n));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: [
      missing.length ? `缺件：${missing.join(", ")}` : "",
      extra.length ? `多余：${extra.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("；"),
  };
});

add("LAYOUT.barrelResolves", "LAYOUT", (s) => {
  const idx = s.units.get("index.ts");
  if (!idx) return { ok: false, detail: "units/index.ts 缺失，无法校验桶文件" };
  const specs = [
    ...stripComments(idx.raw).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  const broken = specs.filter((sp) => !resolvesToFile(F.units, sp));
  return {
    ok: specs.length > 0 && broken.length === 0,
    detail: broken.length
      ? `桶文件指向不存在的模块：${broken.join(", ")}`
      : specs.length
        ? ""
        : "桶文件没有任何 re-export",
  };
});

add("LAYOUT.barrelExports", "LAYOUT", (s) => {
  const idx = s.units.get("index.ts")?.raw ?? "";
  const named = [
    ...stripComments(idx).matchAll(
      /export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g,
    ),
  ]
    .map((m) => m[1])
    .join(",");
  const missing = BARREL_EXPORTS.filter(
    (n) => !new RegExp(`\\b${esc(n)}\\b`).test(named),
  );
  return {
    ok: missing.length === 0,
    detail: missing.length ? `桶文件未出口：${missing.join(", ")}` : "",
  };
});

add("LAYOUT.legacyAbsent", "LAYOUT", (s) => {
  const alive = [];
  if (s.legacyAtomsExists) alive.push("components/atoms.tsx");
  if (s.legacyVirtualListExists) alive.push("screens/music/VirtualList.tsx");
  return {
    ok: alive.length === 0,
    detail: alive.length
      ? `旧路径未删除（不保留兼容再导出）：${alive.join("、")}`
      : "",
  };
});

// ============================ PURITY ============================
add("PURITY.noBusinessImports", "PURITY", (s) => {
  if (s.unitsDirMissing) return { ok: false, detail: "units 目录不存在" };
  const offenders = [];
  for (const [name, u] of s.units) {
    const bad = badImportsOf(u.abs, u.raw);
    if (bad.length) offenders.push(`${name} → ${bad.join(", ")}`);
  }
  return {
    ok: offenders.length === 0,
    detail: offenders.length
      ? `units 文件 import 了业务数据层（硬判据）：${offenders.join("；")}`
      : "",
  };
});

// ============================ NAMING ============================
add("NAMING.noMusic", "NAMING", (s) => {
  const hits = [];
  for (const [name, u] of s.units) {
    for (const t of classTokens(u.stripped))
      if (t.startsWith("music-")) hits.push(`${name}:${t}`);
  }
  return {
    ok: hits.length === 0,
    detail: hits.length ? `units 类名仍带 music- 前缀：${hits.join(", ")}` : "",
  };
});

add("NAMING.noSet", "NAMING", (s) => {
  const hits = [];
  for (const [name, u] of s.units) {
    for (const t of classTokens(u.stripped))
      if (t.startsWith("set-")) hits.push(`${name}:${t}`);
  }
  return {
    ok: hits.length === 0,
    detail: hits.length ? `units 类名仍带 set- 前缀：${hits.join(", ")}` : "",
  };
});

add("NAMING.uiPrefix", "NAMING", (s) => {
  const want = [
    "ui-select",
    "ui-select-menu",
    "ui-select-item",
    "ui-select-ico",
    "ui-select-ok",
    "ui-range",
    "ui-range-val",
    "ui-num",
    "ui-num-suffix",
    "ui-swatch",
    "ui-swatches",
    "ui-color",
    "ui-cbtn",
    "ui-empty",
    "ui-vlist",
    "ui-vlist-inner",
    "ui-vlist-item",
  ];
  const all = new Set();
  for (const [, u] of s.units)
    for (const t of classTokens(u.stripped)) all.add(t);
  const missing = want.filter((t) => !all.has(t));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `units 未出现约定的 ui- 类名：${missing.join(", ")}`
      : "",
  };
});

add("NAMING.neutralKept", "NAMING", (s) => {
  const want = ["btn", "badge", "pill", "dot", "magic", "switch"];
  const all = new Set();
  for (const [, u] of s.units)
    for (const t of classTokens(u.stripped)) all.add(t);
  const missing = want.filter((t) => !all.has(t));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `历史中性类名被改名/丢失：${missing.join(", ")}`
      : "",
  };
});

// ============================ CALLERS ============================
add("CALLERS.partsNoControls", "CALLERS", (s) => {
  const st = stripComments(s.parts);
  const banned = ["Select", "Range", "Switch", "Swatches", "ColorPicker"];
  const still = banned.filter((n) => declaresName(st, n));
  return {
    ok: still.length === 0,
    detail: still.length
      ? `settings/parts.tsx 仍在定义控件：${still.join(", ")}`
      : "",
  };
});

add("CALLERS.sharedNoUnits", "CALLERS", (s) => {
  const st = stripComments(s.shared);
  const banned = ["IconButton", "Empty", "useEsc"];
  const still = banned.filter((n) => declaresName(st, n));
  return {
    ok: still.length === 0,
    detail: still.length
      ? `music/shared.tsx 仍在定义 units 件：${still.join(", ")}`
      : "",
  };
});

add("CALLERS.importsUnits", "CALLERS", (s) => {
  const missing = [];
  for (const [label, text] of Object.entries(s.callers)) {
    if (!/(?:from|import)\s+['"][^'"]*units['"]/.test(stripComments(text)))
      missing.push(label);
  }
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `这些调用点未从 units 引：${missing.join("、")}`
      : "",
  };
});

add("CALLERS.loginNoRawCbtn", "CALLERS", (s) => {
  const has = s.loginModal.includes("music-cbtn");
  return {
    ok: !has,
    detail: has ? "LoginModal.tsx 又出现绕过组件直接写的 music-cbtn 类名" : "",
  };
});

// ============================ KEEP（反向：没抽过头） ============================
add("KEEP.sharedExports", "KEEP", (s) => {
  const st = stripComments(s.shared);
  const need = ["SongRow", "Cover"];
  const missing = need.filter((n) => !exportsName(st, n));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `music/shared.tsx 丢了音乐语义件：${missing.join(", ")}（抽过头）`
      : "",
  };
});

add("KEEP.partsExports", "KEEP", (s) => {
  const st = stripComments(s.parts);
  const need = ["Row", "PendingRow"];
  const missing = need.filter((n) => !exportsName(st, n));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `settings/parts.tsx 丢了设置页排版件：${missing.join(", ")}（抽过头）`
      : "",
  };
});

add("KEEP.appComponents", "KEEP", (s) => {
  const need = [
    "Sidebar.tsx",
    "Toolbar.tsx",
    "ViewTabs.tsx",
    "QuitConfirm.tsx",
  ];
  const missing = need.filter((n) => !s.componentsFiles.includes(n));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `components/ 丢了应用级组件：${missing.join(", ")}（不该进 units）`
      : "",
  };
});

// ============================ HOOKS（src/hooks 唯一收口，D-41） ============================
add("HOOKS.layout", "HOOKS", (s) => {
  if (!existsSync(F.hooksDir))
    return { ok: false, detail: "src/hooks/ 目录不存在" };
  const got = new Set(s.hooksDirFiles);
  const want = new Set(HOOKS_MANIFEST);
  const missing = HOOKS_MANIFEST.filter((n) => !got.has(n));
  const extra = s.hooksDirFiles.filter((n) => !want.has(n));
  const legacy = s.hooksFileExists
    ? "src/hooks.ts 旧单文件仍存在 —— 与 hooks/ 并存时 TS/Vite 的模块解析会静默二选一"
    : "";
  return {
    ok: missing.length === 0 && extra.length === 0 && !s.hooksFileExists,
    detail: [
      missing.length ? `缺件：${missing.join(", ")}` : "",
      extra.length ? `多余：${extra.join(", ")}` : "",
      legacy,
    ]
      .filter(Boolean)
      .join("；"),
  };
});

add("HOOKS.barrelExports", "HOOKS", (s) => {
  const st = stripComments(s.hooksIndex);
  const missing = HOOKS_BARREL_EXPORTS.filter((n) => !exportsName(st, n));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `hooks/index.ts 业务桶丢了 hook：${missing.join(", ")}（App.tsx 在 import，丢了编译才炸）`
      : "",
  };
});

add("HOOKS.callers", "HOOKS", (s) => {
  const st = stripComments(s.platformMenu);
  const okImport = /from\s+['"]@hooks\/useEsc['"]/.test(st);
  const stale = s.srcUnitsEscImports;
  return {
    ok: okImport && stale.length === 0,
    detail: [
      okImport ? "" : "PlatformMenu 未从 @hooks/useEsc 引 useEsc",
      stale.length ? `仍有文件从旧位置深引 useEsc：${stale.join("；")}` : "",
    ]
      .filter(Boolean)
      .join("；"),
  };
});

add("HOOKS.noMisplacedUse", "HOOKS", (s) => {
  // 判据：文件名以 use + 大写字母开头的文件必须住在 src/hooks/ 内。
  // 这条是**补出来**的 —— 上一轮收口只迁了 useEsc，漏了 screens/music/useCoverColor.ts，
  // 而原有三条 HOOKS 断言只认"已迁移的那个"，对新长出来的 hook 完全失明。
  const bad = s.srcMisplacedHooks;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `这些 use* 文件不在 src/hooks/ 内：${bad.join("、")}（D-41：use* 一律住 hooks，否则同一个概念会被两处持有）`
      : "",
  };
});

// ============================ ALIAS（路径别名与引用规范，D-40） ============================
/**
 * 从 `vite.config.ts` 抽别名键 —— 形如 `"@hooks": aliasPath("./src/hooks")`。
 *
 * 为什么用正则而不是 eval/import 配置：配置是 TS，脚本要零依赖、且不该执行构建配置。
 * 正则只认"键 + aliasPath(" 这一种写法 —— 换写法会让断言变红（提示同步脚本），
 * 这比"静默漏检"好：**断言宁可因为写法变化而红，也不要因为认不出而绿**。
 */
function viteAliasKeys(text) {
  return [
    ...new Set(
      [...stripComments(text).matchAll(/["'](@[a-zA-Z0-9_-]*)["']\s*:\s*aliasPath\(/g)].map(
        (m) => m[1],
      ),
    ),
  ];
}

/** 从 `tsconfig.json` 的 compilerOptions.paths 抽键并归一化（`@x/*` 与 `@x` 是同一别名） */
function tsAliasKeys(text) {
  const block = text.match(/"paths"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return [];
  return [
    ...new Set(
      [...block[1].matchAll(/["'](@[a-zA-Z0-9_/-]*)["']\s*:/g)].map((m) => m[1].replace(/\/\*$/, "")),
    ),
  ];
}

/** 契约：六个别名（《09》§2.3.1） */
const ALIAS_KEYS = ["@", "@tauri", "@components", "@screens", "@music", "@hooks"];

add("ALIAS.keysComplete", "ALIAS", (s) => {
  const vite = viteAliasKeys(s.viteConfig);
  const ts = tsAliasKeys(s.tsconfig);
  const missV = ALIAS_KEYS.filter((k) => !vite.includes(k));
  const missT = ALIAS_KEYS.filter((k) => !ts.includes(k));
  return {
    ok: missV.length === 0 && missT.length === 0,
    detail: [
      missV.length ? `vite.config.ts 缺：${missV.join("、")}` : "",
      missT.length ? `tsconfig.json 缺：${missT.join("、")}` : "",
    ]
      .filter(Boolean)
      .join("；"),
  };
});

add("ALIAS.twoPlaceSync", "ALIAS", (s) => {
  const vite = new Set(viteAliasKeys(s.viteConfig));
  const ts = new Set(tsAliasKeys(s.tsconfig));
  const onlyVite = [...vite].filter((k) => !ts.has(k));
  const onlyTs = [...ts].filter((k) => !vite.has(k));
  return {
    ok: onlyVite.length === 0 && onlyTs.length === 0,
    detail:
      onlyVite.length || onlyTs.length
        ? `两处不同步 —— 仅 vite 有：${onlyVite.join("、") || "无"}；仅 tsconfig 有：${onlyTs.join("、") || "无"}（少改一处是**静默漂移**：dev 能跑 build 报错，或编辑器报红但能跑）`
        : "",
  };
});

add("ALIAS.subPathMaps", "ALIAS", (s) => {
  /*
   * 每个别名在 tsconfig 里必须**同时**声明 `@x` 与 `@x/*` 两条：
   * 只有精确项 → `@music/store` 解析不到；只有通配项 → 裸 `@music` 解析不到。
   * 缺哪条都要等某处 import 恰好踩中才暴露，故静态断死。
   *
   * 这条是**反证轮逼出来的**：原本设计的破坏是"删 tsconfig 的 `@music/*` 一行"，
   * 结果两条断言都没红 —— 因为 `@music` 精确项还在，别名确实仍存在。
   * 那次"假阳性"不是断言错，而是**破坏没做到位**；但它顺带暴露了真实缺口：
   * 只删通配项这种**配置退化**当时无人拦（要等 tsc 才炸）。于是补上本条。
   *
   * ⚠️ vite 侧不需要对应断言：vite 的 alias 是**前缀匹配**，天然覆盖子路径；
   * 而 TS 的 `paths` 是**逐条精确匹配**，必须两条都写。这个差异是别名最容易踩的坑。
   */
  const block = s.tsconfig.match(/"paths"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return { ok: false, detail: "tsconfig.json 里找不到 compilerOptions.paths" };
  const hits = [...block[1].matchAll(/["'](@[a-zA-Z0-9_-]*)(\/\*)?["']\s*:/g)];
  const exact = new Set(hits.filter((m) => !m[2]).map((m) => m[1]));
  const wild = new Set(hits.filter((m) => m[2]).map((m) => m[1]));
  const missing = ALIAS_KEYS.filter((k) => !exact.has(k) || !wild.has(k));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `这些别名在 tsconfig 里缺项：${missing
          .map((k) => `${k}${exact.has(k) ? "" : "（缺精确项）"}${wild.has(k) ? "" : "（缺 @${k.slice(1)}/* 通配项）"}`)
          .join("、")} —— 缺哪一侧，那一类 import 就解析不到`
      : "",
  };
});

add("ALIAS.noRelativeUp", "ALIAS", (s) => {
  const bad = s.srcRelativeUp;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `app/src 内仍有相对上跳引用（应写别名；同目录 './' 允许）：${bad.slice(0, 5).join("；")}${bad.length > 5 ? ` …共 ${bad.length} 处` : ""}`
      : "",
  };
});

add("ALIAS.pkgNotShadowed", "ALIAS", (s) => {
  // 别名 `@tauri`（→ src-tauri，预留）与 npm 包 `@tauri-apps/*` 字形极近。
  // 判据刻意不用"包引用数 > 0"：那种只数总量，单个文件被改错时测不出来。
  // 改为——**前端不得出现 `@tauri/…` 的 import**：它要么是把 `@tauri-apps/api/core`
  // 误写成 `@tauri/api/core`，要么是前端越界 import Rust 目录，两种都是错的。
  const bad = s.srcTauriAliasSpecs;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `前端出现了 @tauri/… 的 import：${bad.join("；")} —— 别名 @tauri 指向 src-tauri（前端不该 import 它）；是不是把 npm 包 @tauri-apps/* 写错了？`
      : "",
  };
});

// ============================ STATE（状态管理统一 zustand，D-42） ============================
add("STATE.noReactContext", "STATE", (s) => {
  const bad = s.srcReactContext;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `这些文件用了 React Context：${bad.join("、")} —— 跨组件共享状态一律 zustand（Context 里的 state 在 provider 之外读不到，而播放内核/IPC 回调都在组件树外改状态）`
      : "",
  };
});

add("STATE.zustandInUse", "STATE", (s) => {
  // 反向兜底：只断言"没有 Context"是不够的 —— 把 store 换成别的东西（或删掉）
  // 也会让上一条变绿，而"统一 zustand"这条规则其实已经不成立。
  const n = s.srcZustandImports.length;
  return {
    ok: n > 0,
    detail: n ? "" : "全 src 未发现 zustand 引用 —— 状态管理约定（D-42）已不成立",
  };
});

// ============================ ISLAND（灵动岛 · 拍板第 4 项）============================
// 灵动岛要防的是「两套提示并存」与「退场动画时长两处不一致」——
// 两者都不报错，只是用户看到同一条提示出现两次或胶囊突然消失。
/** App.tsx 原文（多处断言要用，故提到组级作用域） */
const appSourceOf = (s) => stripComments(s.callers['App.tsx'] ?? '');

add('ISLAND.mountedAtRoot', 'ISLAND', (s) => {
  if (!s.island) return { ok: false, detail: 'components/DynamicIsland.tsx 不存在' };
  const appSrc = appSourceOf(s);
  // ⚠️ 必须判「**真的渲染了**」，不能只判「出现过 DynamicIsland」——
  // 只判字面量时，删掉 JSX 节点但留着 import 行仍为真（反证轮实测假阳性）。
  // 判据取 JSX 自闭合标签形态 `<DynamicIsland` + `/>`。
  if (!/<DynamicIsland\s*\/>/.test(appSrc))
    return { ok: false, detail: 'App.tsx 未真正渲染 <DynamicIsland />（可能只剩 import）' };
  return { ok: true, detail: '' };
});
add('ISLAND.singleSource', 'ISLAND', (s) => {
  // ⚠️ 本条是本组最关键的一条：原先 App 与 MusicScreen 各有一份 toast 队列
  //（useState 每次调用各得一份），灵动岛只订阅其中一份 → 另一份推的提示永远收不到。
  // 反过来若两处都自己渲染，同一条提示会**出现两次**。
  if (!s.toastBus) return { ok: false, detail: 'src/toastBus.ts 不存在' };
  const bus = stripComments(s.toastBus);
  const hooks = stripComments(s.hooksIndex);
  const missing = [];
  if (!/toastBus/.test(hooks)) missing.push('hooks/useToasts 未转发到 toastBus');
  // 旧的两处渲染层必须都已撤掉
  if (/className="toasts"/.test(appSourceOf(s)))
    missing.push('App 仍在渲染 .toasts（旧层未撤）');
  if (/<div className=\{musicToast/.test(stripComments(s.musicToast ?? '')))
    missing.push('music/Toast 仍在自己渲染（会与灵动岛重复）');
  // 反向兜底：总线必须真的只有一个队列实现（防止有人另起一套 state 又忘了接）。
  // ⚠️ 判据不锁 `const`/`let` —— 单例队列需要**可变**绑定，写成 `const queue` 会在
  // 合法实现（`let queue`）上误红。与变量声明形式解耦，只认"有队列 + 有订阅"。
  if (!/\bqueue\b\s*(:|=)/.test(bus) || !/\bsubscribe\b/.test(bus))
    missing.push('toastBus 不是单例队列实现（缺少队列或 subscribe）');
  return { ok: missing.length === 0, detail: missing.length ? `吐司单一事实源：${missing.join('、')}` : '' };
});
add('ISLAND.musicToastForwards', 'ISLAND', (s) => {
  // 音乐屏那套必须**转发**并清空源 store，否则同一条被灵动岛与它各渲染一次
  if (!s.musicToast) return { ok: false, detail: 'screens/music/Toast.tsx 不存在' };
  const t = stripComments(s.musicToast);
  const missing = [];
  if (!/toastBus/.test(t)) missing.push('未转发到 toastBus');
  if (!/clearToast/.test(t)) missing.push('转发后未清空 musicToast（会重复渲染）');
  if (/<div/.test(t)) missing.push('仍在渲染 DOM');
  return { ok: missing.length === 0, detail: missing.length ? `music/Toast 转发：${missing.join('、')}` : '' };
});
add('ISLAND.leaveDurationSync', 'ISLAND', (s) => {
  // 退场时长两处必须一致：CSS 的 .di-capsule.is-leaving 0.26s ↔ TS 的 setTimeout 260ms。
  // 早退 → 看不见收尾；晚退 → 胶囊悬着不走。
  const css = stripComments(s.appCss ?? '');
  const ts = stripComments(s.island ?? '');
  // ⚠️ 时长写在 **.di-capsule 的 transition 简写里**，不在 .is-leaving 块内
  //（.is-leaving 只改 transform/opacity）。所以要从 .di-capsule 上取。
  const mCss = css.match(/\.di-capsule\s*\{[^}]*?transition:[^;]*?(\d*\.?\d+)s/);
  const mTs = ts.match(/setTimeout\([\s\S]*?,\s*(\d+)\s*\)/);
  if (!mCss) return { ok: false, detail: '样式里找不到 .di-capsule.is-leaving 的 transition 时长' };
  if (!mTs) return { ok: false, detail: 'DynamicIsland.tsx 找不到退场的 setTimeout' };
  const cssS = Math.round(parseFloat(mCss[1]) * 1000);
  const tsMs = Number(mTs[1]);
  return {
    ok: cssS === tsMs,
    detail: cssS === tsMs ? '' : `退场时长不一致：CSS ${mCss[1]}s(${cssS}ms) ↔ TS ${tsMs}ms`,
  };
});
add('ISLAND.idleRendersNothing', 'ISLAND', (s) => {
  // 无提示且无播放时**不占位** —— 空气里挂个空胶囊比不显示更怪
  if (!s.island) return { ok: false, detail: 'DynamicIsland.tsx 不存在' };
  const isl = stripComments(s.island);
  if (!/if \(!toast && !hasQueue\) return null/.test(isl))
    return { ok: false, detail: '空闲态未早退（会一直挂着一个空胶囊）' };
  return { ok: true, detail: '' };
});
add('ISLAND.toastExpandKeepsContent', 'ISLAND', (s) => {
  // 用户 2026-10-07 报：「hover 上去看着有个动画，然后消息内容就看不见了」。
  //
  // 根因：`playExpand` **无条件** `setContentOn(false)`。音乐卡展开态有**另一套**内容
  // （大卡：封面/歌名位移过去，折叠态的波形与名字让位），淡出折叠内容是对的；
  // 而普通提示的展开态**没有第二套内容** —— 它只是把胶囊从自然宽放宽到 320，
  // 让 `.di-title` 的 max-width 从 176 涨到 236 从而露出被裁掉的后半句（见 music.scss）。
  // 对提示也淡出，等于把标题连关闭键一起抹成透明，而底下无人补位 ⇒ 「字没了」。
  //
  // 判据：`playExpand` 段内，`setContentOn(false)` **只能**出现在 `t.kind === 'music'` 的分支里。
  // 必须先 stripComments：本文件的注释里主动写出了 `setContentOn(false)` 来解释这个坑，
  // 不剥注释会把注释算成命中（断言测到注释 = 假阳性）。
  if (!s.island) return { ok: false, detail: 'DynamicIsland.tsx 不存在' };
  const isl = stripComments(s.island);
  const from = isl.indexOf('const playExpand = useCallback(');
  const to = isl.indexOf('const playCollapse', from);
  const seg = from >= 0 && to > from ? isl.slice(from, to) : '';
  if (!seg) return { ok: false, detail: '未定位到 playExpand 段' };
  const guarded = /if \(t\.kind === 'music'\) setContentOn\(false\);/.test(seg);
  const fades = [...seg.matchAll(/setContentOn\(false\)/g)].length;
  return {
    ok: guarded && fades === 1,
    detail:
      guarded && fades === 1
        ? ''
        : `playExpand 对提示也淡出内容（hover 后字消失）：guarded=${guarded} setContentOn(false)×${fades}`,
  };
});

// ══════════════════════════════════════════════════════════════════════════
// STYLE —— 样式分层（app.css 拆成 base/app/manga/settings/components/music 六个分片）
// ══════════════════════════════════════════════════════════════════════════
// 这一组防的是「样式慢慢又长回一个文件 / 放错分片 / 开始用 SCSS 语法」这三类退化。
// 之所以要有它们：app.css 曾是 3716 行单文件，拆完之后**没有任何机制**阻止它重新膨胀 ——
// 没人会主动去翻六个文件看新样式该放哪，于是默认答案永远是"加到最大的那个文件里"。
//
// 判据一律先 stripComments：本组多条规则在注释里主动写出了被禁的写法
// （如 index.scss 解释「不用 SCSS 嵌套」时提到 mixin 与 &，components.scss 注释里
// 提到 .set-row），不剥注释会恒红 —— 而恒红比恒绿更隐蔽（它看起来像"覆盖到位"）。

/** 约定的 @use 顺序。**顺序即层叠**：同特异性下靠后定义者胜，改它等于改视觉结果。 */
const STYLE_USE_ORDER = ["base", "app", "manga", "settings", "components", "music"];

/** 从 index.scss 取出 @use 目标（去扩展名），剥注释以免举例被当真声明 */
function useList(indexSrc) {
  const code = stripComments(indexSrc || "");
  return [...code.matchAll(/@use\s+['"]([^'"]+)['"]/g)].map((m) => m[1].replace(/\.scss$/, ""));
}

add("STYLE.shardsRegistered", "STYLE", (s) => {
  // 双向一致：目录里存在的分片必须被 @use；@use 声明的也必须真实存在。
  // 只查单向会漏 ——「新建了分片但忘了在入口注册」是**最可能发生的错**（文件在、样式不生效），
  // 而「注册了但文件不存在」连构建都过不了，readStyleSource 也会当场抛错。
  const declared = useList(s.styleIndex);
  const onDisk = s.styleShards || [];
  const missing = [];
  for (const f of onDisk) {
    if (!declared.includes(f)) missing.push(`${f}.scss 未在 index.scss 的 @use 里注册（文件在、样式不生效）`);
  }
  for (const d of declared) {
    if (!onDisk.includes(d)) missing.push(`index.scss @use 了 '${d}'，但 styles/ 下没有 ${d}.scss`);
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join("；") : "" };
});

add("STYLE.useOrder", "STYLE", (s) => {
  // @use 顺序必须等于约定顺序。这条是**层叠正确性**的守卫：当前顺序与拆分前
  // app.css 的分区顺序逐段对齐，所以拆分不改变层叠语义；一旦调换，语义即变。
  const declared = useList(s.styleIndex);
  if (declared.length !== STYLE_USE_ORDER.length || declared.some((d, i) => d !== STYLE_USE_ORDER[i])) {
    return {
      ok: false,
      detail: `@use 顺序被改：实际 ${declared.join(" → ")}，约定 ${STYLE_USE_ORDER.join(" → ")}（顺序即层叠）`,
    };
  }
  return { ok: true, detail: "" };
});

add("STYLE.entryIsScss", "STYLE", (s) => {
  // 入口只许 @use .scss。旧 app.css / base.css 若复活并被引回入口，分层就名存实亡。
  const code = stripComments(s.styleIndex || "");
  const bad = [...code.matchAll(/@use\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((t) => !t.endsWith(".scss"));
  return {
    ok: bad.length === 0,
    detail: bad.length ? `index.scss 引用了非 .scss：${bad.join("、")}（旧的 app.css/base.css 不该复活）` : "",
  };
});

add("STYLE.shardOwnership", "STYLE", (s) => {
  // 单向禁列表：某分片里**绝不该出现**别的模块的强专属前缀。
  // 为什么只禁这几个、且只单向：既有实现里存在合法跨模块组合 ——
  // music.scss 有 `.di-… .ui-cbtn`（灵动岛里的公共按钮）、components.scss 有
  // `.set-row / .set-state`（设置页专用但由 units 组件实现）。双向禁会误报它们。
  // 反向自查已验证：把另一分片喂进来均会报红，判据确实能抓住放错。
  const FORBID = {
    "manga.scss": [/\.music-/, /\.di-/, /\.pf-/, /\.ac-/, /\.sk-/, /\.skin-/, /\.kara-/, /\.viewtab/],
    "music.scss": [/\.qt-/, /\.lib-/, /\.notready/, /\.logbox/, /\.magic-/, /\.compare-/, /\.dropzone/, /\.filelist/],
    "settings.scss": [/\.music-/, /\.di-/, /\.qt-/, /\.lib-/, /\.viewtab/],
    "app.scss": [/\.music-/, /\.di-/, /\.qt-/, /\.lib-/, /\.set-/, /\.settings/],
    "components.scss": [/\.music-/, /\.di-/, /\.qt-/, /\.lib-/],
  };
  const hits = [];
  for (const [file, pats] of Object.entries(FORBID)) {
    const code = (s.styleShardCode || {})[file];
    if (code === undefined) {
      hits.push(`${file} 不存在（分片缺失）`);
      continue;
    }
    for (const p of pats) {
      const m = code.match(p);
      if (m) {
        const line = code.slice(0, code.indexOf(m[0])).split("\n").length;
        hits.push(`${file}:${line} 含他模块选择器 ${m[0]}`);
      }
    }
  }
  return { ok: hits.length === 0, detail: hits.length ? hits.join("；") : "" };
});

add("STYLE.noScssSyntax", "STYLE", (s) => {
  // 分片内保持**扁平写法**：本阶段不用 SCSS 语法糖。
  // 理由不是审美，是断言：本仓检查脚本大量用 `[^}]*` 取块，嵌套会改变块结构 →
  // 判据静默失效或恒红。（开 nesting 的前置条件是给脚本装 SCSS AST 解析器，
  //  留待后续单独评估 —— 见 docs/style-scss-plan.md。）
  // 同时禁 SCSS 变量承载颜色：令牌只走 var(--md-*)，否则「深色模式只换变量」不成立。
  const hits = [];
  for (const [file, code] of Object.entries(s.styleShardCode || {})) {
    const mixin = code.match(/@(mixin|include)\b/g);
    if (mixin) hits.push(`${file} 用了 @${mixin[0].slice(1)}`);
    const svar = code.match(/\$[a-zA-Z_][\w-]*\s*:/g);
    if (svar) hits.push(`${file} 用了 SCSS 变量 ${svar[0].trim()}（令牌只走 var(--md-*)）`);
    const amp = code.match(/(^|[{,\n])\s*&(?![\w-])/m);
    if (amp) hits.push(`${file} 用了嵌套选择器 &`);
  }
  return { ok: hits.length === 0, detail: hits.length ? hits.join("；") : "" };
});

// ── 执行器 ────────────────────────────────────────────────────────────────
function runAll(s, ids) {
  const res = {};
  for (const a of A) {
    if (ids && !ids.includes(a.id)) continue;
    try {
      const r = a.run(s);
      res[a.id] = { ok: !!r.ok, detail: r.detail || "" };
    } catch (e) {
      res[a.id] = { ok: false, detail: `断言抛错：${e.message}` };
    }
  }
  return res;
}

const GROUPS = ["LAYOUT", "PURITY", "NAMING", "CALLERS", "KEEP", "HOOKS", "ALIAS", "STATE", "ISLAND", "STYLE"];
function printGrouped(res) {
  let pass = 0;
  let fail = 0;
  for (const g of GROUPS) {
    const items = A.filter((a) => a.group === g);
    if (!items.length) continue;
    const gp = items.filter((a) => res[a.id].ok).length;
    console.log(`\n【${g}】 ${gp}/${items.length}`);
    for (const a of items) {
      const r = res[a.id];
      if (r.ok) {
        pass++;
        console.log(`  ✓ ${a.id}`);
      } else {
        fail++;
        console.log(`  ✗ ${a.id}${r.detail ? `\n      ${r.detail}` : ""}`);
      }
    }
  }
  return { pass, fail };
}

// ── 反证用例 ──────────────────────────────────────────────────────────────
// 三种破坏动作：edit（改文本）/ rename（改名，模拟清单缺件）/ create（复活旧路径）
const MUTATIONS = [
  {
    name: "把 units/VirtualList.tsx 改名（模拟清单缺件）",
    from: F.units + "/VirtualList.tsx",
    to: F.units + "/VirtualList.bak",
    expect: ["LAYOUT.files", "LAYOUT.barrelResolves"],
  },
  {
    name: "往 units/Empty.tsx 顶部注入业务 store import",
    file: F.units + "/Empty.tsx",
    find: "import type { ReactNode } from 'react';",
    replace:
      "import { useMusicStore } from '../../music/store';\nimport type { ReactNode } from 'react';",
    expect: ["PURITY.noBusinessImports"],
  },
  {
    name: "往 units/Select.tsx 注入根 types import（另一条被禁来源）",
    file: F.units + "/Select.tsx",
    find: "import * as RSelect from '@radix-ui/react-select';",
    replace:
      "import type { SongLike } from '../types';\nimport * as RSelect from '@radix-ui/react-select';",
    expect: ["PURITY.noBusinessImports"],
  },
  {
    name: "往 units/Range.tsx 注入别名形式的业务 store import（@music/store）",
    file: F.units + "/Range.tsx",
    find: "import type { CSSProperties } from 'react';",
    replace:
      "import { useMusicStore } from '@music/store';\nimport type { CSSProperties } from 'react';",
    expect: ["PURITY.noBusinessImports"],
  },
  {
    name: "往 units/IconButton.tsx 注入别名形式的根类型 import（@/types）",
    file: F.units + "/IconButton.tsx",
    find: "import type { MouseEvent, ReactNode } from 'react';",
    replace:
      "import type { TaskRow } from '@/types';\nimport type { MouseEvent, ReactNode } from 'react';",
    expect: ["PURITY.noBusinessImports"],
  },
  {
    name: "把 units/Empty.tsx 的 ui-empty 改回 music-empty",
    file: F.units + "/Empty.tsx",
    find: "'ui-empty'",
    replace: "'music-empty'",
    expect: ["NAMING.noMusic", "NAMING.uiPrefix"],
  },
  {
    name: "往 units/Select.tsx 塞一个 set-select 类名",
    file: F.units + "/Select.tsx",
    find: 'className="ui-select-item"',
    replace: 'className="ui-select-item set-select"',
    expect: ["NAMING.noSet"],
  },
  {
    name: "把 settings/parts.tsx 里重新加回 export function Select",
    file: F.parts,
    find: "export function SubTitle(",
    replace:
      "export function Select() { return null; }\nexport function SubTitle(",
    expect: ["CALLERS.partsNoControls"],
  },
  {
    name: "把 music/shared.tsx 里的 SongRow 删掉（模拟抽过头）",
    file: F.shared,
    find: "export function SongRow({",
    replace: "export function SongRowGone({",
    expect: ["KEEP.sharedExports"],
  },
  {
    name: "把 music/shared.tsx 里重新加回 export function Empty",
    file: F.shared,
    find: "export function providerName(",
    replace:
      "export function Empty() { return null; }\nexport function providerName(",
    expect: ["CALLERS.sharedNoUnits"],
  },
  {
    name: "把 screens/music/RightPanel.tsx 的 units import 改路径",
    file: F.rightPanel,
    find: "from '@components/units';",
    replace: "from '@components/unitz';",
    expect: ["CALLERS.importsUnits"],
  },
  {
    name: '把 LoginModal.tsx 改回 <button className="music-cbtn">',
    file: F.loginModal,
    find: '          <IconButton title="关闭" onClick={closeLogin}>\n            <X size={15} />\n          </IconButton>',
    replace:
      '          <button type="button" className="music-cbtn" onClick={closeLogin}>\n            <X size={15} />\n          </button>',
    expect: ["CALLERS.loginNoRawCbtn"],
  },
  {
    name: "把 settings/parts.tsx 的 PendingRow 改名（模拟抽过头）",
    file: F.parts,
    find: "export function PendingRow(",
    replace: "export function PendingRowGone(",
    expect: ["KEEP.partsExports"],
  },
  {
    name: "把 components/Sidebar.tsx 改名（应用级组件不该消失）",
    from: F.components + "/Sidebar.tsx",
    to: F.components + "/Sidebar.bak",
    expect: ["KEEP.appComponents"],
  },
  {
    name: "复活旧路径 components/atoms.tsx（模拟保留兼容再导出）",
    create: F.legacyAtoms,
    content: "export {};\n",
    expect: ["LAYOUT.legacyAbsent"],
  },
  {
    name: "把 index.ts 桶文件里 Badge 的出口摘掉（模拟漏出口）",
    file: F.units + "/index.ts",
    find: "export { Badge, Btn, Dot, MagicCircle, Pill } from '@components/units/atoms';",
    replace:
      "export { Btn, Dot, MagicCircle, Pill } from '@components/units/atoms';",
    expect: ["LAYOUT.barrelExports"],
  },
  {
    name: "把 atoms.tsx 的历史中性类名 .pill 改成 .ui-pill",
    file: F.units + "/atoms.tsx",
    find: '<span className="pill">',
    replace: '<span className="ui-pill">',
    expect: ["NAMING.neutralKept"],
  },
  {
    name: "把 src/hooks/useEsc.ts 改名（模拟收口缺件）",
    from: F.hooksDir + "/useEsc.ts",
    to: F.hooksDir + "/useEsc.bak",
    expect: ["HOOKS.layout"],
  },
  {
    name: "复活 src/hooks.ts 旧单文件（模拟 hooks.ts 与 hooks/ 并存）",
    create: F.hooksFile,
    content: "export {};\n",
    expect: ["HOOKS.layout"],
  },
  {
    name: "把 src/hooks/index.ts 的 useToasts 改名（模拟业务 hook 丢失）",
    file: F.hooksDir + "/index.ts",
    find: "export function useToasts()",
    replace: "export function useToastsGone()",
    expect: ["HOOKS.barrelExports"],
  },
  {
    name: "把 PlatformMenu 的 useEsc 引用改回旧位置（@components/units/useEsc）",
    file: F.platformMenu,
    // 锚点必须与 PlatformMenu.tsx 当前的真实字节一致：本项目**统一单引号**，
    // 编辑器保存时的重排会把引号换成双引号（纯噪声），此时锚点失配 ——
    // 后果不是变红而是本条被静默跳过，故回退噪声时**必须同步锚点**（本仓库踩过这个坑）。
    find: "from '@hooks/useEsc';",
    replace: "from '@components/units/useEsc';",
    expect: ["HOOKS.callers"],
  },
  {
    name: "把 hooks/useCoverColor.ts 移回 screens/music（模拟 use* 未收口）",
    from: F.hooksDir + "/useCoverColor.ts",
    to: path.join(SRC, "screens", "music", "useCoverColor.ts"),
    expect: ["HOOKS.noMisplacedUse"],
  },
  {
    name: "从 vite.config.ts 删掉 @hooks 别名（模拟两处漏改一处）",
    file: F.viteConfig,
    find: '      "@hooks": aliasPath("./src/hooks"),\n',
    replace: "",
    expect: ["ALIAS.keysComplete", "ALIAS.twoPlaceSync"],
  },
  {
    name: "从 tsconfig.json 删掉 @music 别名（两条一起删，反向漂移：tsc 不认识而 vite 认识）",
    file: F.tsconfig,
    find: '      "@music": ["src/music"],\n      "@music/*": ["src/music/*"],\n',
    replace: "",
    expect: ["ALIAS.keysComplete", "ALIAS.twoPlaceSync"],
  },
  {
    name: "只删 tsconfig 的 @music/* 通配项（配置退化：别名还在，但 @music/store 解析不到）",
    file: F.tsconfig,
    find: '      "@music/*": ["src/music/*"],\n',
    replace: "",
    expect: ["ALIAS.subPathMaps"],
  },
  {
    name: "把 RightPanel 的一处别名引用改回相对上跳",
    file: F.rightPanel,
    find: "from '@components/units';",
    replace: "from '../../components/units';",
    expect: ["ALIAS.noRelativeUp"],
  },
  {
    name: "把 ipc.ts 的 npm 包 @tauri-apps/api/core 误写成别名 @tauri/api/core",
    file: path.join(SRC, "ipc.ts"),
    find: "from '@tauri-apps/api/core';",
    replace: "from '@tauri/api/core';",
    expect: ["ALIAS.pkgNotShadowed"],
  },
  {
    name: "往 parts.tsx 塞一个 React Context（模拟绕过 zustand）",
    file: F.parts,
    find: "import type { ReactNode } from 'react';",
    replace: "import type { ReactNode } from 'react';\nconst Ctx = createContext(null);\n",
    expect: ["STATE.noReactContext"],
  },
  {
    name: "把 store.ts 的 zustand 依赖换掉（模拟状态库不再是 zustand）",
    file: path.join(SRC, "music", "store.ts"),
    find: "from 'zustand';",
    replace: "from 'zustand-gone';",
    expect: ["STATE.zustandInUse"],
  },

  // ── ISLAND 灵动岛（拍板第 4 项）──────────────────────────────────────
  {
    name: "把 App.tsx 里的 <DynamicIsland /> 删掉（实现了但没人挂）",
    file: F.app,
    find: "      <DynamicIsland />",
    replace: "      {null /* 反证：灵动岛未挂载 */}",
    expect: ["ISLAND.mountedAtRoot"],
  },
  {
    name: "把 App 里的灵动岛换回旧的 .toasts 渲染层（两套并存 → 同一条提示出现两次）",
    file: F.app,
    find: "      <DynamicIsland />",
    replace: '      <div className="toasts" />',
    expect: ["ISLAND.singleSource"],
  },
  {
    name: "让 music/Toast 重新自己渲染（与灵动岛重复显示同一条提示）",
    file: F.musicToast,
    // 锚点用 `return null;`（转发器不渲染任何 DOM）→ 改成一个 div。
    // 不用"删掉转发代码"当破坏：那会让本组另一条断言先红，掩盖要测的东西。
    find: "  return null;\n}",
    replace: '  return <div className="music-toast">x</div>;\n}',
    expect: ["ISLAND.musicToastForwards"],
  },
  {
    name: "把退场时长改成 CSS 0.4s ↔ TS 260ms 不一致（胶囊提前消失 / 悬着不走）",
    file: F.musicScss,
    // 锚点取 transition 里的第一个时长（0.26s）。判据取的是同一处，故改它必然触发红
    find: "    transform 0.26s cubic-bezier(0.4, 0, 0.2, 1),",
    replace: "    transform 0.4s cubic-bezier(0.4, 0, 0.2, 1),",
    expect: ["ISLAND.leaveDurationSync"],
  },
  {
    name: "去掉灵动岛的空闲态早退（会一直挂着一个空胶囊）",
    file: F.island,
    find: "  if (!toast && !hasQueue) return null;",
    replace: "  // 反证：空闲态不再早退",
    expect: ["ISLAND.idleRendersNothing"],
  },
  {
    name: "让 playExpand 对普通提示也淡出内容（hover 上去字消失）",
    file: F.island,
    find: "    if (t.kind === 'music') setContentOn(false);",
    replace: "    setContentOn(false); // 反证：提示也淡出",
    expect: ["ISLAND.toastExpandKeepsContent"],
  },

  // ── STYLE（样式分层）─────────────────────────────────────────────────────
  // 这一组反证守的是「拆完之后没人守规矩，样式又长回一个文件 / 放错分片 /
  // 开始用 SCSS 语法」。没有它们，分层只是目录 aesthetics。
  {
    // 新建了分片却忘了在入口注册 —— 文件在、样式不生效，且**不会报任何错**
    name: "从 index.scss 删掉 manga 的 @use（分片存在但没注册 → 整模块样式不生效）",
    file: path.join(F.stylesDir, "index.scss"),
    find: "@use 'manga.scss';\n",
    replace: "",
    expect: ["STYLE.shardsRegistered"],
  },
  {
    // 顺序即层叠：调换 base/app 就可能改变同特异性规则的胜负
    name: "把 @use 顺序里的 music 提到 manga 之前（顺序即层叠，被悄悄改掉）",
    file: path.join(F.stylesDir, "index.scss"),
    find: "@use 'manga.scss';\n@use 'settings.scss';\n@use 'components.scss';\n@use 'music.scss';",
    replace: "@use 'music.scss';\n@use 'manga.scss';\n@use 'settings.scss';\n@use 'components.scss';",
    expect: ["STYLE.useOrder"],
  },
  {
    name: "把入口的 @use 指回 .css（旧 app.css/base.css 复活，分层名存实亡）",
    file: path.join(F.stylesDir, "index.scss"),
    find: "@use 'base.scss';",
    replace: "@use 'base.css';",
    expect: ["STYLE.entryIsScss"],
  },
  {
    // 放错分片的真实动机是「懒得翻文件」，所以反证就模拟这个动作
    name: "把音乐的选择器塞进 manga.scss（模块私有样式放错分片）",
    file: path.join(F.stylesDir, "manga.scss"),
    find: "/* ================================================================ X-C1 任务队列 */",
    replace: ".music-queue-fake { color: red; }\n/* ================================================================ X-C1 任务队列 */",
    expect: ["STYLE.shardOwnership"],
  },
  {
    name: "在分片里用 SCSS 变量承载颜色（令牌只走 var(--md-*)，否则深色模式就不成立了）",
    file: path.join(F.stylesDir, "music.scss"),
    find: "/* ================================================================ 音乐屏",
    replace: "$brand: #ffe066;\n/* ================================================================ 音乐屏",
    expect: ["STYLE.noScssSyntax"],
  },
  {
    name: "在分片里写嵌套选择器（会改块结构 → 检查脚本的正则取块判据失效）",
    file: path.join(F.stylesDir, "music.scss"),
    find: "/* ================================================================ 音乐屏",
    replace: ".music-exp { &:hover { color: red; } }\n/* ================================================================ 音乐屏",
    expect: ["STYLE.noScssSyntax"],
  },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes("--refute");

console.log(
  "公共组件抽离（components/units）结构断言" + (refute ? " · 反证轮" : ""),
);
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（LAYOUT/PURITY/NAMING/CALLERS/KEEP/HOOKS/ALIAS/STATE/ISLAND）`);

if (!refute) {
  const res = runAll(loadSources());
  const { pass, fail } = printGrouped(res);
  console.log("\n" + "─".repeat(56));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log(
      "\n下一步：逐条看上面 ✗ 的 detail —— 是脚本写错还是真实抽离缺口，勿为转绿而放宽断言。",
    );
  }
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const base = runAll(loadSources());
  const wasGreenBase = {};
  for (const a of A) wasGreenBase[a.id] = base[a.id].ok;

  // 分母固定：应执行的破坏条数在脚本里写死。理由——比率型指标会吞掉分母变化：
  // 「13/13」与「12/12」肉眼都是全绿，而后者已永久少一条覆盖（锚点随重构漂移时会这样静默降级）。
  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);

  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const applied = []; // {kind, ...} 用于最终恢复校验
  const restoreErrors = []; // 恢复动作本身失败（不许抛，见下面的 finally）

  console.log(
    `\n破坏源文件 → 断言必须变红 → 按字节恢复（应执行 ${expectedTotal} 条）\n`,
  );

  for (const mut of MUTATIONS) {
    let okApply = true;
    let record = null;
    try {
      if (mut.from) {
        // 改名
        if (!existsSync(mut.from)) {
          console.log(
            `⚠ ${mut.name}\n    源文件不存在：${path.relative(ROOT, mut.from)} —— 本条无法反证`,
          );
          okApply = false;
          skipped += mut.expect.length;
        } else {
          const original = readBytes(mut.from);
          record = { kind: "rename", from: mut.from, to: mut.to, original };
          renameSync(mut.from, mut.to);
        }
      } else if (mut.create) {
        if (existsSync(mut.create)) {
          console.log(
            `⚠ ${mut.name}\n    ${path.relative(ROOT, mut.create)} 已存在 —— 本条无法反证`,
          );
          okApply = false;
          skipped += mut.expect.length;
        } else {
          record = { kind: "create", file: mut.create };
          writeFileSync(mut.create, mut.content);
        }
      } else {
        const original = readBytes(mut.file);
        if (original == null) {
          console.log(
            `⚠ ${mut.name}\n    文件不存在：${path.relative(ROOT, mut.file)} —— 本条无法反证`,
          );
          okApply = false;
          skipped += mut.expect.length;
        } else {
          const txt = original.toString("utf8");
          // 🔴 EOL 折算：本仓 `core.autocrlf=true`（且无 `.gitattributes` 归一），工作区是 **CRLF**，
          //    而下面的锚点字面量写的是 **LF**。不折算时，**任何跨行锚点**都会"锚点未找到" →
          //    该条静默不反证（跳过 ≠ 通过）。2026-10-07 实测：Windows 上因此有 9 条长期被跳过
          //    （vite/tsconfig 的别名、index.scss 的 @use、music/Toast 的多行锚点），
          //    而"能跑绿的 26 条"掩盖了这件事 —— 正是本项目最警惕的「覆盖率幻觉」。
          const eol = txt.includes("\r\n") ? "\r\n" : "\n";
          const find = mut.find.split("\n").join(eol);
          const repl = mut.replace.split("\n").join(eol);
          if (!txt.includes(find)) {
            console.log(
              `⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`,
            );
            okApply = false;
            skipped += mut.expect.length;
          } else {
            record = { kind: "edit", file: mut.file, original };
            overrideFile(mut.file, txt.replace(find, repl)); // 内存破坏，不写磁盘
          }
        }
      }

      if (okApply) {
        const res = runAll(loadSources(), mut.expect);
        console.log(`🔴 ${mut.name}`);
        for (const id of mut.expect) {
          total++;
          const isRed = res[id] && res[id].ok === false;
          if (isRed) {
            red++;
            console.log(`  ✓ ${id} 按预期变红`);
          } else {
            falsePositives.push(id);
            console.log(
              `  ✗ ${id} 该红没红 ← 假阳性（断言测不到它声称捕捉的改错）`,
            );
          }
          if (!wasGreenBase[id])
            console.log(`     注：${id} 基线本就是红，无法据此判定断言有效性`);
        }
      }
    } finally {
      // 精确按字节恢复。
      //
      // 🔴 **恢复动作一律不许抛出** —— 这一条是实测换来的：`unlinkSync` 在被宿主的删除守卫
      //   拦下时（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）会直接抛，而 `finally` 里抛出的异常
      //   会掀翻**整个反证轮**，后果有两个、且都是最难查的那种：
      //     (a) 后面所有改错**一条都不跑**（本轮"应执行 44 条"实际只跑了一半）；
      //     (b) 源码树被留在**被改坏**的状态 —— 于是**下一次 `check:units` 正向轮**
      //         莫名其妙少一条（实测 37 → 36），而报错只说"文档写 37、脚本实际 36"，
      //         **完全指不到这里**（`check:docs` 正是拿正向轮的自报条数去比文档的）。
      //   所以：失败的恢复只**登记**，由下面的「恢复校验」段统一判红（那里本来就会读盘复核）。
      if (record) {
        try {
          if (record.kind === "rename" && existsSync(record.to)) renameSync(record.to, record.from);
          else if (record.kind === "create" && existsSync(record.file)) unlinkSync(record.file);
          else if (record.kind === "edit") overrideFile(record.file, null); // 清除内存覆盖（磁盘从未被写）
        } catch (err) {
          restoreErrors.push({ ...record, error: String(err).slice(0, 200) });
          console.log(
            `  ⚠ 恢复失败（已登记，稍后统一判红）：${path.relative(ROOT, record.file ?? record.from)}`
            + ` —— ${String(err).slice(0, 160)}`,
          );
        }
        applied.push(record);
      }
    }
  }

  // 恢复校验：改过的按字节比对；改名的确认回位；新建的确认已删除
  console.log("\n恢复校验");
  let restoreFail = 0;
  for (const r of applied) {
    if (r.kind === "edit") {
      const back = existsSync(r.file) ? readFileSync(r.file) : null; // 直接读磁盘，确认从未被污染
      const same = back != null && back.equals(r.original);
      if (!same) restoreFail++;
      console.log(
        `  ${same ? "✓" : "✗"} ${path.relative(ROOT, r.file)} 字节${same ? "一致" : "不一致！"}`,
      );
    } else if (r.kind === "rename") {
      const back = existsSync(r.from) ? readFileSync(r.from) : null;
      const same = back != null && back.equals(r.original) && !existsSync(r.to);
      if (!same) restoreFail++;
      console.log(
        `  ${same ? "✓" : "✗"} ${path.relative(ROOT, r.from)} 已回位且字节${same ? "一致" : "不一致！"}`,
      );
    } else if (r.kind === "create") {
      const gone = !existsSync(r.file);
      if (!gone) restoreFail++;
      console.log(
        `  ${gone ? "✓" : "✗"} ${path.relative(ROOT, r.file)} 临时新建已清除`,
      );
    }
  }

  console.log("\n" + "─".repeat(56));
  console.log(
    `REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`,
  );
  if (total !== expectedTotal)
    console.log(
      `✗ 实际执行 ${total} 条 ≠ 写死的 ${expectedTotal} 条（有破坏被静默跳过）`,
    );
  if (skipped)
    console.log(
      `✗ 有 ${skipped} 条未能反证（锚点未找到/源文件缺席）—— 跳过 ≠ 通过`,
    );
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (restoreErrors.length)
    console.log(
      `✗ 有 ${restoreErrors.length} 个**恢复动作本身**失败（多半是宿主的删除守卫/权限）—— 源码树可能未复原，`
      + `请先手工核对再重跑：\n    ${restoreErrors
        .map((r) => `${path.relative(ROOT, r.file ?? r.from)}：${r.error}`)
        .join("\n    ")}`,
    );
  if (falsePositives.length)
    console.log(`✗ 假阳性：${falsePositives.join(", ")}`);
  process.exitCode =
    red === total &&
    total === expectedTotal &&
    skipped === 0 &&
    restoreFail === 0
      ? 0
      : 1;
}
