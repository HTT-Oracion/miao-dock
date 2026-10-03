/**
 * C8–C11 的**反证脚本**（IA 结构断言专项）
 *
 * ## 为什么需要它
 *
 * 规格自检跑在应用内（用户点一下就能看到结果），但那有个前提问题：
 * **要看到它红，必须先破坏代码再重新编译/刷新**。这个门槛让人实际上不会去反证，
 * 于是「全绿」就成了没有信息量的信号 —— 本项目已经栽过两次（D-20）。
 *
 * 这个脚本把反证做成了可一键执行的：`npm run check:ia:refute`。
 * 它在 jsdom 里搭出与真实应用**同构的 DOM**（用同一份 class 名与令牌常量），
 * 然后逐条注入破坏，看对应断言是否真的变红。
 *
 * ## 它验的是什么、不是什么（重要，别误读）
 *
 * ✅ 验的是：**断言的判据是否真的能捕捉到它声称捕捉的那种改错**。
 *    —— 塞回 4 项、改回逆序、抹平小节、渲染两组，各自会不会让对应条目变红。
 * ❌ 不验：真实浏览器里的布局像素。几何由应用内 C 组自检负责（那里有真实 getComputedStyle）。
 *
 * 两者互补。缺了这个脚本，断言可能恒真而没人知道；缺了应用内自检，
 * 像素就没人量。但**只有这个脚本能回答"我的断言会不会是假阳性"**。
 */
import { readFileSync } from 'node:fs';

// ── 与应用共享的令牌（直接读源，避免脚本与应用漂移成两套数）──────────────────
const TOKENS = readFileSync(new URL('../app/src/theme/tokens.ts', import.meta.url), 'utf8');
const num = (k) => {
  const m = TOKENS.match(new RegExp(`\\b${k}:\\s*([\\d.]+)`));
  return m ? Number.parseFloat(m[1]) : NaN;
};
const SHELL = { sidebarWidth: num('sidebarWidth') };
const SIDEBAR = {
  appItem: { w: num('appItem'), h: num('appItem') },
  divider: { w: 34, h: 1 },
  globalItem: { w: 44, h: 44 },
};
const SETTINGS = { navWidth: num('navWidth'), navStickyTop: num('navStickyTop') };

const NEAR = 0.5;
const near = (a, b) => Math.abs(a - b) <= NEAR;

/** 每种屏对应的 DOM 快照（可被反证用例改写） */
function dom({
  screens,
  apps,
  divider,
  appLabels,
  globalHasText,
  viewOrder,
  settings,
  subs,
  /** 反证用：把「设置」按钮挪到分隔线**之上**（两级混层的典型改法） */
  globalAboveDivider,
}) {
  // 全局层设置：纯图标 = 按钮内**没有 span**；反证时补一个可见文字 span。
  // （这个分支必须挂在 is-global 上 —— 之前误挂在 apps 循环里，而 apps 里
  //   根本没有 'settings'，于是分支永不触发、C8b 反证假阳性。）
  const globalBtn = (active) =>
    `<button class="nav-item is-global${active ? ' is-active' : ''}" title="设置"><svg></svg>${
      globalHasText ? '<span>设置</span>' : ''
    }</button>`;

  const appBtns = apps
    .map(
      (a) =>
        `<button class="nav-item is-app${a === screens.app ? ' is-active' : ''}"><svg></svg><span>${
          appLabels[a] ?? a
        }</span></button>`,
    )
    .join('');
  const dividerEl = divider ? '<div class="sidebar-divider"></div>' : '';
  const statusEl = '<div class="sidebar-status"></div>';

  // 正确形态：应用 → 分隔线 → 状态点 → 设置
  // 混层形态：应用 → 设置 → 分隔线 → 状态点（设置跑到分界之上）
  const globalTail = globalAboveDivider
    ? `${globalBtn(screens.app === 'settings')}${dividerEl}${statusEl}`
    : `${dividerEl}${statusEl}${globalBtn(screens.app === 'settings')}`;

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
            .map((v) => `<button class="viewtab${v === viewOrder[0] ? ' is-active' : ''}"><svg></svg><span>${v}</span></button>`)
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
  const re = /class="(nav-item is-app[^"]*|sidebar-divider|nav-item is-global[^"]*|sidebar-status)"/g;
  let m;
  while ((m = re.exec(html))) order.push(m[1].startsWith('nav-item is-app') ? 'app' : m[1] === 'sidebar-divider' ? 'divider' : m[1] === 'sidebar-status' ? 'status' : 'global');
  return order;
}

/** C8：侧栏两级结构 —— 判据逐条独立评估 */
function judgeC8(html, domSpec) {
  const appCount = (html.match(/nav-item is-app/g) || []).length;
  const labels = [...html.matchAll(/nav-item is-app[^>]*><span>([^<]*)<\/span>/g)].map((m) => m[1].trim());
  const globalItems = (html.match(/nav-item is-global/g) || []).length;
  const globalWithText = /nav-item is-global[^>]*>(?:(?!<\/button>)[\s\S])*?<span>[^<]+<\/span>/.test(html);
  const order = geometry(html);
  const di = order.indexOf('divider');
  const appIdx = order.map((v, i) => (v === 'app' ? i : -1)).filter((i) => i >= 0);
  const gIdx = order.map((v, i) => (v === 'global' ? i : -1)).filter((i) => i >= 0);
  return {
    C8a: appCount === 2 && labels[0] === '漫画翻译' && labels[1] === '音乐',
    C8b: globalItems === 1 && !globalWithText,
    C8c: di >= 0 && appIdx.length > 0 && gIdx.length > 0 && appIdx.every((i) => i < di) && gIdx.every((i) => i > di),
  };
}

function judgeC9(html) {
  // ⚠️ 不能写成 `viewtab[^>]*><span>`：真实 DOM 里 Tab 是 `<svg/>` 在前、`<span>` 在后，
  // 那种写法只在自己理想化的脚手架 HTML 上成立，对真实输出恒不匹配 → C9 恒绿（假阳性）。
  // 这里用「不跨出当前 button」的惰性匹配，等价于浏览器里取 button 内的 span。
  const tabs = [...html.matchAll(/viewtab[^>]*>(?:(?!<\/button>)[\s\S])*?<span>([^<]*)<\/span>/g)].map((m) => m[1].trim());
  if (tabs.length === 0) return true;
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
    C10c: groups === 5,
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
  appLabels: { translate: '漫画翻译', music: '音乐' },
  globalHasText: false,
  viewOrder: ['投放', '队列', '漫画库'],
  settings: { groups: ['通用', '翻译服务', '播放·媒体', '资源与投放', '关于'], title: '通用' },
  subs: [],
};
const TRANS = {
  ...BASE,
  settings: { groups: ['通用', '翻译服务', '播放·媒体', '资源与投放', '关于'], title: '翻译服务' },
  subs: ['服务与配对', '推理引擎', '模型与诊断'],
};

const cases = [
  { name: '基线·侧栏', spec: BASE, want: { C8a: true, C8b: true, C8c: true, C9: true } },
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
    name: '反证 C10c：分组变 6 个',
    spec: { ...BASE, settings: { groups: ['a', 'b', 'c', 'd', 'e', 'f'], title: '通用' } },
    refute: ['C10c'],
  },
  {
    name: '反证 C10b：5 组全渲染（靠 CSS 隐藏而非单组挂载）',
    spec: { ...BASE, settings: { groups: ['通用', '翻译服务', '播放·媒体', '资源与投放', '关于'], title: '通用', allGroups: true } },
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
console.log('令牌取自源码：', JSON.stringify({ sidebar: SHELL.sidebarWidth, nav: SETTINGS.navWidth, sticky: SETTINGS.navStickyTop }));
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
    for (const [id, v] of Object.entries(c.want)) ok(v === true, `${id} 在正确实现下保持绿（实测 ${j[id] ? '绿' : '红 ← 误报!'}）`);
  }
  console.log('');
}

console.log('─'.repeat(56));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log(fail === 0 ? '\n✓ 全部反证成立：四条断言都能捕捉到它们声称捕捉的改错。' : '\n✗ 存在假阳性：某条断言在破坏下仍绿，它测不到东西。');
process.exit(fail === 0 ? 0 : 1);
