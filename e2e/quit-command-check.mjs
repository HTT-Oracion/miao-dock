#!/usr/bin/env node
/**
 * 「退出喵坞」没反应的**根因钉子** —— 且必须可反证
 * ================================================================
 * ## 为什么是源码级断言，而不是"点一下试试"
 *
 * 这条缺陷发生在 **GUI 的退出路径**上，而本机没有桌面自动化权限（`osascript` 被 TCC 拒、
 * Windows 侧也没有可用的点击注入），**点不了那个按钮**。所以能自动化的部分只剩：
 * 把"会让退出失灵的那几个写法"钉在源码里 —— 谁改回去，哪一条立刻变红。
 *
 * 钉的**不是风格**，是**成因**（每一条都对应一个真实机制，不是"看起来更整洁"）：
 *
 *   Q1 `commands/mod.rs` 的 `quit_app` 必须是 **async 命令**。
 *      Tauri 的**同步**命令跑在**主线程**上，而 `AppHandle::exit` 在主线程上调用时
 *      **不保证真的退出**（官方讨论 tauri#3555 的原话：
 *      「you shouldn't call `AppHandle::exit` on the main thread」）——
 *      现象正是用户报的「点了『退出喵坞』没反应」：窗口照旧、进程照旧。
 *
 *   Q2 `service.rs` 的 `reap()` 收尾**不接受无界等待**。
 *      无界的 `handle.wait()` 一旦没等到（`taskkill` 没带走子进程：权限 / PID 复用 /
 *      进程卡在内核态）就**永远不返回**，连同整个退出流程一起挂死 —— 这是"没反应"的
 *      第二个成因。现在走 `try_wait()` + `REAP_GRACE` 上界：宁可放过孤儿（还有
 *      child-watch / parent-watch 兜底），也绝不无限等。
 *
 *   Q3 Windows `signal_tree` 的 `taskkill` 必须带 `CREATE_NO_WINDOW`。
 *      应用本体没有控制台，spawn 控制台程序会**蹦出一个 cmd 黑框** —— 观感问题，
 *      但用户会以为"中毒了"。
 *
 *   Q4 前端 `quitApp()` 的失败必须**不被静默吞掉**（要 `.catch(`）。
 *      旧版是 `void quitApp()`：IPC 被拒时**什么都不发生**，用户看到的就是"点了没反应"，
 *      而原因落在看不见的控制台里。现在至少把它摆到灵动岛上。
 *
 *   Q5 Windows `signal_tree` 的 `taskkill` 必须**无条件 `/F`**（先礼也强杀整树）。
 *      `taskkill /T` 不带 `/F` 时对控制台进程（node/python）**无效**（实测返回 255/128、
 *      进程一个不死），「先礼」名存实亡、还给了孙进程（执行器）被 reparent 的窗口 ——
 *      正是 D-89「重启后执行器成孤儿占 8001、翻译报 [Errno 22]/[Errno 20]」的成因。
 *
 * ## 反证轮（`--refute`）
 *   逐条把上面的写法**改回去** → 对应断言**必须变红** → 按字节还原。
 *
 * ⚠️ 边界，别误读：本脚本证明的是**"这四处成因的写法都被钉住了"**，
 *   **不是**"退出在 Windows 上真的能退" —— 那条仍然只能靠人点（台账 D-87 里如实标着）。
 *
 * 用法：
 *   node e2e/quit-command-check.mjs            正向跑（期望全绿）
 *   node e2e/quit-command-check.mjs --refute   反证轮（破坏 → 变红 → 还原）
 *
 * 约束：纯 Node、零依赖、不起任何进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMANDS_MOD = path.join(ROOT, 'src-tauri', 'src', 'commands', 'mod.rs');
const SERVICE_RS = path.join(ROOT, 'src-tauri', 'src', 'service', 'mod.rs');
// 黑框抑制（`CREATE_NO_WINDOW`）的唯一实现住在 lib 侧，`signal_tree` 调用它的 `hide_console`
const CHILD_WATCH_RS = path.join(ROOT, 'src-tauri', 'src', 'platform', 'child_watch.rs');
const APP_TSX = path.join(ROOT, 'src', 'App.tsx');

const REFUTE = process.argv.includes('--refute');

const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

const read = (f) => fs.readFileSync(f, 'utf8');

// ------------------------------------------------------------------ 正向断言

function runAll() {
  results.length = 0;

  const cmds = read(COMMANDS_MOD);
  const svc = read(SERVICE_RS);
  const childWatch = read(CHILD_WATCH_RS);
  const app = read(APP_TSX);

  // ---- Q1：quit_app 是 async 命令（不在主线程跑）----
  const fnIdx = cmds.indexOf('pub fn quit_app');
  // 取 `pub fn quit_app` **之前最近的一次** `#[tauri::command…]` 属性行：
  // 直接全文搜 `(async)` 会把"别的命令加了 async"误当成这一条已经修好。
  const attrStart = fnIdx >= 0 ? cmds.lastIndexOf('#[tauri::command', fnIdx) : -1;
  const attrEnd = attrStart >= 0 ? cmds.indexOf('\n', attrStart) : -1;
  const attr = attrStart >= 0 && attrEnd > attrStart ? cmds.slice(attrStart, attrEnd) : '';
  check(
    'Q1',
    'quit_app 声明为 **async 命令**（跑在异步运行时，不在主线程）—— 主线程上 `AppHandle::exit` 不保证退出',
    /#\[tauri::command\(async\)\]/.test(attr),
    attr ? `属性：${attr.trim()}` : '未定位到 quit_app 的 #[tauri::command…] 属性',
  );

  // ---- Q2：reap() 收尾有上界 ----
  check(
    'Q2',
    'reap() 收尾**不接受无界等待**：有 `REAP_GRACE` 上界 + `try_wait()`，且全文没有裸的 handle.wait()',
    svc.includes('REAP_GRACE') && svc.includes('try_wait()') && !svc.includes('p.handle.wait()'),
    `REAP_GRACE=${svc.includes('REAP_GRACE')} try_wait=${svc.includes('try_wait()')} 裸 handle.wait=${svc.includes('p.handle.wait()')}`,
  );

  // ---- Q3：Windows taskkill 不弹黑框 ----
  // 施加方式已收敛为共享助手 `hide_console`（`CREATE_NO_WINDOW` 的唯一实现住在 child_watch.rs），
  // `signal_tree` 的 Windows 分支调用它。两处都要钉：调用位被删、或助手不再施加这个标志，各自要红。
  {
    const tk = svc.indexOf('Command::new("taskkill")');
    const ntk = svc.indexOf('pub fn no_tree_kill');
    const winSignalTree = tk >= 0 && ntk > tk ? svc.slice(tk, ntk) : '';
    const hideAt = childWatch.indexOf('pub fn hide_console');
    const hideBody = hideAt >= 0 ? childWatch.slice(hideAt, hideAt + 300) : '';
    check(
      'Q3',
      'Windows signal_tree 的 taskkill 带 `CREATE_NO_WINDOW`（否则点退出会蹦出一个 cmd 黑框）',
      winSignalTree.includes('hide_console(&mut c)') && hideBody.includes('CREATE_NO_WINDOW'),
      `signal_tree 调 hide_console=${winSignalTree.includes('hide_console(&mut c)')} 助手施 CREATE_NO_WINDOW=${hideBody.includes('CREATE_NO_WINDOW')}`,
    );
  }

  // ---- Q4：前端退出失败不静默 ----
  check(
    'Q4',
    '前端 `quitApp()` 的失败**不被静默吞掉**（带 .catch → 提示到灵动岛，而不是"点了没反应"）',
    /void quitApp\(\)\.catch\(/.test(app),
    app.includes('void quitApp()') ? '找到了 quitApp() 调用' : '未找到 quitApp() 调用',
  );

  // ---- Q5：Windows signal_tree 无条件 /F（先礼也强杀整树）----
  // Windows 上 `taskkill /T` 不带 `/F` 对控制台进程（node/python）**无效**（实测返回
  // 255/128，进程一个不死），所以「先礼」名存实亡、还给了孙进程（执行器）被 reparent
  // 的窗口 —— 正是 D-89「重启后执行器成孤儿占 8001」的成因。修复后 Windows 分支不再用
  // `if force` 区分先礼/后兵，`c.arg("/F")` 无条件出现。
  {
    // 只取 Windows `signal_tree` 函数体（`Command::new("taskkill")` 到 `no_tree_kill` 之间）。
    // 用 `taskkill` 这个唯一锚点（不依赖换行符，跨 CRLF/LF）避开两处 `#[cfg(windows)]`
    // 与 unix 分支里正当的 `if force { SIGKILL } else { SIGTERM }`。
    const start = svc.indexOf('Command::new("taskkill")');
    const end = svc.indexOf('pub fn no_tree_kill');
    const winBody = start >= 0 && end > start ? svc.slice(start, end) : '';
    const unconditionalF = winBody.includes('c.arg("/F")') && !winBody.includes('if force {');
    check(
      'Q5',
      'Windows signal_tree 的 `/F` **无条件**出现（先礼也强杀整树 —— 不带 /F 对控制台进程无效，会留孤儿执行器）',
      unconditionalF,
      `c.arg("/F")=${winBody.includes('c.arg("/F")')} 条件if force=${winBody.includes('if force {')}`,
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

/// 每条变异 = 把上面某一处的写法**改回缺陷形态**，并声明哪几条断言必须因此变红。
const MUTATIONS = [
  {
    name: 'M1 quit_app 退回同步命令（回到主线程）',
    // 🔴 锚点必须**连到函数名**：本文件里 `#[tauri::command(async)]` 已有多处
    //    （service_stop / api_post …），只给属性行是"第一次出现即替换" ⇒ 变异打在**别的函数**上，
    //    Q1 不会变红，整条反证变成假绿。
    edits: [
      {
        file: COMMANDS_MOD,
        find: '#[tauri::command(async)]\npub fn quit_app',
        replace: '#[tauri::command]\npub fn quit_app',
      },
    ],
    expect: ['Q1'],
  },
  {
    name: 'M2 reap() 收尾退回无界等待',
    edits: [
      {
        file: SERVICE_RS,
        find: '        let reap_deadline = Instant::now() + REAP_GRACE;',
        replace: '        for p in procs.iter_mut() { let _ = p.handle.wait(); } // refute：退回无界等待',
      },
    ],
    expect: ['Q2'],
  },
  {
    name: 'M3 taskkill 不再抑制黑框（移除 signal_tree 里的 hide_console 调用）',
    edits: [{ file: SERVICE_RS, find: '    hide_console(&mut c);', replace: '    // refute：不再抑制黑框' }],
    expect: ['Q3'],
  },
  {
    name: 'M4 前端退出失败退回静默（扔掉 catch）',
    edits: [
      {
        file: APP_TSX,
        find: "void quitApp().catch((e: unknown) => push(errorText(e), 'bad'));",
        replace: 'void quitApp();',
      },
    ],
    expect: ['Q4'],
  },
  {
    name: 'M5 Windows signal_tree 退回「先礼不带 /F」（条件 /F ⇒ 孙进程执行器成孤儿）',
    edits: [
      {
        file: SERVICE_RS,
        find: '    c.arg("/F");',
        replace: '    if force {\n        c.arg("/F");\n    }',
      },
    ],
    expect: ['Q5'],
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
  console.log(`「退出喵坞」根因钉子${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    runAll();
    const { fail } = printResults('退出路径 · 根因钉子');
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
    let missing = false;
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      // 🔴 EOL 折算：本仓 `core.autocrlf=true`，工作区是 **CRLF**，而锚点字面量写的是 **LF**。
      //    不折算时**跨行锚点**永远"锚点未找到" → 该条静默不反证（跳过 ≠ 通过）。
      //    与 `units-structure-check.mjs` 同一处理（它在 2026-10-07 因同类问题长期漏跑 9 条）。
      const eol = txt.includes('\r\n') ? '\r\n' : '\n';
      const find = e.find.split('\n').join(eol);
      const repl = e.replace.split('\n').join(eol);
      if (!txt.includes(find)) {
        console.log(
          `⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`,
        );
        skipped += mut.expect.length;
        missing = true;
        continue;
      }
      fs.writeFileSync(e.file, txt.replace(find, repl));
    }
    if (missing) {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap); // 还原已改的那几处
      continue;
    }

    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    源文件会永久留成被破坏状态（E4 / E8 上都踩到过这一条）。
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
