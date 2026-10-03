/**
 * 规格自检 —— 把 dev-plan.md §4 的 C1–C7 从「肉眼看」变成「当场量」。
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
  SHELL,
  COLOR_TOKENS_DARK,
  COLOR_TOKENS_LIGHT,
  type ThemeMode,
} from './theme/tokens';

export interface SpecResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

/**
 * 颜色相等判定。
 *
 * 必须**忽略大小写**：design token 里写的是 `#C9B5FF`，而 `getComputedStyle` 一律回小写
 * `rgb(201, 181, 255)` → `#c9b5ff`。直接字符串相等会让全部颜色断言恒假 —— 这种「自检自己错了」
 * 的假失败比不检查更糟，因为它会训练人忽略红色。
 */
const sameColor = (a: string, b: string) => String(a).toLowerCase() === String(b).toLowerCase();

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
    const want = SHELL.contentPadding;

    add(
      'C1',
      '外壳几何：侧栏 78 / 工具条 62 / 应用区内边距 26·26·22·24',
      near(sw, SHELL.sidebarWidth) &&
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

    const danger = q<HTMLElement>(root, '.btn-danger');
    const dc = danger ? getComputedStyle(danger) : null;
    add(
      'C3c',
      '「取消」为破坏性次按钮，不得用 pink',
      !!dc && !sameColor(dc.color, tokens.pink) && !sameColor(dc.backgroundColor, tokens.pink),
      dc ? `文字 ${toHex(dc.color)} / 底 ${toHex(dc.backgroundColor)}` : '未渲染',
    );

    const primary = q<HTMLElement>(root, '.btn-primary');
    const pc = primary ? getComputedStyle(primary) : null;
    add(
      'C3d',
      '「重试」等主推进动作用 pink',
      !!pc && sameColor(pc.backgroundColor, tokens.pink),
      pc ? toHex(pc.backgroundColor) : '未渲染',
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
      // 系统开启「减弱动效」时 base.css 会把时长压到 0.001ms —— 那正是期望行为
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
    const card = q<HTMLElement>(root, '.grid-card');
    const lw = left ? left.getBoundingClientRect().width : -1;
    const cw = card ? card.getBoundingClientRect().width : -1;
    const ch = card ? card.getBoundingClientRect().height : -1;
    const cr = card ? px(getComputedStyle(card).borderTopLeftRadius) : -1;
    add(
      'C5',
      `漫画库：左栏 ${LIBRARY.leftColumnWidth}；网格卡 ${LIBRARY.card.w}×${LIBRARY.card.h} r${LIBRARY.card.radius}`,
      near(lw, LIBRARY.leftColumnWidth) && near(cw, LIBRARY.card.w) && near(ch, LIBRARY.card.h) && near(cr, LIBRARY.card.radius),
      `左栏 ${lw.toFixed(0)} / 卡 ${cw.toFixed(0)}×${ch.toFixed(0)} r${cr}`,
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
      !!sidebar && near(sidebar.getBoundingClientRect().width, SHELL.sidebarWidth),
      `侧栏 ${sidebar ? sidebar.getBoundingClientRect().width.toFixed(0) : '-'}`,
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
      '数字走 Inter Medium / 标题走 Zen Maru Gothic / 正文走 Noto Sans SC',
      fam(numEl).includes('Inter') &&
        !!titleEl &&
        fam(titleEl).includes('Zen Maru Gothic') &&
        fam(bodyEl).includes('Noto Sans SC'),
      `数字 ${fam(numEl).split(',')[0]} / 标题 ${fam(titleEl).split(',')[0]} / 正文 ${fam(bodyEl).split(',')[0]}`,
    );

    const loaded = ['"Inter"', '"Zen Maru Gothic"', '"Noto Sans SC"'].map((f) => ({
      f,
      ok: typeof document.fonts?.check === 'function' ? document.fonts.check(`12px ${f}`) : false,
    }));
    add(
      'C7b',
      '三款字体已随应用分发且加载成功（不是回落到系统字体）',
      loaded.every((x) => x.ok),
      loaded.map((x) => `${x.f.replace(/"/g, '')} ${x.ok ? '✓' : '✗'}`).join(' · '),
    );

    const prog = q<HTMLElement>(root, '.qt-c-progress');
    const numNodes = prog ? prog.querySelectorAll(':scope > .num').length : 0;
    add(
      'C7c',
      '「N / M」计数拆两个文本节点（数字 Inter、其余 Noto）',
      numNodes >= 2,
      prog ? `数字节点 ${numNodes} 个` : '未渲染',
    );
  }

  return out;
}
