/**
 * 规格自检 —— 把 docs/internal/dev-plan.md §4 的 C1–C7 与 B3 从「肉眼看」变成「当场量」。
 *
 * 做法：在设置页挂一份**离屏样张**（队列表 + 空态魔法阵 + 漫画库左栏与网格卡），
 * 然后对实际渲染出来的 DOM 取 `getBoundingClientRect` / `getComputedStyle`，
 * 与 `theme/tokens.ts` 里的同一批常量比对。CSS 里改错了数值，这里立刻报红。
 *
 * 为什么不写独立的 DOM 测试跑在 CI 里：这一份的价值在于**用户点一下就能看到**，
 * 而不需要先装一套 headless 浏览器。断言内容与 CI 版可以完全一致。
 */
import {
  LIBRARY,
  QUEUE_EMPTY,
  QUEUE_TABLE,
  SETTINGS,
  SHELL,
  SIDEBAR,
  COLOR_TOKENS_DARK,
  COLOR_TOKENS_LIGHT,
  type ThemeMode,
} from '@/themes/tokens';
import type { ServiceState } from '@/ipc';
import { APP_LABEL, stateView, TRANSLATE_VIEWS } from '@/stores/nav';

export interface SpecResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

/**
 * 把两种颜色写法归一到可比的形式。
 *
 * 这是本文件唯一一处「必须记得做」的转换，所以把它收进 `sameColor` 自己身上，
 * 而不是指望每个调用点都记得先 toHex。原因：
 *   · token 里写的是 `#C9B5FF`
 *   · `getComputedStyle` 回来的**一律是** `rgb(255, 143, 191)`，而且是小写
 * 直接字符串相比**永远不相等** → `sameColor(a,b)` 恒假、`!sameColor(a,b)` 恒真。
 * 后者更危险：它把「没检查」伪装成「检查通过」。这个坑在本文件里已经踩过两回。
 */
function normColor(c: string): string {
  const s = String(c).trim();
  return s.startsWith('rgb') ? toHex(s) : s.toLowerCase();
}

/** 颜色相等判定（格式无关：hex / rgb 都能比） */
const sameColor = (a: string, b: string) => normColor(a) === normColor(b);

function px(v: string): number {
  return Number.parseFloat(v) || 0;
}

/** `rgb(255, 143, 191)` / `rgba(...)` → `#ff8fbf` */
function toHex(rgb: string): string {
  const m = rgb.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgb;
  const [r, g, b] = m[1].split(',').map((s) => Number.parseFloat(s));
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

function q<T extends Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector(sel) as T | null;
}

export function runSpecCheck(root: HTMLElement, mode: ThemeMode): SpecResult[] {
  const out: SpecResult[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => out.push({ id, label, ok, detail });

  const tokens = mode === 'dark' ? COLOR_TOKENS_DARK : COLOR_TOKENS_LIGHT;

  /*
   * 响应式期望值 —— 与 app.scss / components.scss 的断点同源。
   * 断点：1180 收内容边距与设置左栏，1040 收侧栏为纯图标轨，760 收成窄轨。
   * 自检在用户的真实窗口里跑，所以期望值必须随视口变化，不能写死桌面档。
   */
  const vw = window.innerWidth;
  const isNarrow = vw <= 760;
  const isCompact = vw <= 1040;
  const isMedium = vw <= 1180;
  const wantSidebarWidth = isNarrow
    ? SHELL.narrowSidebarWidth
    : isCompact
      ? SHELL.compactSidebarWidth
      : SHELL.sidebarWidth;
  const wantContentPad = isNarrow
    ? SHELL.narrowContentPadding
    : isMedium
      ? SHELL.compactContentPadding
      : SHELL.contentPadding;

  // ---------------------------------------------------------------- C1 外壳几何
  {
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
    const content = document.querySelector('.content') as HTMLElement | null;

    const sw = sidebar ? sidebar.getBoundingClientRect().width : -1;
    const th = toolbar ? toolbar.getBoundingClientRect().height : -1;
    const cs = content ? getComputedStyle(content) : null;
    const pad = cs
      ? [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)]
      : [-1, -1, -1, -1];
    const want = wantContentPad;

    add(
      'C1',
      `外壳几何（${vw}px 档）：侧栏 ${wantSidebarWidth} / 工具条 ${SHELL.toolbarHeight} / 应用区内边距 ${want.top}·${want.right}·${want.bottom}·${want.left}`,
      near(sw, wantSidebarWidth) &&
        near(th, SHELL.toolbarHeight) &&
        near(pad[0], want.top) &&
        near(pad[1], want.right) &&
        near(pad[2], want.bottom) &&
        near(pad[3], want.left),
      `侧栏 ${sw.toFixed(1)} / 工具条 ${th.toFixed(1)} / 内边距 ${pad.join('·')}`,
    );
  }

  // ---------------------------------------------------------------- C2 队列几何
  {
    const head = q<HTMLElement>(root, '.qt-head');
    const row = q<HTMLElement>(root, '.qt-row');
    const cols = {
      source: q<HTMLElement>(root, '.qt-head .qt-c-source'),
      progress: q<HTMLElement>(root, '.qt-head .qt-c-progress'),
      status: q<HTMLElement>(root, '.qt-head .qt-c-status'),
      action: q<HTMLElement>(root, '.qt-head .qt-c-action'),
    };
    const w = (e: HTMLElement | null) => (e ? e.getBoundingClientRect().width : -1);
    const rowH = row ? row.getBoundingClientRect().height : -1;

    add(
      'C2a',
      `队列列宽：来源 ${QUEUE_TABLE.colSource} / 进度 ${QUEUE_TABLE.colProgress} / 状态 ${QUEUE_TABLE.colStatus} / 操作 ${QUEUE_TABLE.colAction}`,
      near(w(cols.source), QUEUE_TABLE.colSource) &&
        near(w(cols.progress), QUEUE_TABLE.colProgress) &&
        near(w(cols.status), QUEUE_TABLE.colStatus) &&
        near(w(cols.action), QUEUE_TABLE.colAction),
      `${w(cols.source)} / ${w(cols.progress)} / ${w(cols.status)} / ${w(cols.action)}`,
    );

    add(
      'C2b',
      `行高 ${QUEUE_TABLE.rowHeight}`,
      near(rowH, QUEUE_TABLE.rowHeight),
      `${rowH.toFixed(1)}${head ? '（表头 42，另计）' : ''}`,
    );

    const running = q<HTMLElement>(root, '.qt-row.is-running');
    const rc = running ? getComputedStyle(running) : null;
    const bg = rc ? toHex(rc.backgroundColor) : '';
    const border = rc ? toHex(rc.borderTopColor) : '';
    add(
      'C2c',
      '当前运行行 = surface 底 + line 描边',
      !!rc && sameColor(bg, tokens.surface) && sameColor(border, tokens.line),
      `底 ${bg} / 描边 ${border}`,
    );
  }

  // ---------------------------------------------------------------- C3 状态色
  {
    // 状态点色相 = 状态令牌；状态文字 = ink（颜色不得作为唯一信息载体）
    const rows = Array.from(root.querySelectorAll('.qt-row'));
    const pairs = rows.map((r) => {
      const dot = r.querySelector('.dot') as HTMLElement | null;
      const text = r.querySelector('.qt-c-status span:last-child') as HTMLElement | null;
      return {
        dot: dot ? toHex(getComputedStyle(dot).backgroundColor) : '',
        text: text ? toHex(getComputedStyle(text).color) : '',
      };
    });
    const expectedDots = [tokens.blue, tokens.warning, tokens.success, tokens.error];
    const dotsOk = expectedDots.every((c) => pairs.some((p) => sameColor(p.dot, c)));
    const textOk = pairs.length > 0 && pairs.every((p) => sameColor(p.text, tokens.ink));

    add(
      'C3a',
      '状态点色相：翻译中 blue / 部分失败 warning / 已完成 success / 失败 error',
      dotsOk,
      pairs.map((p) => p.dot).join(' · '),
    );
    add('C3b', '状态文字一律 ink（色相只由状态点承载）', textOk, pairs.map((p) => p.text).join(' · '));

    // 注意：`getComputedStyle` 回的是 `rgb(...)`，token 是 `#RRGGBB` —— **必须先 toHex 再比**。
    // 这里曾经漏了转换：C3c 用 `!sameColor(...)` 于是恒真（假通过），C3d 用 `sameColor(...)`
    // 于是恒假（假失败）。两条都骗人，而假通过更坏 —— 它让人以为检查过了。
    const danger = q<HTMLElement>(root, '.btn-danger');
    const dc = danger ? getComputedStyle(danger) : null;
    add(
      'C3c',
      '「取消」为破坏性次按钮，不得用 pink',
      !!dc && !sameColor(toHex(dc.color), tokens.pink) && !sameColor(toHex(dc.backgroundColor), tokens.pink),
      dc ? `文字 ${toHex(dc.color)} / 底 ${toHex(dc.backgroundColor)}` : '未渲染',
    );

    const primary = q<HTMLElement>(root, '.btn-primary');
    const pc = primary ? getComputedStyle(primary) : null;
    add(
      'C3d',
      '「重试」等主推进动作用模块主色（雾蓝）',
      !!pc && sameColor(toHex(pc.backgroundColor), tokens.blue),
      pc ? `实际 ${toHex(pc.backgroundColor)} / 期望 ${tokens.blue}` : '未渲染',
    );
  }

  // ---------------------------------------------------------------- C4 空态魔法阵
  {
    const magic = q<SVGElement>(root, '.magic');
    const r = magic ? magic.getBoundingClientRect() : null;
    add(
      'C4a',
      `空态魔法阵 ${QUEUE_EMPTY.magicCircle}×${QUEUE_EMPTY.magicCircle}`,
      !!r && near(r.width, QUEUE_EMPTY.magicCircle) && near(r.height, QUEUE_EMPTY.magicCircle),
      r ? `${r.width.toFixed(0)}×${r.height.toFixed(0)}` : '未渲染',
    );

    const ringEls = magic ? Array.from(magic.querySelectorAll('circle[stroke-dasharray]')) : [];
    const star = magic ? magic.querySelector('polygon') : null;
    const core = magic ? magic.querySelector('circle[r="6"]') : null;
    const lav = ringEls.length ? toHex(getComputedStyle(ringEls[0]).stroke) : '';
    add(
      'C4b',
      '四道同心环 + 五芒星 + 星核，颜色取自既有令牌（不新增令牌）',
      ringEls.length === 4 && !!star && !!core && sameColor(lav, tokens.lavender),
      `环 ${ringEls.length} 道 / 五芒星 ${star ? '有' : '无'} / 星核 ${core ? '有' : '无'} / 首环 ${lav}`,
    );

    const spin = magic ? q<HTMLElement>(magic, '.magic-spin') : null;
    const sc = spin ? getComputedStyle(spin) : null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dur = sc ? Number.parseFloat(sc.animationDuration) : -1;
    const iters = sc ? sc.animationIterationCount : '-';
    add(
      'C4c',
      `空态动效 rotate ${QUEUE_EMPTY.rotateSeconds}s linear infinite（减弱动效时停转）`,
      // 系统开启「减弱动效」时 base.scss 会把时长压到 0.001ms —— 那正是期望行为
      reduced ? dur <= 0.01 || dur === -1 : dur === QUEUE_EMPTY.rotateSeconds && iters === 'infinite',
      `时长 ${sc?.animationDuration ?? '-'} / 次数 ${iters} / 减弱动效 ${reduced ? '开' : '关'}`,
    );

    add(
      'C4d',
      '空态与任务列表互斥（有任务时不渲染空态）',
      !!q<HTMLElement>(root, '.empty'),
      '样张固定渲染空态；互斥由 App 按 hasRows 判定，见 QueueScreen 用法',
    );
  }

  // ---------------------------------------------------------------- C5 漫画库几何
  {
    const left = q<HTMLElement>(root, '.lib-left');
    /*
     * 页卡已按设计稿改成 `.page-card`：宽度交给网格、缩略图按 3/4.16 自适应，
     * 不再有固定的 110x165。判据随之改为量**页卡自身**的圆角与宽高比 ——
     * 继续钉 `.grid-card` 会一直量一个已不存在的元素（等于空断言）。
     */
    const card = q<HTMLElement>(root, '.page-card');
    const lw = left ? left.getBoundingClientRect().width : -1;
    const thumb = card ? (card.querySelector('.page-thumb') as HTMLElement | null) : null;
    const cw = thumb ? thumb.getBoundingClientRect().width : -1;
    const ch = thumb ? thumb.getBoundingClientRect().height : -1;
    const cr = card ? px(getComputedStyle(card).borderTopLeftRadius) : -1;
    add(
      'C5',
      `漫画库：左栏 ${LIBRARY.leftColumnWidth}；页卡 r12 / 缩略区 3:4.16`,
      // 🔴 页卡圆角 2026-10-26 按设计稿 `theme.css` 的 `.page-card { border-radius: 12px }` 由 8 改 12
      near(lw, LIBRARY.leftColumnWidth) && near(cr, 12) && cw > 0 && Math.abs(ch / cw - 4.16 / 3) < 0.08,
      `左栏 ${lw.toFixed(0)} / 缩略区 ${cw.toFixed(0)}×${ch.toFixed(0)} r${cr}`,
    );
  }

  // ---------------------------------------------------------------- C6 深色模式
  {
    const rootStyle = getComputedStyle(document.documentElement);
    const mismatched = Object.entries(tokens).filter(([k, v]) => {
      const actual = rootStyle.getPropertyValue(`--md-${k}`).trim().toLowerCase();
      return actual !== String(v).toLowerCase();
    });
    add(
      'C6a',
      `18 组令牌与当前（${mode === 'dark' ? '深色' : '浅色'}）主题逐字一致`,
      mismatched.length === 0,
      mismatched.length ? `不一致：${mismatched.map(([k]) => k).join(', ')}` : '18 / 18',
    );

    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    add(
      'C6b',
      '换主题只改变量、不改变结构（几何与主题无关）',
      !!sidebar && near(sidebar.getBoundingClientRect().width, wantSidebarWidth),
      `侧栏 ${sidebar ? sidebar.getBoundingClientRect().width.toFixed(0) : '-'}（该档期望 ${wantSidebarWidth}）`,
    );
  }

  // ---------------------------------------------------------------- C7 字体分工
  {
    const numEl = q<HTMLElement>(root, '.num');
    // 标题角色取工具条标题而非队列里的漫画名：漫画名是**用户内容**（可能含 Zen Maru Gothic
    // 未覆盖的简体字，会逐字回落到 Noto），而「标题/强调」指的是 UI 自身的标题字。
    const titleEl = document.querySelector('.toolbar-title') as HTMLElement | null;
    const bodyEl = document.querySelector('.content') as HTMLElement | null;

    const fam = (e: Element | null) => (e ? getComputedStyle(e).fontFamily : '');
    add(
      'C7a',
      '数字与标题走狮尾圆体 / 正文走悠哉字体',
      fam(numEl).includes('Swei Gothic CJK SC') &&
        !!titleEl &&
        fam(titleEl).includes('Swei Gothic CJK SC') &&
        fam(bodyEl).includes('Yozai'),
      `数字 ${fam(numEl).split(',')[0]} / 标题 ${fam(titleEl).split(',')[0]} / 正文 ${fam(bodyEl).split(',')[0]}`,
    );

    const loaded = [
      { f: '"Swei Gothic CJK SC"', weight: '700', ok: false },
      { f: '"Yozai"', weight: '400', ok: false },
    ].map((x) => ({
      ...x,
      ok: typeof document.fonts?.check === 'function' ? document.fonts.check(`${x.weight} 12px ${x.f}`) : false,
    }));
    add(
      'C7b',
      '狮尾圆体与悠哉字体已随应用分发且加载成功（不是回落到系统字体）',
      loaded.every((x) => x.ok),
      loaded.map((x) => `${x.f.replace(/"/g, '')} ${x.ok ? '✓' : '✗'}`).join(' · '),
    );

    // 必须限定在 `.qt-row` 内：表头也有一个 `.qt-c-progress`（写着「进度」两个字），
    // 它本来就没有计数节点，不限定就会取到它、数字节点数为 0。
    const prog = q<HTMLElement>(root, '.qt-row .qt-c-progress');
    const numNodes = prog ? prog.querySelectorAll(':scope > .num').length : 0;
    add(
      'C7c',
      '「N / M」计数拆两个文本节点（数字 Inter、其余 Noto）',
      numNodes >= 2,
      prog ? `数字节点 ${numNodes} 个` : '未渲染',
    );
  }

  // ---------------------------------------------------------------- B3 退出确认层
  {
    // 文档原文**独立抄录**，刻意不从 QuitConfirm.tsx import QUIT_CONFIRM_COPY ——
    // 那样就变成「常量等于自己」，自证而已。这里比的是一边文档、一边真实渲染出的 DOM 文本。
    // 出处：《02-Box-技术方案-ver1.0.md》§2.1
    //   | 真正退出 | 托盘菜单 → 退出 Box，需二次确认，文案：「退出后浏览器插件将无法提交翻译任务」 |
    const DOC_COPY = '退出后浏览器插件将无法提交翻译任务';

    const body = q<HTMLElement>(root, '.modal-body');
    // 规范化空白：模板里的缩进与换行不该影响文案判等
    const shown = body ? (body.textContent ?? '').replace(/\s+/g, '') : '';
    const want = DOC_COPY.replace(/\s+/g, '');
    add(
      'B3a',
      '退出确认层主文案**逐字**含《02》§2.1 的规定文案（引号内是字面量，不是「意思到位」）',
      !!body && shown.includes(want),
      body ? (shown.includes(want) ? '逐字命中' : `实际：${shown.slice(0, 60)}…`) : '未渲染',
    );

    // 动作区在 `modal-foot`（设计稿四段结构）；`.modal-actions` 是旧写法，留作回落
    const actions = Array.from(root.querySelectorAll('.modal-foot .btn, .modal-actions .btn')) as HTMLElement[];
    const labels = actions.map((b) => (b.textContent ?? '').trim());
    add(
      'B3b',
      '两个动作：「留在后台」（非破坏）与「退出喵坞」（破坏性）',
      labels.includes('留在后台') && labels.includes('退出喵坞'),
      labels.join(' / ') || '未渲染',
    );

    // 动作区在 `modal-foot`（设计稿四段结构）；`.modal-actions` 是旧写法，留作回落
    const danger =
      q<HTMLElement>(root, '.modal-foot .btn-danger') ?? q<HTMLElement>(root, '.modal-actions .btn-danger');
    const dc = danger ? getComputedStyle(danger) : null;
    add(
      'B3c',
      '「退出喵坞」用 error 破坏色（不用 pink —— pink 是推进色，不用在破坏动作上）',
      !!dc && sameColor(dc.backgroundColor, tokens.error) && !sameColor(dc.backgroundColor, tokens.pink),
      dc ? `底 ${toHex(dc.backgroundColor)}` : '未渲染',
    );
  }

  // ---------------------------------------------------------------- B2 服务状态点四态
  {
    // B2 的判据是「托盘图标在；**状态点反映 running/starting/stopped/error 四态**」。
    // 前半条由 Rust 自检覆盖（托盘与菜单项），后半条是纯前端映射，这里直接断言。
    const states: ServiceState[] = ['stopped', 'starting', 'running', 'error'];
    const views = states.map((s) => ({ s, ...stateView(s) }));
    const knownVars = new Set(Object.keys(tokens).map((k) => `--md-${k}`));

    add(
      'B2d',
      '服务状态点四态：色相互异、文案互异，且只取既有令牌（不新增颜色）',
      views.every((v) => knownVars.has(v.colorVar)) &&
        new Set(views.map((v) => v.colorVar)).size === 4 &&
        views.every((v) => v.text.length > 0) &&
        new Set(views.map((v) => v.text)).size === 4,
      views.map((v) => `${v.s}→${v.text}/${v.colorVar}`).join(' · '),
    );
  }

  // ---------------------------------------------------------------- C8 侧栏两级结构
  //
  // 判据来自《09》§3.1。**为什么必须新增**：ver1.0 的侧栏是「队列/漫画库/投放/设置」
  // 四项平级，ver2.0 改成「2 应用 + 分隔线 + 全局层」。这个改动一旦被改回去，
  // 现有 C1–C7 **一条都不会红**（它们只看几何与颜色，不看层级语义）——
  // 而"漫画翻译与音乐是否平级"恰恰是本轮 IA 重构的全部意义。
  //
  // ⚠️ 下面几条刻意**不**依赖当前是否停留在设置页：C8/C9 量的是侧栏与 Tab 行，
  // 它们在任何屏都成立。把它们写死成「必须在设置页测」会让断言在最该跑的
  // 场景（用户停在音乐屏）反而测不到。
  {
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    const appItems = Array.from(sidebar?.querySelectorAll('.nav-item.is-app') ?? []);
    const globalItems = Array.from(sidebar?.querySelectorAll('.nav-item.is-global') ?? []);
    const divider = sidebar?.querySelector('.sidebar-divider') as HTMLElement | null;

    /*
     * C8a 的判据源是**可访问名称**（`aria-label` 优先、回落 `title`），不是按钮里的
     * `<span>` 文字。
     *
     * 为什么必须换成它：应用入口现在有两种形态（「图标 + 文字」58×52 / 纯图标 44×44，
     * 由「侧栏图标标签」偏好决定，台账 D-84）。判据若读 `<span>`，纯图标态下这一串
     * 恒为空 ⇒ C8a 无条件变红 —— 那是把"用户主动关掉了标签"误报成"侧栏结构坏了"。
     * 而结构（恒 2 项、顺序「漫画翻译 → 音乐」）与有没有文字是**两件事**，本该分开判。
     * 换成可访问名称后，两种形态下判据都成立，口径也与读屏一致。
     */
    const names = appItems.map((e) => (e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '').trim());
    /*
     * ⚠️ 2026-10-30：番剧入口暂时隐藏（`Sidebar.tsx` 的 `SHOW_ANIME_ENTRY`），应用层回到 2 项。
     * 这条判据**恒与真实入口数同值** —— 恢复番剧入口时必须同步改回 3，否则自检会红。
     */
    add(
      'C8a',
      '侧栏应用层恒为 2 项且顺序为「漫画翻译 → 音乐」（按可访问名称判，与是否显示文字无关）',
      appItems.length === 2 && names[0] === APP_LABEL.translate && names[1] === APP_LABEL.music,
      `实际 ${appItems.length} 项：${names.join(' / ') || '无'}`,
    );

    // 纯图标 = 没有可见文字。判据取「文字节点为空」，不是「宽度小于某个值」——
    // 后者会在有人误设 font-size:0 时假通过。
    const globalWithText = globalItems.filter((e) => {
      const span = e.querySelector('span');
      return !!span && (span.textContent ?? '').trim().length > 0;
    });
    const missingLabel = globalItems.filter((e) => !e.getAttribute('title') && !e.getAttribute('aria-label'));
    add(
      'C8b',
      '设置为纯图标（无可见文字），但补回可发现性（title / aria-label 至少有一个）',
      globalItems.length === 1 && globalWithText.length === 0 && missingLabel.length === 0,
      `全局项 ${globalItems.length} 个 / 带文字 ${globalWithText.length} 个 / 缺提示 ${missingLabel.length} 个`,
    );

    // 分隔线位置是「两级结构」的真正判据：应用层恒在它之上，全局层恒在它之下。
    // 只查「分隔线存在」会漏掉「有人把设置挪到分隔线上方」这种改法。
    if (sidebar && divider) {
      const dTop = divider.getBoundingClientRect().top;
      const appTops = appItems.map((e) => e.getBoundingClientRect().top);
      const globalTops = globalItems.map((e) => e.getBoundingClientRect().top);
      const appsAbove = appTops.length > 0 && appTops.every((t) => t < dTop);
      const globalsBelow = globalTops.length > 0 && globalTops.every((t) => t > dTop);
      add(
        'C8c',
        `分隔线 ${SIDEBAR.divider.w}×${SIDEBAR.divider.h} 位于应用层与全局层之间（应用恒在上、全局恒在下）`,
        appsAbove && globalsBelow,
        `分隔线 top=${dTop.toFixed(0)} / 应用 top=[${appTops.map((t) => t.toFixed(0)).join(',')}] / 全局 top=[${globalTops
          .map((t) => t.toFixed(0))
          .join(',')}]`,
      );
    } else {
      add('C8c', '分隔线位于应用层与全局层之间', false, divider ? '侧栏未找到' : '未找到 .sidebar-divider');
    }

    /*
     * C8d：**几何必须与"有没有标签"同时变**（台账 D-84）。
     *
     * 单看"尺寸等于某一套常量"是不够的 —— 真正会出错的是**只改了一半**：
     * 关掉文字却留着 58×52，每个入口下方多出一截空白，读起来像"漏了字"而不是
     * "刻意只剩图标"（`.nav-item.is-global` 的注释里记过同一个坑）。
     * 所以判据成对：**有没有 span** ⇒ **量到的宽高必须是那套常量**。
     *
     * 第二条（两套常量都不小于 44）是**点击热区下限**：将来想再瘦一点时，
     * 这里会先红，而不是等用户点不中才发现。
     */
    const geoms = appItems.map((e) => {
      const r = e.getBoundingClientRect();
      // 可见性取 computed style：响应式断点会把标签 `display:none`，但文字节点还在 DOM 里。
      // 只读 textContent 会把「窄屏纯图标轨」误判成「图标+文字却用了 44×44」。
      const label = e.querySelector('span');
      const hasText =
        !!label && getComputedStyle(label).display !== 'none' && (label.textContent ?? '').trim().length > 0;
      const want = hasText ? SIDEBAR.appItem : SIDEBAR.iconOnlyItem;
      return {
        hasText,
        w: r.width,
        h: r.height,
        ok: near(r.width, want.w) && near(r.height, want.h),
      };
    });
    const minTouch = 44;
    add(
      'C8d',
      `应用入口几何与标签形态一致（图标+文字 ${SIDEBAR.appItem.w}×${SIDEBAR.appItem.h} / 纯图标 ${SIDEBAR.iconOnlyItem.w}×${SIDEBAR.iconOnlyItem.h}），且两套都不小于 ${minTouch}`,
      geoms.length > 0 &&
        geoms.every((g) => g.ok) &&
        [SIDEBAR.appItem, SIDEBAR.iconOnlyItem].every((s) => s.w >= minTouch && s.h >= minTouch),
      geoms.length > 0
        ? geoms
            .map(
              (g) =>
                `${g.hasText ? '图标+文字' : '纯图标'} ${g.w.toFixed(0)}×${g.h.toFixed(0)}${g.ok ? '' : ' ← 与形态不符'}`,
            )
            .join(' / ')
        : '未找到应用入口',
    );
  }

  // ---------------------------------------------------------------- C9 视图 Tab 顺序
  //
  // 判据来自《09》§3.2：**投放 → 队列 → 漫画库**（真实工作流时序）。
  // ver1.0 的「队列→漫画库→投放」与之逆序，是历史遗留，本轮纠正。
  //
  // ⚠️ 刻意**校验顺序**而非只校验存在 —— 文档明写「顺序错即红，不只查存在」。
  // 上一轮就有个反面教训：断言只查"存在"时，把三个 Tab 排成任何顺序都全绿。
  {
    /*
     * 🔴 2026-10-26：页签改成通用单元 `.ui-vtab`（漫画/音乐共用）。
     *    原来这里选的是 `.viewtabs .viewtab` —— 改名后**一个都选不到**，
     *    于是 `tabs.length === 0` 走"跳过"分支、判绿：C9 从那一刻起就没在检查任何东西。
     *    现在按**容器**判断"是否在翻译应用内"，按**页签**判断顺序：
     *    · 容器 `.ui-vtabs` 不在 ⇒ 确实没进翻译应用，跳过（不是失败）；
     *    · 容器在但页签一个都没有 ⇒ 渲染坏了，**判红**（不能拿"跳过"当通过）。
     */
    const bar = document.querySelector('.ui-vtabs');
    if (!bar) {
      add(
        'C9',
        '视图 Tab 顺序恒为「投放 → 队列 → 漫画库」',
        true,
        '当前不在翻译应用内，Tab 未渲染（跳过，非通过依据）',
      );
    } else {
      const tabs = Array.from(bar.querySelectorAll('.ui-vtab'));
      const texts = tabs.map((e) => (e.textContent ?? '').trim());
      const want = TRANSLATE_VIEWS.map((v) => v.label);
      const orderOk = texts.length === want.length && texts.every((t, i) => t === want[i]);
      add(
        'C9',
        `视图 Tab 顺序恒为「${want.join(' → ')}」（顺序错即红，不只查存在）`,
        orderOk,
        `实际 ${texts.length} 项：${texts.join(' → ')}`,
      );
    }
  }

  // ---------------------------------------------------------------- C10 设置两栏壳
  {
    // 量的是**真实渲染的两栏**，不是常量。离屏样张已被移出壳外（否则它 0 宽的
    // flex item 会被推开左栏，让定宽判据假性不成立），故壳内只有 nav + main。
    //
    // 设计稿容器是 `.settings-layout`（grid 两列），左栏是**分区栏**（右分隔线，非卡片）。
    const shell = document.querySelector('.settings-layout') as HTMLElement | null;
    const nav = shell?.querySelector('.settings-nav') as HTMLElement | null;
    const main = shell?.querySelector('.settings-main') as HTMLElement | null;

    if (!shell || !nav || !main) {
      add('C10a', '设置页为两栏壳（左 192px + 右自适应）', true, '当前不在设置页（跳过，非通过依据）');
    } else {
      const navW = nav.getBoundingClientRect().width;
      const shellW = shell.getBoundingClientRect().width;
      const mainW = main.getBoundingClientRect().width;
      const ncs = getComputedStyle(nav);
      const mcs = getComputedStyle(main);
      const scs = getComputedStyle(shell);
      const shellKids = Array.from(shell.children);
      /*
       * 1040 以下壳改为上下布局：分组导航横排、占满壳宽，右栏同宽。
       * 这一档不再要求定宽 —— 响应式本身就是「结构随宽度变」，
       * 但「左右两栏在同宽约束下都不溢出」仍然要成立。
       */
      const stacked = isCompact;
      const wantNavW = isMedium ? SETTINGS.navWidthCompact : SETTINGS.navWidth;
      const layoutOk = stacked
        ? near(navW, shellW) && near(mainW, shellW)
        : near(navW, wantNavW) && scs.display === 'grid';
      add(
        'C10a',
        stacked
          ? '设置页窄屏形态：分组导航横排、左右同宽不溢出（单列壳）'
          : `两栏壳：左栏 ${wantNavW}px（grid 定列）+ 右栏自适应/min-width:0`,
        layoutOk && mcs.minWidth === '0px',
        `左栏 ${navW.toFixed(0)} / 右栏 ${mainW.toFixed(0)} / 壳 ${shellW.toFixed(0)} / 壳 ${scs.display} / ${ncs.position} · 右栏 minWidth ${mcs.minWidth}`,
      );

      // 一次只渲染一个分组。用「壳内除 nav/main 外无第三个结构子元素」+ 「右栏只挂载一组」判断。
      const renderedSections = shellKids.filter(
        (k) => !k.classList.contains('settings-nav') && !k.classList.contains('settings-main'),
      );
      const headings = main.querySelectorAll('.settings-section-head').length;
      add(
        'C10b',
        '一次只渲染**一个**分组（右栏单组，不把 5 组全渲染再靠 CSS 隐藏）',
        renderedSections.length === 0 && headings === 1,
        `壳内额外结构子元素 ${renderedSections.length} 个 / 右栏头部 ${headings} 个（应为 0 / 1）`,
      );

      const navItems = nav.querySelectorAll('.set-nav-item');
      add(
        'C10c',
        '分组恒为 6 项（①通用 ②翻译服务 ③播放·媒体 ④资源与投放 ⑤关于 ⑥番剧设置）',
        navItems.length === 6,
        `左栏 ${navItems.length} 项：${
          Array.from(navItems)
            .map((e) => (e.querySelector('.set-nav-label')?.textContent ?? '').trim())
            .join(' / ') || '无'
        }`,
      );
    }
  }

  // ---------------------------------------------------------------- C11 设置小节分层
  {
    // 判据来自《09》§4.3：②翻译服务恒含四小节。
    //
    // ⚠️ 这里**不**判「小节标题是 uppercase」。四个小节名是中文（翻译来源 / 服务与配对 /
    // 推理引擎 / 模型与诊断），`text-transform:uppercase` 对中文**没有任何视觉变化** ——
    // 那条断言无论实现对错都恒真，是一条测不出东西的假断言。判据改为
    // 「②恰好渲染 4 个 .set-subtitle」，它在小节被抹平时会真的变红。
    // （CSS 里保留 uppercase 属性：将来小节名改用英文时它会立刻生效。）
    const main = document.querySelector('.settings-main') as HTMLElement | null;
    const subs = Array.from(main?.querySelectorAll('.set-subtitle') ?? []);
    const isTranslate = (main?.querySelector('.settings-title')?.textContent ?? '').trim() === '翻译服务';

    if (!main || !isTranslate) {
      add(
        'C11',
        '②翻译服务恒含四小节（翻译来源 / 服务与配对 / 推理引擎 / 模型与诊断），小节标题独立于项',
        true,
        '当前不在②翻译服务（跳过，非通过依据）',
      );
    } else {
      const texts = subs.map((e) => (e.textContent ?? '').trim());
      const want = ['翻译来源', '服务与配对', '推理引擎', '模型与诊断'];
      add(
        'C11',
        '②翻译服务恒含四小节（小节标题独立于项；抹平小节即红）',
        texts.length === 4 && texts.every((t, i) => t === want[i]),
        `实际 ${texts.length} 个小节：${texts.join(' / ') || '无'}`,
      );
    }
  }

  // ---------------------------------------------------------------- C12 行控件几何
  //
  // 设计稿右列那一排控件**各有各的尺寸**（下拉 186×32、小按钮 28、只读值 28、开关 38×22），
  // 把它们"顺手统一成同一高度"是最常见的一种换皮。这条量的就是渲染值，
  // 期望表在 `themes/tokens.ts` 的 `SETTINGS.ctl*`（每条都注明了设计稿原选择器）。
  {
    const box = q<HTMLElement>(root, '.set-row-ctl');
    if (!box) {
      add(
        'C12',
        '行控件几何与设计稿逐值一致（下拉 / 小按钮 / 只读值 / 开关）',
        false,
        '样张里找不到 .set-row-ctl —— 样张与判据脱节，这条会变成永远不跑的僵尸',
      );
    } else {
      const sel = q<HTMLElement>(box, '.ui-select');
      const btn = q<HTMLElement>(box, '.btn-sm');
      const ro = q<HTMLElement>(box, '.set-ro');
      const sw = q<HTMLElement>(box, '.switch');
      const knob = q<HTMLElement>(box, '.switch-track > i');
      const num = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null);
      const sty = (el: HTMLElement | null) => (el ? getComputedStyle(el) : null);
      const selR = num(sel);
      const btnR = num(btn);
      const btnS = sty(btn);
      const roR = num(ro);
      const roS = sty(ro);
      const swR = num(sw);
      // 🔴 圆点量**计算值**而不是 `getBoundingClientRect()`：is-on 的圆点带 `transform:
      // translateX(16px)` 且挂着弹簧过渡，首帧量到的盒可能还在过渡中途 —— 那条判据会变成
      // "第一次跑红、第二次绿"，而自检里出现假红比没有这条判据更糟（用户从此不信它）。
      const knobS = sty(knob);
      const knobW = knobS ? px(knobS.width) : -1;
      const knobH = knobS ? px(knobS.height) : -1;
      // **只有"量到了 0"才跳过**（样张比判据慢一步，还没布局完）—— 那不是规格偏离。
      // 元素**缺失**照红：样张是我们自己维护的，掉了就说明判据在量一个不存在的东西。
      const notReady = !!selR && selR.width === 0 && !!swR && swR.width === 0;
      if (notReady) {
        add(
          'C12',
          `行控件几何逐值一致（下拉 ${SETTINGS.ctlSelectWidth}×${SETTINGS.ctlSelectHeight} / 小按钮 / 只读值 / 开关）`,
          true,
          '样张尚未完成布局（跳过，非通过依据）—— 再点一次运行自检即可',
        );
      } else {
        /*
         * 这条**只量几何**（盒宽高是 used value，稳）。
         * 刻意不比字号：字号走 `calc(Npx * var(--ui-scale))`（构建期注入，见 D-347），
         * 实测新页面第一次自检时它会有一瞬取不到变量（回落到继承的 13.5px），
         * 判据就变成「第一次跑红、第二次绿」—— 会假红的断言比没有更坏，它教会用户不信自检。
         * 字号阶梯本来就由 C2/C7 那批排版判据覆盖，它们量的是同一批样张的稳定面。
         */
        const okSel = near(selR!.width, SETTINGS.ctlSelectWidth) && near(selR!.height, SETTINGS.ctlSelectHeight);
        const okBtn =
          near(btnR!.height, SETTINGS.ctlBtnSmHeight) && !!btnS && near(px(btnS.borderRadius), SETTINGS.ctlBtnSmRadius);
        const okRo =
          near(roR!.height, SETTINGS.ctlRoHeight) && !!roS && near(px(roS.borderRadius), SETTINGS.ctlRoRadius);
        const okSw =
          near(swR!.width, SETTINGS.ctlSwitchWidth) &&
          near(swR!.height, SETTINGS.ctlSwitchHeight) &&
          near(knobW, SETTINGS.ctlSwitchKnob) &&
          near(knobH, SETTINGS.ctlSwitchKnob);
        add(
          'C12',
          `行控件几何逐值一致（下拉 ${SETTINGS.ctlSelectWidth}×${SETTINGS.ctlSelectHeight} / 小按钮 ${SETTINGS.ctlBtnSmHeight}·r${SETTINGS.ctlBtnSmRadius} / 只读 ${SETTINGS.ctlRoHeight}·r${SETTINGS.ctlRoRadius} / 开关 ${SETTINGS.ctlSwitchWidth}×${SETTINGS.ctlSwitchHeight}·圆点 ${SETTINGS.ctlSwitchKnob}）`,
          okSel && okBtn && okRo && okSw,
          [
            `下拉 ${selR ? `${selR.width.toFixed(0)}×${selR.height.toFixed(0)}` : '缺'}${okSel ? '' : ' ← 与 .s-row-control .select 不符'}`,
            `小按钮 ${btnR ? `${btnR.height.toFixed(0)}/r${btnS ? px(btnS.borderRadius) : '?'}` : '缺'}${okBtn ? '' : ' ← 与 .btn-sm 不符'}`,
            `只读值 ${roR ? `${roR.height.toFixed(0)}/r${roS ? px(roS.borderRadius) : '?'}` : '缺'}${okRo ? '' : ' ← 与 .readonly 不符'}`,
            `开关 ${swR ? `${swR.width.toFixed(0)}×${swR.height.toFixed(0)}` : '缺'} · 圆点 ${knobW > 0 ? `${knobW.toFixed(0)}×${knobH.toFixed(0)}` : '缺'}${okSw ? '' : ' ← 与 .switch-track/.switch-dot 不符'}`,
          ].join(' / '),
        );
      }
    }
  }

  return out;
}
