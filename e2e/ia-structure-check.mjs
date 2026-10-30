/**
 * C8–C11 的**反证脚本**（IA 结构断言专项）
 *
 * ## 为什么需要它
 *
 * 规格自检跑在应用内（用户点一下就能看到结果），但那有个前提问题：
 * **要看到它红，必须先破坏代码再重新编译/刷新**。这个门槛让人实际上不会去反证，
 * 于是「全绿」就成了没有信息量的信号 —— 本项目已经栽过两次（D-20）。
 *
 * 这个脚本把反证做成了可一键执行的：`npm run task -- check:ia:refute`。
 * 它在 jsdom 里搭出与真实应用**同构的 DOM**（用同一份 class 名与令牌常量），
 * 然后逐条注入破坏，看对应断言是否真的变红。
 *
 * ## 它验的是什么、不是什么（重要，别误读）
 *
 * ✅ 验的是：**断言的判据是否真的能捕捉到它声称捕捉的那种改错**。
 *    —— 塞回 4 项、改回逆序、抹平小节、渲染两组，各自会不会让对应条目变红。
 *    —— 以及末尾的「产品镜像」小节：直接读真实 `Sidebar.tsx` 判一次（合成快照与产品
 *       是两套东西，只验前者会在文件漂移时静默失效）。
 * ❌ 不验：真实浏览器里的布局像素。几何由应用内 C 组自检负责（那里有真实 getComputedStyle）。
 *
 * 两者互补。缺了这个脚本，断言可能恒真而没人知道；缺了应用内自检，
 * 像素就没人量。但**只有这个脚本能回答"我的断言会不会是假阳性"**。
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ── 与应用共享的令牌（直接读源，避免脚本与应用漂移成两套数）──────────────────
const TOKENS = readFileSync(new URL('../src/themes/tokens.ts', import.meta.url), 'utf8');
const num = (k) => {
  const m = TOKENS.match(new RegExp(`\\b${k}:\\s*([\\d.]+)`));
  return m ? Number.parseFloat(m[1]) : NaN;
};
/**
 * 抽 `{ w: N, h: M }` 形态的几何常量。
 *
 * ⚠️ 原来是 `num('appItem')` —— 那个正则是 `\bappItem:\s*([\d.]+)`，而源码里
 * `appItem:` 后面紧跟的是 `{` 不是数字，**恒不匹配、恒返回 NaN**。
 * 之所以一直没暴露：当时没有任何判据真的去用 `SIDEBAR.appItem`
 * （C8 只数项数、看文字、比分隔线位置）。本轮 C8d 要用它，就必须先把抽取修对 ——
 * 否则 C8d 会拿 NaN 去比宽度，`Math.abs(x - NaN) <= 0.5` 恒假 ⇒ 断言恒红（一眼可见），
 * 或者在反证方向上恒绿。两种都是"判据没在测东西"。
 */
const pair = (k) => {
  const m = TOKENS.match(new RegExp(`\\b${k}:\\s*\\{\\s*w:\\s*([\\d.]+),\\s*h:\\s*([\\d.]+)`));
  return m ? { w: Number.parseFloat(m[1]), h: Number.parseFloat(m[2]) } : { w: NaN, h: NaN };
};
const SHELL = { sidebarWidth: num('sidebarWidth') };
const SIDEBAR = {
  appItem: pair('appItem'),
  iconOnlyItem: pair('iconOnlyItem'),
  divider: pair('divider'),
  globalItem: pair('globalItem'),
};

// 🔴 防空转：几何抽不出来就必须停，不能带着 NaN 往下跑 ——
// NaN 参与比较时两边都是假，判据会变成"永远红"或"永远绿"，而报错信息里看不出原因。
for (const [k, v] of Object.entries(SIDEBAR)) {
  if (Number.isNaN(v.w) || Number.isNaN(v.h)) {
    console.error(`✗ 无法从 tokens.ts 抽出 SIDEBAR.${k} 的几何（正则与源码形态已失配）—— 判据会因此假绿，先修抽取。`);
    process.exit(1);
  }
}

const SETTINGS = { navWidth: num('navWidth'), navStickyTop: num('navStickyTop') };

const NEAR = 0.5;
const near = (a, b) => Math.abs(a - b) <= NEAR;

/** 每种屏对应的 DOM 快照（可被反证用例改写） */
function dom({
  screens,
  apps,
  divider,
  appLabels,
  /** 应用入口是否带文字标签（台账 D-84）—— 与 `Sidebar` 的 `labels` prop 同一个意思 */
  sidebarLabels = true,
  globalHasText,
  viewOrder,
  settings,
  subs,
  /** 反证用：把「设置」按钮挪到分隔线**之上**（两级混层的典型改法） */
  globalAboveDivider,
  /** 反证用：几何与标签形态**不一致**（关掉文字却仍用 58×52 的那套尺寸） */
  appGeomMismatch,
  /** 反证用：应用入口去掉 `aria-label`（纯图标态下就没有任何可读名称了） */
  dropAppAria,
}) {
  // 全局层设置：纯图标 = 按钮内**没有 span**；反证时补一个可见文字 span。
  // （这个分支必须挂在 is-global 上 —— 之前误挂在 apps 循环里，而 apps 里
  //   根本没有 'settings'，于是分支永不触发、C8b 反证假阳性。）
  const globalBtn = (active) =>
    `<button class="nav-item is-global${active ? ' is-active' : ''}" title="设置"><svg></svg>${
      globalHasText ? '<span>设置</span>' : ''
    }</button>`;

  /*
   * 应用入口的两种形态 —— 与真实 `Sidebar.tsx` 同一套规则：
   *   · `sidebarLabels` 真 → `<svg>` + `<span>文字</span>`，几何 58×52
   *   · 假 → 只有 `<svg>`（**没有 span**），几何 44×44
   *
   * ⚠️ 两种形态都带 `aria-label`。关掉文字后它是唯一可发现性来源，
   * 也是 C8a 的判据源（判结构不判文字 —— 见 `judgeC8`）。
   * 几何写成行内 style：与实现一致（CSS 里刻意没有第二份数字）。
   */
  const geom = SIDEBAR.appItem;
  const want = sidebarLabels ? SIDEBAR.appItem : SIDEBAR.iconOnlyItem;
  const used = appGeomMismatch ? geom : want;
  const appBtns = apps
    .map((a) => {
      const label = appLabels[a] ?? a;
      const text = sidebarLabels ? `<span>${label}</span>` : '';
      const aria = dropAppAria ? '' : ` aria-label="${label}"`;
      return `<button class="nav-item is-app${a === screens.app ? ' is-active' : ''}"${aria} style="width:${used.w}px;height:${used.h}px"><svg></svg>${text}</button>`;
    })
    .join('');
  const dividerEl = divider ? '<div class="sidebar-divider"></div>' : '';

  // 正确形态：应用 → 分隔线 → 设置
  // 混层形态：应用 → 设置 → 分隔线（设置跑到分界之上）
  const globalTail = globalAboveDivider
    ? `${globalBtn(screens.app === 'settings')}${dividerEl}`
    : `${dividerEl}${globalBtn(screens.app === 'settings')}`;

  return `
<div class="shell">
  <nav class="sidebar">
    <div class="sidebar-logo"></div>
    ${appBtns}
    ${globalTail}
  </nav>
  <div class="main">
    <div class="toolbar"><div class="toolbar-titles"><div class="toolbar-title">t</div></div></div>
    ${
      viewOrder
        ? `<div class="viewtabs">${viewOrder
            .map((v) => `<button class="ui-vtab${v === viewOrder[0] ? ' is-active' : ''}"><span>${v}</span></button>`)
            .join('')}</div>`
        : ''
    }
    <div class="content">${
      settings
        ? `<div class="settings">
      <nav class="settings-nav" style="flex:0 0 ${SETTINGS.navWidth}px;top:${SETTINGS.navStickyTop}px;position:sticky">
        ${settings.groups
          .map(
            (g, i) =>
              `<button class="set-nav-item${i === 0 ? ' is-active' : ''}"><span class="set-nav-label">${g}</span><span class="set-nav-count">0</span></button>`,
          )
          .join('')}
      </nav>
      <div class="settings-main" style="flex:1;min-width:0">
        <header class="settings-head"><div class="settings-title">${settings.title ?? '通用'}</div></header>
        ${settings.allGroups ? settings.groups.map((g) => `<div class="grp"><div class="settings-head">${g}</div></div>`).join('') : ''}
        ${subs.map((s) => `<div class="set-subtitle">${s}</div>`).join('')}
      </div>
    </div>`
        : ''
    }</div>
  </div>
</div>`;
}

/** 从 DOM 文本里抽出侧栏几何（模拟 getBoundingClientRect 的纵向序） */
function geometry(html) {
  const order = [];
  const re = /class="(nav-item is-app[^"]*|sidebar-divider|nav-item is-global[^"]*)"/g;
  let m;
  while ((m = re.exec(html)))
    order.push(m[1].startsWith('nav-item is-app') ? 'app' : m[1] === 'sidebar-divider' ? 'divider' : 'global');
  return order;
}

/** C8：侧栏两级结构 —— 判据逐条独立评估 */
function judgeC8(html, domSpec) {
  const appCount = (html.match(/nav-item is-app/g) || []).length;
  /*
   * C8a 的判据源是**可访问名称**，不是按钮里的 `<span>` 文字。
   *
   * 必须与 `spec-check.ts` 的 C8a 用同一条判据 —— 两处一旦不同源，应用内自检
   * 与这个反证脚本会各说各话，而两边都"有断言"，谁也不知道哪个是对的。
   * 理由见 `spec-check.ts` 那一处：应用入口有「图标 + 文字」与「纯图标」两种形态，
   * 按 span 判会在纯图标态下无条件变红（把用户的选择误报成结构损坏）。
   */
  const names = [...html.matchAll(/nav-item is-app[^>]*aria-label="([^"]*)"/g)].map((m) => m[1].trim());
  const globalItems = (html.match(/nav-item is-global/g) || []).length;
  const globalWithText = /nav-item is-global[^>]*>(?:(?!<\/button>)[\s\S])*?<span>[^<]+<\/span>/.test(html);
  const order = geometry(html);
  const di = order.indexOf('divider');
  const appIdx = order.map((v, i) => (v === 'app' ? i : -1)).filter((i) => i >= 0);
  const gIdx = order.map((v, i) => (v === 'global' ? i : -1)).filter((i) => i >= 0);

  /*
   * C8d：**几何必须与"有没有标签"同时变**（台账 D-84）—— 与 `spec-check.ts` 同源。
   *
   * 在合成快照里"量到的像素"就是行内 style 上写的那两个数（真实浏览器里由
   * getBoundingClientRect 给出），所以这里读 style，等价于那边读 rect。
   */
  const geomOk = [...html.matchAll(/<button class="nav-item is-app[^>]*>([\s\S]*?)<\/button>/g)].map((m) => {
    const tag = m[0];
    const hasText = /<span>[^<]*<\/span>/.test(m[1]);
    const w = Number.parseFloat((tag.match(/style="width:([\d.]+)px/) || [])[1] ?? '');
    const h = Number.parseFloat((tag.match(/height:([\d.]+)px/) || [])[1] ?? '');
    const want = hasText ? SIDEBAR.appItem : SIDEBAR.iconOnlyItem;
    // NaN 参与比较恒假 ⇒ 抽不到尺寸时判红，不会假绿
    return near(w, want.w) && near(h, want.h);
  });

  return {
    C8a: appCount === 2 && names[0] === '漫画翻译' && names[1] === '音乐',
    C8b: globalItems === 1 && !globalWithText,
    C8c: di >= 0 && appIdx.length > 0 && gIdx.length > 0 && appIdx.every((i) => i < di) && gIdx.every((i) => i > di),
    C8d:
      geomOk.length > 0 &&
      geomOk.every(Boolean) &&
      [SIDEBAR.appItem, SIDEBAR.iconOnlyItem].every((s) => s.w >= 44 && s.h >= 44),
  };
}

function judgeC9(html) {
  // 🔴 2026-10-26：页签改为通用单元 `.ui-vtab`（漫画/音乐共用，见 units/ViewTabs.tsx）。
  // 判据锚在 `ui-vtab` 上；`<span>` 仍是文案载体（图标已按设计稿去掉）。
  // ⚠️ 不能写成 `ui-vtab[^>]*><span>`：那种写法只在自己理想化的脚手架 HTML 上成立，
  // 对真实输出恒不匹配 → C9 恒绿（假阳性）。这里用「不跨出当前 button」的惰性匹配。
  const tabs = [...html.matchAll(/ui-vtab[^>]*>(?:(?!<\/button>)[\s\S])*?<span>([^<]*)<\/span>/g)].map((m) =>
    m[1].trim(),
  );
  /*
   * 🔴 `tabs.length === 0` **不能** return true（2026-10-26 一并修掉）：
   *    那是「夹具里没有页签 ⇒ 判它合格」—— 类名一改，这条断言会**静默变绿**，
   *    而它声称钉的正是"三个页签按 投放→队列→漫画库 排"。空集合必须判失败。
   */
  if (tabs.length === 0) return false;
  const want = ['投放', '队列', '漫画库'];
  return tabs.length === want.length && tabs.every((t, i) => t === want[i]);
}

function judgeC10(html) {
  if (!html.includes('class="settings"')) return true;
  const groups = (html.match(/set-nav-item/g) || []).length;
  const navOk = html.includes(`flex:0 0 ${SETTINGS.navWidth}px`) && html.includes(`top:${SETTINGS.navStickyTop}px`);
  const mainOk = html.includes('flex:1') && html.includes('min-width:0');
  const heads = (html.match(/settings-head/g) || []).length;
  return {
    C10a: navOk && mainOk,
    C10b: heads === 1,
    C10c: groups === 6,
  };
}

function judgeC11(html) {
  if (!html.includes('settings-main')) return true;
  const isTranslate = /settings-title">翻译服务/.test(html);
  if (!isTranslate) return true;
  const subs = [...html.matchAll(/class="set-subtitle"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  const want = ['服务与配对', '推理引擎', '模型与诊断'];
  return subs.length === 3 && subs.every((s, i) => s === want[i]);
}

// ── 用例 ───────────────────────────────────────────────────────────────────
const BASE = {
  screens: { app: 'translate' },
  apps: ['translate', 'music'],
  divider: true,
  appLabels: { translate: '漫画翻译', music: '音乐', anime: '番剧' },
  /** 侧栏应用入口带文字标签（与升级前的界面一致；关掉后用 44×44 纯图标） */
  sidebarLabels: true,
  globalHasText: false,
  viewOrder: ['投放', '队列', '漫画库'],
  settings: { groups: ['通用', '翻译服务', '播放·媒体', '资源与投放', '关于', '番剧设置'], title: '通用' },
  subs: [],
};
const TRANS = {
  ...BASE,
  /*
   * 🔴 分组是**全局同一组**（6 组），切组只换高亮的 `title`，不是"翻译服务页只有 5 组"。
   * 原来这里漏了第 6 组「番剧设置」；因基线计数曾用 `want` 而非实测值（假绿），一直没被发现。
   */
  settings: {
    groups: ['通用', '翻译服务', '播放·媒体', '资源与投放', '关于', '番剧设置'],
    title: '翻译服务',
  },
  subs: ['服务与配对', '推理引擎', '模型与诊断'],
};

const cases = [
  { name: '基线·侧栏（图标 + 文字）', spec: BASE, want: { C8a: true, C8b: true, C8c: true, C8d: true, C9: true } },
  {
    /*
     * 这条基线本身就是一条断言：**「纯图标」是一种合法形态，不是破坏**。
     *
     * 台账 D-84 之前，应用入口只有一种形态，C8a 靠「按钮里的 span 文字」判身份 ——
     * 纯图标态下那串恒为空，C8a 会无条件变红。把这条基线钉住，等于钉住
     * "关掉标签之后，结构（恒 2 项 + 顺序）与热区（≥44）都还在"。
     */
    name: '基线·侧栏（纯图标：标签关掉）',
    spec: { ...BASE, sidebarLabels: false },
    want: { C8a: true, C8b: true, C8c: true, C8d: true, C9: true },
  },
  { name: '基线·设置①', spec: BASE, want: { C10a: true, C10b: true, C10c: true, C11: true } },
  { name: '基线·设置②', spec: TRANS, want: { C10a: true, C10b: true, C10c: true, C11: true } },

  // ── 反证：每条都必须变红，否则该断言是假阳性 ──
  {
    name: '反证 C8a：应用层塞回 4 项（队列/漫画库/投放 平级）',
    spec: { ...BASE, apps: ['translate', 'queue', 'library', 'drop'] },
    refute: ['C8a'],
  },
  {
    name: '反证 C8a：音乐被移到翻译之前（顺序错）',
    spec: { ...BASE, apps: ['music', 'translate'] },
    refute: ['C8a'],
  },
  {
    /*
     * 这条专为 D-84 立的：应用入口丢掉 `aria-label`。
     *
     * 它是「C8a 真的在读可访问名称」的证据 —— 若判据偷偷回退成读 span，
     * 这条反证在纯图标态下会**仍绿**（没有 span 时两种判据都为假，
     * 但带标签态下读 span 的判据仍会绿），于是假阳性被这条抓出来。
     */
    name: '反证 C8a：应用入口丢掉 aria-label（纯图标态下将无法被读出）',
    spec: { ...BASE, sidebarLabels: false, dropAppAria: true },
    refute: ['C8a'],
  },
  {
    name: '反证 C8d：关掉文字却仍用 58×52（几何与形态脱钩）',
    spec: { ...BASE, sidebarLabels: false, appGeomMismatch: true },
    refute: ['C8d'],
  },
  {
    name: '反证 C8b：设置去文字（变回图标+文字）',
    spec: { ...BASE, globalHasText: true },
    refute: ['C8b'],
  },
  {
    name: '反证 C8c：删掉分隔线',
    spec: { ...BASE, divider: false },
    refute: ['C8c'],
  },
  {
    // 「设置混到应用层」的实现形态有两种，两条都要能抓到：
    //   ① 设置按钮本身被加进应用层列表（即它也带 is-app）
    //   ② 设置挪到分隔线之上（纵向序被打乱）
    // 只判 ① 会漏掉 ②，而 ② 才是"两级混层"最典型的改法。
    name: '反证 C8c：设置被挪到分隔线之上（两级混层）',
    spec: {
      ...BASE,
      screens: { app: 'settings' },
      globalAboveDivider: true,
    },
    refute: ['C8c'],
  },
  {
    name: '反证 C9：Tab 改回 ver1.0 逆序（队列→漫画库→投放）',
    spec: { ...BASE, viewOrder: ['队列', '漫画库', '投放'] },
    refute: ['C9'],
  },
  {
    name: '反证 C9：Tab 换成别的顺序（投放→漫画库→队列）',
    spec: { ...BASE, viewOrder: ['投放', '漫画库', '队列'] },
    refute: ['C9'],
  },
  {
    name: '反证 C10c：分组只剩 4 个（回退「四分组」旧口径）',
    spec: { ...BASE, settings: { groups: ['通用', '翻译服务', '播放·媒体', '资源与投放'], title: '通用' } },
    refute: ['C10c'],
  },
  {
    name: '反证 C10c：分组变 7 个',
    spec: { ...BASE, settings: { groups: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], title: '通用' } },
    refute: ['C10c'],
  },
  {
    name: '反证 C10b：5 组全渲染（靠 CSS 隐藏而非单组挂载）',
    spec: {
      ...BASE,
      settings: { groups: ['通用', '翻译服务', '播放·媒体', '资源与投放', '关于'], title: '通用', allGroups: true },
    },
    refute: ['C10b'],
  },
  {
    name: '反证 C11：②翻译服务的小节被抹平',
    spec: { ...TRANS, subs: [] },
    refute: ['C11'],
  },
  {
    name: '反证 C11：②只留 2 个小节',
    spec: { ...TRANS, subs: ['服务与配对', '推理引擎'] },
    refute: ['C11'],
  },
];

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
};

console.log('C8–C11 IA 结构断言 · 反证轮\n');
console.log(
  '令牌取自源码：',
  JSON.stringify({ sidebar: SHELL.sidebarWidth, nav: SETTINGS.navWidth, sticky: SETTINGS.navStickyTop }),
);
console.log('');

for (const c of cases) {
  const html = dom(c.spec);
  // ⚠️ judgeC9/judgeC11 返回的是**布尔值**而不是 {id:bool} —— 展开进对象时
  // 布尔值会被静默丢弃，于是这两条在 want 里恒为 undefined、被判成"红 ← 误报"。
  // 这是第一版脚本自己的 bug：它制造了 4 处假阳性，看起来像断言失灵。
  // 修法：显式包成键值对。宁可啰嗦，也不要"展开时被悄悄吃掉"。
  const j = {
    ...judgeC8(html, c.spec),
    C9: judgeC9(html),
    ...judgeC10(html),
    C11: judgeC11(html),
  };
  console.log(`${c.refute ? '🔴 反证' : '🟢 基线'} · ${c.name}`);
  if (c.refute) {
    for (const id of c.refute) {
      ok(j[id] === false, `${id} 在此破坏下**变红**（实测 ${j[id] === false ? '红' : '仍绿 ← 假阳性!'}）`);
    }
  } else {
    /*
     * 🔴 判据必须是**实测值** `j[id]`，不能是 `want` 里的期望值 `v`。
     *    2026-10-30 修：原来写 `ok(v === true, …)`，而 `v` 恒为 `true`（来自 `c.want`）
     *    ⇒ 基线**永远通过**，只在文案里打印"红 ← 误报"。实测症状：把番剧入口塞回夹具、
     *    C8a 确实变红，脚本仍报「37 通过 / 0 失败」—— 典型假绿。
     */
    for (const id of Object.keys(c.want)) {
      ok(j[id] === true, `${id} 在正确实现下保持绿（实测 ${j[id] ? '绿' : '红 ← 误报!'}）`);
    }
  }
  console.log('');
}

// ── 产品镜像：真实 Sidebar.tsx 不得再渲染服务状态点（D-230 ⑤）────────────────
/*
 * 上面整个脚本都在**合成 DOM**里跑：全绿只证明"判据在合成快照上咬得住"，
 * 不证明"真实文件里没有状态点"—— 两者是两套东西，漂移了没人知道。
 * 故这里直接读产品源码判一次，并用"把状态点加回去"的注入破坏反证。
 *
 * 判据取三个信号（任一出现即回归）：`.sidebar-status` 容器 · `stateView` 取用 ·
 * `<Dot` 渲染。服务状态本身没有消失（设置页「服务与配对」+ 托盘图标仍在），
 * 消失的是侧栏这**第三处**重复。
 */
const SIDEBAR_TSX = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8');
const judgeProductSidebar = (src) => ({
  C8e: !src.includes('sidebar-status') && !/stateView/.test(src) && !/<Dot/.test(src),
});

{
  const j = judgeProductSidebar(SIDEBAR_TSX);
  console.log('🟢 基线 · 产品镜像：真实 Sidebar.tsx');
  ok(j.C8e === true, `C8e 侧栏不渲染服务状态点（实测 ${j.C8e ? '绿' : '红 ← 误报!'}）`);
  console.log('');
}

/**
 * C8f（D-233）：侧栏下载入口 —— 设置之上、纯图标、有 aria-label、按状态条件渲染。
 *
 * 判据直接读产品源码（不另造一份合成 DOM）：这条入口是三态图标 + 条件渲染，
 * 合成快照只能验证其中一半。
 */
const judgeDownloadEntry = (src) => {
  const dl = src.indexOf('nav-item is-global is-download');
  const settings = src.indexOf("screen === 'settings' ? 'nav-item is-global is-active'");
  const hasAria = src.includes('aria-label={DOWNLOAD_META[downloadEntry].label}');
  const conditional = src.includes("downloadEntry !== 'hidden' ? (");
  const noText = !/is-download[\s\S]{0,600}?<span>/.test(src);
  return dl > 0 && settings > dl && hasAria && conditional && noText;
};

{
  const okBase = judgeDownloadEntry(SIDEBAR_TSX);
  console.log('🟢 基线 · 产品镜像：侧栏下载入口');
  ok(okBase, `C8f 下载入口在设置之上、纯图标、有 aria-label、按状态条件渲染（实测 ${okBase ? '绿' : '红 ← 误报!'}）`);
  const mutated = SIDEBAR_TSX.replace('aria-label={DOWNLOAD_META[downloadEntry].label}', 'aria-label=""');
  const okMut = judgeDownloadEntry(mutated);
  console.log('🔴 反证 · 产品镜像：去掉下载入口的 aria-label');
  ok(!okMut, `C8f 在此破坏下**变红**（实测 ${!okMut ? '红' : '仍绿 ← 假阳性!'}）`);
  console.log('');
}

{
  // 🔴 按文件实际 EOL 拼锚点：本仓文件是 CRLF，手写 `\n` 会找不到边界
  //    （同类坑在 settings-media / launch-gate 的变异里都记过）。
  const eol = SIDEBAR_TSX.includes('\r\n') ? '\r\n' : '\n';
  /*
   * 🔴 不写死整段标签文本（2026-10-26 改）：`<Btn kind="bare"` 一旦被 prettier
   *    按行宽拆成三行，写死三行的锚点就静默失配 ⇒ 整条反证变成"无法反证"。
   *    改成**按语义定位**：先找「设置按钮的 className 行」，再向上回溯到最近的
   *    `<Btn` 起始行，在那之前插入状态点。格式化怎么拆行都不影响。
   */
  const lines = SIDEBAR_TSX.split(eol);
  const clsLine = lines.findIndex((l) => l.includes("screen === 'settings' ? 'nav-item is-global is-active'"));
  let tagLine = -1;
  for (let i = clsLine; i >= 0; i--) {
    if (lines[i].trim().startsWith('<Btn')) {
      tagLine = i;
      break;
    }
  }

  const fileUrl = new URL('../src/components/Sidebar.tsx', import.meta.url);
  if (clsLine > 0 && tagLine > 0) {
    const mutated = [...lines];
    mutated.splice(tagLine, 0, '      <div className="sidebar-status">{stateView(\'running\').text}</div>');
    writeFileSync(fileUrl, mutated.join(eol));
    const j = judgeProductSidebar(readFileSync(fileUrl, 'utf8'));
    console.log('🔴 反证 · 产品镜像：把服务状态点加回侧栏');
    ok(j.C8e === false, `C8e 在此破坏下**变红**（实测 ${j.C8e === false ? '红' : '仍绿 ← 假阳性!'}）`);
    // 按字节还原并复核：留着被改坏的产品文件比没测更糟
    writeFileSync(fileUrl, SIDEBAR_TSX);
    ok(readFileSync(fileUrl, 'utf8') === SIDEBAR_TSX, 'Sidebar.tsx 已按字节还原');
  } else {
    ok(false, '反证锚点未找到（Sidebar.tsx 里找不到设置按钮的 className 行或其 <Btn 起始行）—— 本条无法反证');
  }
  console.log('');
}

console.log('─'.repeat(56));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log(
  fail === 0
    ? '\n✓ 全部反证成立：合成快照与产品镜像两侧的断言都能捕捉到它们声称捕捉的改错。'
    : '\n✗ 存在假阳性：某条断言在破坏下仍绿，它测不到东西。',
);
process.exit(fail === 0 ? 0 : 1);
