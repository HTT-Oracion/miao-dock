#!/usr/bin/env node
/**
 * 「翻译服务自动启动 / 手动启停」的**根因钉子** —— 且必须可反证（台账 D-94）
 * ================================================================================
 * ## 为什么是源码级断言
 *
 * 这一组守的是「**不翻译就别把引擎拉起来**」这个开关背后的机制。它横跨 Rust（命令 +
 * 状态机 + 启动门）、前端（偏好 + effect + 按钮）三处，而每一处的失效形态都**不会报错**：
 * 编译过、`cargo check` 过、`tsc` 过、界面照常渲染。所以只能把「会让它出错的写法」
 * 钉在源码里 —— 谁改回去，哪一条立刻变红。
 *
 * 钉的**不是风格**，是**成因**（每条都对应一个真实机制）：
 *
 * ### 手动启停命令（Rust · commands.rs / service.rs）
 *   A1 `service_start` 必须走**幂等**入口 `start_once`，不能用裸 `start`。
 *      `React.StrictMode` 在开发期**故意把 effect 跑两遍**，加上"进入翻译模块自动启动"
 *      与用户连点，同一瞬间进来两三次是常态。非幂等的启动会让**两套三进程树去抢同一批
 *      端口**（① 5180–5190 / ② 8000+8001 / ③ 8080）—— 而"两个进程抢同一个端口"的报错
 *      离根因极远，现场看是乱七八糟的启动失败。
 *
 *   A2 `start_once` 的「判定 + 置位」必须压在**同一把锁**内。
 *      拆成"先 `status()` 再决定"就是两次加锁、两段临界区，中间有窗口期；
 *      而且 `return false`（提前退出）必须出现在 `self.start(app)` **之前** ——
 *      顺序颠倒等于"先起一套再判断要不要起"，幂等名存实亡。
 *
 *   A3 `service_stop` 必须是 `#[tauri::command(async)]`。
 *      `ServiceManager::stop()` 是**阻塞**的（先礼后兵 `STOP_GRACE` + 有界收尸
 *      `REAP_GRACE`，最坏约 5s）。同步命令跑在**主线程**，那几秒里窗口的消息泵一起
 *      冻住 —— 与 `quit_app` 同一条教训（tauri#3555，台账 D-87）。
 *
 *   A4 `service_stop` 在 `mgr.stop()` 之后必须**补发** `mgr.emit(&app)`。
 *      `ServiceManager::stop()` **自己不发出状态事件**（原先唯一的调用者
 *      `service_restart` 紧接着 `start()` 会 emit，所以看不出来）。手动停止是"停到
 *      `stopped` 就结束"，没有后续 emit ⇒ 不补这一发，前端订阅的 `miao://service-state`
 *      永远收不到，界面会一直停在「运行中」。
 *
 *   A5 `main.rs` 的 `generate_handler!` 必须注册 `service_start` / `service_stop`。
 *      漏注册的症状是前端 `invoke` 报 "command not found"，而这与"服务坏了"长得一样。
 *
 * ### 启动门（main.rs · D-94 的核心改动）
 *   B1 `main.rs` **不再无条件启动**服务：启动被收进测试通道
 *      （`if selftest::enabled() || capture::enabled()`）。
 *      两条反向的失效都记在这一条上：
 *        · 退回无条件启动 ⇒ 用户把开关关掉也照拉，功能等于没做；
 *        · 把启动**整段删掉**（以为前端会管）⇒ `selftest.rs` 的 S2 组断言五态轨迹、
 *          `capture.rs` 截真实界面全都失据，而且红的原因看着像"状态机坏了"。
 *
 * ### 前端自动启动策略（App.tsx）
 *   C1 自动启动 effect 的依赖**恰为** `[screen, autoStart]`，**不含 `status`**。
 *      放进 `status` 就变成"只要服务不是 running 就拉一次"：用户刚点完
 *      「停止本地服务」，下一秒被原地复活 —— 现场表现是"停不掉"，开关看着像失灵。
 *
 *   C2 effect 里两个守卫（`screen !== 'translate'` 与 `!autoStart`）都要在。
 *      少了 `screen` 守卫 ⇒ 应用一启动就拉（放弃"进模块才起"）；
 *      少了 `autoStart` 守卫 ⇒ 开关关掉也照拉。
 *
 *   C3 自动拉起用 `serviceStart()`，**不是** `serviceRestart()`。
 *      `restart` 是"停 + 起"，对一个本来就停止的服务多走一次**最坏 5s 的阻塞 stop**。
 *
 * ### 手动入口（NotReadyScreen / sections / ipc）
 *   D1 未就绪屏（X-C3）：`stopped` 态给「启动本地服务」（走 `onStart`），其余态给
 *      「重启本地服务」。对**停止**的服务说"重启"语义是错的，还多走一次阻塞 stop。
 *
 *   D2 「设置 → 翻译服务 → 服务与配对」的手动启停行：`serviceStart` 与 `serviceStop`
 *      都接线，且两枚按钮都**按状态置灰**（`stopped` 才可启动、`running` 才可停止）。
 *
 *   D3 `ipc.ts` 的 `serviceStart` / `serviceStop` 必须指到 `service_start` /
 *      `service_stop` 这两个真实命令名（指错名字 → invoke 落空，按钮点了没反应）。
 *
 * ### 服务实现的**默认档**（service.rs · F5.8）
 *   E1 未设 `MIAO_SERVICE_IMPL` ⇒ **默认 Rust boxsvc**（默认分支必须调到 `resolve_boxsvc`）。
 *      退回 node 是"摘除 Node"只写在文档里的形态：产品照旧起一份 Node 服务 —— 功能照常、
 *      e2e 全绿，而包里那份 Node 永远删不掉（计划文档 R3），验收标准①（转发数 = 0）
 *      也永远只是 `routes.rs` 里的一行注释。
 *
 *   E2 默认档拿不到 boxsvc 时退回 Node **必须可见**（`eprintln!` 带原因 + 构建指引）。
 *      静默退回会让"Rust 没生效"彻底不可观测 —— 而这正是 F5.8 想消灭的那种状态。
 *
 *   E3 显式 `MIAO_SERVICE_IMPL=rust` 仍**硬失败**（`resolve_boxsvc()?` 直接传播）。
 *      "说了算数"：显式切了却没生效、还悄悄换回 Node，等于切实现这件事没有可观测性。
 *      ⚠️ 与 E2 的分歧是**刻意的**：显式档硬失败、默认档可见退回（开发态只构建主 bin 时
 *      `target/debug/` 里没有 boxsvc，硬失败会把"跑起来看界面"变成"先读构建说明"）。
 *
 *   E4 显式 `=node` 档仍可达（对拍 / 排障要能把靶子换回去），且 Node 入口只在
 *      `node_service_cmd` 一处拼接 —— 两处各拼一份必然漂移。
 *
 *   E5 取值先 `trim` + 小写再比对（`RUST` / ` rust ` 必须算**显式**档）。少了它，
 *      带空格的显式档会掉进默认档 —— 症状是"我明明设了 rust 却没按显式档报错"。
 *
 * ## 反证轮（`--refute`）
 *   逐条把上面的写法改回缺陷形态 → 对应断言**必须变红** → 按字节还原。
 *
 * ⚠️ 边界，别误读：本脚本证明的是**这些成因的写法都被钉住了**，
 *   **不是**"开关在真机上真的按预期工作" —— 那条仍靠人点（台账 D-94 里如实标着）。
 *
 * 用法：
 *   node e2e/service-autostart-check.mjs            正向跑（期望全绿）
 *   node e2e/service-autostart-check.mjs --refute   反证轮（破坏 → 变红 → 还原）
 *
 * 约束：纯 Node、零依赖、不起任何进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMANDS_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'commands.rs');
const SERVICE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'service.rs');
const MAIN_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'main.rs');
const APP_TSX = path.join(ROOT, 'app', 'src', 'App.tsx');
const NOT_READY = path.join(ROOT, 'app', 'src', 'screens', 'NotReadyScreen.tsx');
// D-150：`sections.tsx` 已按 Section 拆到 `sections/*.tsx`。A9/D2 只看"代码里有没有这些调用"，
// 故读全部 Section 的**拼接**；D2 的变异锚落到 TranslateSection（服务启停 UI 在那儿）。
// ⚠️ 拼接必须**每次 runAll 重读**（不能做成模块级常量）—— 反证轮改的是磁盘上的文件，
//    常量只算一次 ⇒ 读到旧内容 ⇒ 该红不红（D2 实测假阳性）。
const SECTIONS_DIR = path.join(ROOT, 'app', 'src', 'screens', 'settings', 'sections');
const readSections = () =>
  fs
    .readdirSync(SECTIONS_DIR)
    .filter((n) => n.endsWith('.tsx'))
    .map((n) => fs.readFileSync(path.join(SECTIONS_DIR, n), 'utf8'))
    .join('\n');
const SECTION_TRANSLATE = path.join(SECTIONS_DIR, 'TranslateSection.tsx');
const IPC_TS = path.join(ROOT, 'app', 'src', 'ipc.ts');

const REFUTE = process.argv.includes('--refute');

const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

const read = (f) => fs.readFileSync(f, 'utf8');

/**
 * 取一个顶层函数的函数体（从签名到第一个行首 `}`）。
 *
 * ⚠️ 为什么不用"下一个 fn 签名"当右界：那会把右界绑在**邻居函数的名字**上，
 * 邻居一改名本函数的切片就横跨到别处（假绿/假红都可能）。行首 `}` 才是 Rust 顶层
 * 函数真正的收尾，且不依赖任何邻居。
 */
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const j = src.indexOf('\n}', i);
  return src.slice(i, j < 0 ? src.length : j + 2);
}

/** 取 `pub fn X` 之前最近的一次 `#[tauri::command…]` 属性行（跨行无关，取到行尾） */
function attrBefore(src, sig) {
  const i = src.indexOf(sig);
  const a0 = i >= 0 ? src.lastIndexOf('#[tauri::command', i) : -1;
  const a1 = a0 >= 0 ? src.indexOf('\n', a0) : -1;
  return a0 >= 0 && a1 > a0 ? src.slice(a0, a1) : '';
}

// ------------------------------------------------------------------ 正向断言

function runAll() {
  results.length = 0;

  const cmds = read(COMMANDS_RS);
  const svc = read(SERVICE_RS);
  const main = read(MAIN_RS);
  const app = read(APP_TSX);
  const nrs = read(NOT_READY);
  const sec = readSections(); // D-150：每次重读（反证轮改了磁盘上的文件）
  const ipc = read(IPC_TS);

  // ---- A1：service_start 走幂等入口 ----
  {
    const body = fnBody(cmds, 'pub fn service_start');
    check(
      'A1',
      '`service_start` 走**幂等**入口 `start_once`（不用裸 `start` —— StrictMode 双跑/连点会起两套进程树抢端口）',
      /mgr\.start_once\(&app\)/.test(body) && !/mgr\.start\(&app\)/.test(body),
      body ? `start_once=${/mgr\.start_once\(&app\)/.test(body)} 裸 start=${/mgr\.start\(&app\)/.test(body)}` : '未定位到 service_start 函数体',
    );
  }

  // ---- A2：start_once 判定与置位同锁、提前 return 在 start 之前 ----
  {
    const body = fnBody(svc, 'pub fn start_once');
    const hasLock = /self\.inner\.lock\(\)/.test(body);
    const hasStates = /ServiceState::Starting \| ServiceState::Running \| ServiceState::Stopping/.test(body);
    const earlyReturn = body.indexOf('return false') >= 0 && body.indexOf('return false') < body.indexOf('self.start(app)');
    check(
      'A2',
      '`start_once` 判定+置位压在**同一把锁**内，且 `return false`（提前退出）在 `self.start(app)` **之前**',
      hasLock && hasStates && earlyReturn && /self\.start\(app\)/.test(body),
      body
        ? `锁=${hasLock} 三态判定=${hasStates} 提前 return=${earlyReturn}`
        : '未定位到 start_once 函数体',
    );
  }

  // ---- A3：service_stop 是 async 命令 ----
  check(
    'A3',
    '`service_stop` 声明为 **async 命令**（阻塞 stop 最坏约 5s，同步命令会冻住主线程）',
    /#\[tauri::command\(async\)\]/.test(attrBefore(cmds, 'pub fn service_stop')),
    attrBefore(cmds, 'pub fn service_stop')
      ? `属性：${attrBefore(cmds, 'pub fn service_stop').trim()}`
      : '未定位到 service_stop 的 #[tauri::command…] 属性',
  );

  // ---- A4：service_stop 补发 emit ----
  {
    const body = fnBody(cmds, 'pub fn service_stop');
    check(
      'A4',
      '`service_stop` 在 `mgr.stop()` 之后**补发** `mgr.emit(&app)`（stop() 自己不发事件，不补则界面永远停在「运行中」）',
      /mgr\.stop\(\);/.test(body) && /mgr\.emit\(&app\);/.test(body),
      body ? `stop()=${/mgr\.stop\(\);/.test(body)} emit=${/mgr\.emit\(&app\);/.test(body)}` : '未定位到 service_stop 函数体',
    );
  }

  // ---- A5：命令已注册 ----
  check(
    'A5',
    '`main.rs` 的 `generate_handler!` 注册了 `service_start` 与 `service_stop`（漏注册 ⇒ invoke 报 command not found）',
    /commands::service_start,/.test(main) && /commands::service_stop,/.test(main),
    `service_start=${/commands::service_start,/.test(main)} service_stop=${/commands::service_stop,/.test(main)}`,
  );

  // ---- B1：启动收进测试通道；旧的无条件启动已撤干净 ----
  {
    const gate = 'if selftest::enabled() || capture::enabled() {';
    const gi = main.indexOf(gate);
    const gated = gi >= 0 && /start\(&handle\)/.test(main.slice(gi, gi + 220));
    // 「旧形态已撤干净」：setup 里那句裸的 `mgr.start(&handle);` 必须 0 命中。
    // （托盘菜单的 `mgr.start(app);` 是**用户点击**触发的「重启服务」，与自动启动无关，不在判据内。）
    const oldUnconditional = /mgr\.start\(&handle\);/.test(main);
    check(
      'B1',
      '`main.rs` **不再无条件启动**：启动只在自检/取证通道里（否则关掉开关也照拉；整段删掉则 S2 五态轨迹与截图取证双双失据）',
      gated && !oldUnconditional,
      `测试通道门=${gated} 旧无条件启动仍在=${oldUnconditional}`,
    );
  }

  // ---- C1：effect 依赖恰为 [screen, autoStart] ----
  {
    const call = app.indexOf('void serviceStart().catch(() => undefined);');
    const tail = call >= 0 ? app.slice(call, call + 200) : '';
    const m = tail.match(/\},\s*\[([^\]]*)\]\s*\)/);
    const deps = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const ok = call >= 0 && deps.length === 2 && deps.includes('screen') && deps.includes('autoStart') && !deps.includes('status');
    check(
      'C1',
      '自动启动 effect 的依赖**恰为** `[screen, autoStart]`，**不含 `status`**（含 status ⇒ 用户刚点的「停止」被瞬间复活）',
      ok,
      call < 0 ? '未定位到自动启动 effect 的 serviceStart() 调用' : `deps=[${deps.join(', ')}]`,
    );
  }

  // ---- C2：两个守卫都在 ----
  check(
    'C2',
    "自动启动 effect 两个守卫都在：`screen !== 'translate'`（进模块才起）与 `!autoStart`（关掉不拉）",
    /if \(screen !== 'translate' \|\| !autoStart\) return;/.test(app),
    '',
  );

  // ---- C3：自动拉起用 serviceStart，不是 serviceRestart ----
  {
    const call = app.indexOf('void serviceStart().catch(() => undefined);');
    const effStart = call >= 0 ? app.lastIndexOf('useEffect(', call) : -1;
    const effText = effStart >= 0 ? app.slice(effStart, call + 120) : '';
    check(
      'C3',
      '自动拉起用 `serviceStart()`（**不是** `serviceRestart()` —— restart 会多走一次最坏 5s 的阻塞 stop）',
      effStart >= 0 && /serviceStart\(\)/.test(effText) && !/serviceRestart\(/.test(effText),
      effStart < 0 ? '未定位到自动启动 effect' : '',
    );
  }

  // ---- D1：未就绪屏 stopped 给「启动」、其余给「重启」 ----
  {
    const anchor = "{state === 'stopped' ? (";
    const i = nrs.indexOf(anchor);
    const sep = i >= 0 ? nrs.indexOf(') : (', i) : -1;
    const endAll = sep >= 0 ? nrs.indexOf(')}', sep) : -1;
    const trueBr = i >= 0 && sep > i ? nrs.slice(i, sep) : '';
    const falseBr = sep >= 0 && endAll > sep ? nrs.slice(sep, endAll) : '';
    const ok =
      i >= 0 &&
      sep > i &&
      endAll > sep &&
      /onStart/.test(trueBr) &&
      /启动本地服务/.test(trueBr) &&
      /onRestart/.test(falseBr) &&
      /重启本地服务/.test(falseBr) &&
      /onStart: \(\) => void;/.test(nrs);
    check(
      'D1',
      '未就绪屏（X-C3）：`stopped` 态给「启动本地服务」(onStart)，其余态给「重启本地服务」(onRestart)',
      ok,
      i < 0 ? '未定位到 state === \'stopped\' 的三元分支' : `真分支含 onStart=${/onStart/.test(trueBr)} 假分支含 onRestart=${/onRestart/.test(falseBr)}`,
    );
  }

  // ---- D2：设置页手动启停行 ----
  check(
    'D2',
    '「服务与配对」手动启停行：`serviceStart` 与 `serviceStop` 都接线，且两枚按钮**按状态置灰**（stopped 才可启动 / running 才可停止）',
    /await serviceStart\(\);/.test(sec) &&
      /await serviceStop\(\);/.test(sec) &&
      /status\?\.state !== 'stopped'/.test(sec) &&
      /status\?\.state !== 'running'/.test(sec),
    `start=${/await serviceStart\(\);/.test(sec)} stop=${/await serviceStop\(\);/.test(sec)} 置灰=${/status\?\.state !== 'stopped'/.test(sec) && /status\?\.state !== 'running'/.test(sec)}`,
  );

  // ---- D3：ipc 命令名 ----
  check(
    'D3',
    "`ipc.ts` 的 `serviceStart` / `serviceStop` 指向真实命令名 `service_start` / `service_stop`",
    /export const serviceStart = \(\) => invoke<ServiceStatus>\('service_start'\)/.test(ipc) &&
      /export const serviceStop = \(\) => invoke<ServiceStatus>\('service_stop'\)/.test(ipc),
    '',
  );

  // ---- E（F5.8）：服务实现的**默认档** ----
  // 「默认仍是 node」是"摘除 Node"只写在文档里的形态：产品照旧起一份 Node 服务 —— 功能照常、
  // e2e 全绿，而包里那份 Node 永远删不掉（计划文档 R3）。这五条钉住默认档的**成因**。
  {
    const body = fnBody(svc, 'fn resolve_service_cmd()');
    const noBody = '未定位到 resolve_service_cmd 函数体';

    check(
      'E1',
      '未设 `MIAO_SERVICE_IMPL` ⇒ **默认走 Rust**（默认分支必须调到 `resolve_boxsvc`，不是直接拼 Node 入口）',
      /_ => match resolve_boxsvc\(\)/.test(body) && !/let entry = resolve_entry/.test(body),
      body ? `走 resolve_boxsvc=${/_ => match resolve_boxsvc\(\)/.test(body)}` : noBody,
    );

    check(
      'E2',
      '默认档拿不到 boxsvc 时退回 Node **必须可见**（`eprintln!` 带「退回 Node」+ 构建指引，不静默换回）',
      /eprintln!\(/.test(body) && /退回 Node/.test(body) && /cargo build --bin boxsvc/.test(body),
      body ? `eprintln=${/eprintln!\(/.test(body)} 构建指引=${/cargo build --bin boxsvc/.test(body)}` : noBody,
    );

    check(
      'E3',
      '显式 `MIAO_SERVICE_IMPL=rust` 仍**硬失败**（`resolve_boxsvc()?` 直接传播，绝不悄悄落回 node）',
      /"rust" \| "boxsvc" => Ok\(vec!\[resolve_boxsvc\(\)\?/.test(body),
      body ? '' : noBody,
    );

    check(
      'E4',
      '显式 `=node` 档仍可达（对拍 / 排障要能把靶子换回去），且入口解析只有一处 `node_service_cmd`',
      /"node" => node_service_cmd\(\)/.test(body) &&
        /fn node_service_cmd\(\)/.test(svc) &&
        /service\/src\/server\.mjs/.test(fnBody(svc, 'fn node_service_cmd()')),
      body ? `node 档=${/"node" => node_service_cmd\(\)/.test(body)}` : noBody,
    );

    check(
      'E5',
      '`MIAO_SERVICE_IMPL` 取值先 `trim` + 小写再比对（`RUST` / ` rust ` 必须算**显式**档，而不是掉进默认档）',
      /let impl_ = impl_\.trim\(\)\.to_ascii_lowercase\(\);/.test(body),
      body ? '' : noBody,
    );
  }
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

/**
 * 每条变异 = 把上面某一处的写法**改回缺陷形态**，并声明哪几条断言必须因此变红。
 *
 * ⚠️ 锚点换算见 `locate()`：本仓库 `core.autocrlf=true`，工作区是 **CRLF**，而这里的
 * 多行锚点字面量按 **LF** 写。不折算就会 `includes` 失败 ⇒ 该条被判"锚点未找到"而
 * **跳过**（跳过 ≠ 通过）。这个坑本仓库已在 music / units 两个脚本上踩过一次。
 */
const MUTATIONS = [
  {
    name: 'A1 service_start 退回非幂等的裸 start（StrictMode 双跑 ⇒ 两套进程树抢端口）',
    file: COMMANDS_RS,
    find: 'mgr.start_once(&app);',
    replace: 'mgr.start(&app);',
    expect: ['A1'],
  },
  {
    name: 'A2 start_once 的三态判定退化成只判 Running（忽略"启动中/正在停止"⇒ 幂等破口）',
    file: SERVICE_RS,
    find: '                ServiceState::Starting | ServiceState::Running | ServiceState::Stopping\n',
    replace: '                ServiceState::Running\n',
    expect: ['A2'],
  },
  {
    name: 'A3 service_stop 退回同步命令（阻塞 stop 最坏 5s 冻住主线程）',
    file: COMMANDS_RS,
    find: '#[tauri::command(async)]\npub fn service_stop',
    replace: '#[tauri::command]\npub fn service_stop',
    expect: ['A3'],
  },
  {
    name: 'A4 service_stop 去掉补发的 emit（前端永远收不到"已停止"，界面停在「运行中」）',
    file: COMMANDS_RS,
    find: '    mgr.stop();\n    mgr.emit(&app);\n',
    replace: '    mgr.stop();\n',
    expect: ['A4'],
  },
  {
    name: 'A5 从 generate_handler! 摘掉 service_start 注册（前端 invoke 报 command not found）',
    file: MAIN_RS,
    find: '            commands::service_start,\n',
    replace: '',
    expect: ['A5'],
  },
  {
    name: 'B1 启动门退回无条件启动（关掉开关也照拉 —— 功能等于没做）',
    file: MAIN_RS,
    find:
      '            if selftest::enabled() || capture::enabled() {\n' +
      '                let handle = app.handle().clone();\n' +
      '                app.state::<ServiceManager>().start(&handle);\n' +
      '            }\n',
    replace:
      '            let handle = app.handle().clone();\n' +
      '            let mgr = app.state::<ServiceManager>();\n' +
      '            mgr.start(&handle);\n',
    expect: ['B1'],
  },
  {
    name: 'C1 自动启动 effect 的依赖里塞进 status（用户刚点的「停止」被瞬间复活）',
    file: APP_TSX,
    find: '}, [screen, autoStart]);',
    replace: '}, [screen, autoStart, status]);',
    expect: ['C1'],
  },
  {
    name: "C2 去掉 effect 里的 !autoStart 守卫（开关关掉也照拉）",
    file: APP_TSX,
    find: "if (screen !== 'translate' || !autoStart) return;",
    replace: "if (screen !== 'translate') return;",
    expect: ['C2'],
  },
  {
    name: 'C3 自动拉起改调 serviceRestart（多走一次最坏 5s 的阻塞 stop）',
    file: APP_TSX,
    find: 'void serviceStart().catch(',
    replace: 'void serviceRestart().catch(',
    expect: ['C3'],
  },
  {
    name: 'D1 未就绪屏 stopped 态退回「重启本地服务」(onRestart)（对停止的服务说"重启"是错的）',
    file: NOT_READY,
    find: 'onClick={onStart}',
    replace: 'onClick={onRestart}',
    expect: ['D1'],
  },
  {
    name: 'D2 设置页「停止本地服务」误接成 serviceStart（按钮点了没反应 / 起反效果）',
    file: SECTION_TRANSLATE,
    find: 'await serviceStop();',
    replace: 'await serviceStart();',
    expect: ['D2'],
  },
  {
    name: 'D3 ipc 的 serviceStop 指错命令名（invoke 落空，点「停止」没反应）',
    file: IPC_TS,
    find: "export const serviceStop = () => invoke<ServiceStatus>('service_stop');",
    replace: "export const serviceStop = () => invoke<ServiceStatus>('service_restart');",
    expect: ['D3'],
  },
  {
    name: 'E1 默认档退回 node（"摘除 Node"只写在文档里 —— 产品照旧起一份 Node 服务）',
    file: SERVICE_RS,
    find: '        _ => match resolve_boxsvc() {',
    replace: '        _ => node_service_cmd(),\n        _unreachable_arm: match resolve_boxsvc() {',
    expect: ['E1'],
  },
  {
    name: 'E2 退回 Node 改成**静默**（"Rust 没生效"再也看不见）',
    file: SERVICE_RS,
    find: '                eprintln!("[miao-dock] ⚠ 默认档应为 Rust boxsvc，但{e}；本次退回 Node。想让默认档跑起来：cargo build --bin boxsvc");',
    replace: '                let _ = &e;',
    expect: ['E2'],
  },
  {
    name: 'E3 显式 rust 档也悄悄落回 node（"切了没生效"不可观测）',
    file: SERVICE_RS,
    find: '        "rust" | "boxsvc" => Ok(vec![resolve_boxsvc()?.to_string_lossy().into_owned()]),',
    replace: '        "rust" | "boxsvc" => resolve_boxsvc().map(|b| vec![b.to_string_lossy().into_owned()]).or_else(|_| node_service_cmd()),',
    expect: ['E3'],
  },
  {
    name: 'E4 把显式 `=node` 档下线（对拍 / 排障再也没法换回靶子）',
    file: SERVICE_RS,
    find: '        "node" => node_service_cmd(),',
    replace: '        "node" => Err("node 档已下线".to_string()),',
    expect: ['E4'],
  },
  {
    name: 'E5 取值不再 trim / 小写（`RUST` / ` rust ` 掉进默认档 —— "我明明设了"）',
    file: SERVICE_RS,
    find: '    let impl_ = impl_.trim().to_ascii_lowercase();',
    replace: '    let impl_ = impl_;',
    expect: ['E5'],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

/** 该文本用的是哪种换行（CRLF 工作区的文件读进来含 `\r\n`） */
const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

/** 把按 LF 写的锚点折算成目标文件实际的换行；找不到返回 null */
function locate(txt, find) {
  if (txt.includes(find)) return find;
  const alt = find.split('\n').join(eolOf(txt));
  return txt.includes(alt) ? alt : null;
}

const main = () => {
  console.log(`「翻译服务自动启动 / 手动启停」根因钉子${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    runAll();
    const { fail } = printResults('自动启动 · 手动启停');
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

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    if (!originals.has(mut.file)) originals.set(mut.file, readBytes(mut.file));
    const snap = originals.get(mut.file);
    if (snap == null) {
      console.log(`⚠ ${mut.name}\n    源文件读不到（${path.relative(ROOT, mut.file)}）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    const txt = snap.toString('utf8');
    const find = locate(txt, mut.find);
    if (find == null) {
      console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    const replace = mut.replace.split('\n').join(eolOf(txt));
    fs.writeFileSync(mut.file, txt.replace(find, replace));

    // 🔴 还原进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    源文件会永久留成被破坏状态。
    let res = {};
    let roundErr = null;
    try {
      runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, s] of originals) fs.writeFileSync(f, s);
    }

    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
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
