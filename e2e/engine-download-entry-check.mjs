#!/usr/bin/env node
/**
 * 引擎下载入口 / 独立下载页的静态钉子（D-233）
 * =============================================================================
 * 钉的是「侧栏入口、路由、完成关闭、重启对账」这四件事的**成因**，不是观感：
 *   E1 `downloadEntryState` 是唯三处共用的映射（running / paused / done / hidden），
 *      `done` 是否隐藏必须按 `startedAt` 与 dismissal 比对 —— 只判 `state === 'done'`
 *      会让"关掉后重启又冒出来"。
 *   E2 侧栏入口是纯图标：下载中 `Loader2` 旋转、中断 `CirclePause`、完成 `CircleCheck`；
 *      入口块里不得出现 `<span>` 可见文案。
 *   E3 `/engine-download` 是**覆盖层路由**（不进 `Screen` 枚举），且 `DownloadPane` 真的注册。
 *   E4 完成态必须显式给「关闭下载」；`onClose` 接线缺失时按钮只能"看起来像有"。
 *   E5 Rust `normalize_loaded` 只把 `running` 校正为 `interrupted` 并落盘；不校正则重启后
 *      `start_model_download` 的 409 会把「继续下载」也挡掉。
 *   E6 返回走浏览器返回栈；没有历史时回落默认屏，不能把用户留在空页。
 *
 * ## 反证（--refute）
 * 在**内存里**把每条判据的成因改回缺陷形态，判它变红；不写盘（这组判据不依赖编译）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ENGINE_DL = read('src/ipc/engine-download.ts');
const SIDEBAR = read('src/components/Sidebar.tsx');
const ROUTES = read('src/router/routes.ts');
const ROUTER = read('src/router/index.tsx');
const PANE = read('src/router/panes/DownloadPane.tsx');
const PANEL = read('src/screens/engine/DownloadPanel.tsx');
const STATE_RS = read('src-tauri/src/mangasvc/engine/state.rs');

const results = [];
const check = (id, label, ok, detail = '') => results.push({ id, label, ok: !!ok, detail });

const judgeEntry = (src) =>
  /export function downloadEntryState\(/.test(src) &&
  /view\.state === 'running'\) return 'running'/.test(src) &&
  /view\.state === 'interrupted' \|\| view\.state === 'failed'\) return 'paused'/.test(src) &&
  /dismissedStartedAt === key \? 'hidden' : 'done'/.test(src) &&
  /view\.startedAt != null \? 'paused' : 'hidden'/.test(src);

const judgeVisible = (src) => /return downloadEntryState\(view, dismissedStartedAt\) !== 'hidden';/.test(src);

const judgeSidebar = (src) => {
  const block = src.slice(
    src.indexOf('nav-item is-global is-download'),
    src.indexOf('nav-item is-global is-download') + 900,
  );
  return (
    src.includes("downloadEntry !== 'hidden' ? (") &&
    block.includes('is-download') &&
    block.includes('aria-label={DOWNLOAD_META[downloadEntry].label}') &&
    block.includes('title={DOWNLOAD_META[downloadEntry].label}') &&
    !/<span>/.test(block) &&
    src.includes('<Loader2') &&
    src.includes('<CirclePause') &&
    src.includes('<CircleCheck')
  );
};

const judgeRoutes = (srcRoutes, srcRouter) =>
  /path: '\/engine-download'/.test(srcRoutes) &&
  /OVERLAY_ROUTES/.test(srcRoutes) &&
  /\.\.\.SCREEN_ROUTES, \.\.\.OVERLAY_ROUTES/.test(srcRoutes) &&
  /OVERLAY_ROUTES\.map/.test(srcRouter) &&
  /<DownloadPane \/>/.test(srcRouter);

const judgePanel = (src) =>
  /const done = view\.state === 'done'/.test(src) &&
  /onClose: \(\) => void/.test(src) &&
  /关闭下载/.test(src) &&
  /onClick=\{onClose\}/.test(src);

const judgeNormalize = (src) =>
  /fn normalize_loaded\(mut d: ModelDownload\)/.test(src) &&
  /d\.state != "running"/.test(src) &&
  /d\.state = "interrupted"\.to_string\(\)/.test(src) &&
  /d\.interrupted_reason = Some\("应用已退出，下载已暂停"\.to_string\(\)\);/.test(src) &&
  /let \(d, changed\) = normalize_loaded\(d\);/.test(src) &&
  /if changed \{\s*d\.persist\(\);\s*\}/.test(src);

const judgeBack = (src) => /navigate\(-1\)/.test(src) && /DEFAULT_PATH, \{ replace: true \}/.test(src);

check('E1', '`downloadEntryState` 四态映射，且 done 按 startedAt 与 dismissal 比对', judgeEntry(ENGINE_DL));
check('E1b', '`isDownloadVisible` 复用同一映射（不另写一套）', judgeVisible(ENGINE_DL));
check('E2', '侧栏下载入口：设置之上、纯图标、三态图标、aria-label/title 齐备', judgeSidebar(SIDEBAR));
check('E3', '`/engine-download` 是覆盖层路由且 `DownloadPane` 已注册', judgeRoutes(ROUTES, ROUTER));
check('E4', '完成态显式「关闭下载」并接到 `onClose`', judgePanel(PANEL));
check('E5', '`normalize_loaded` 只把 running 校正为 interrupted 并原子落盘', judgeNormalize(STATE_RS));
check('E6', '返回走 `navigate(-1)`，无历史回落默认屏', judgeBack(PANE));

// ------------------------------------------------------------------ 输出
let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log('\n' + '─'.repeat(56));
console.log(`通过 ${results.length - fail} / 失败 ${fail}`);

// ------------------------------------------------------------------ 反证
if (process.argv.includes('--refute')) {
  if (fail > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const mutations = [
    [
      'M1 done 不再与 dismissal 比对（关掉后重启又冒出来）',
      () => judgeEntry(ENGINE_DL.replace("dismissedStartedAt === key ? 'hidden' : 'done'", "'done'")),
    ],
    [
      'M2 路由删掉 OVERLAY_ROUTES 注册（深链落到默认屏）',
      () => judgeRoutes(ROUTES, ROUTER.replace(/OVERLAY_ROUTES\.map[\s\S]*?\)\)\}/, '')),
    ],
    [
      'M3 完成态去掉 onClick={onClose}（按钮看起来有、点了没反应）',
      () => judgePanel(PANEL.replace('onClick={onClose}', '')),
    ],
    [
      'M4 normalize_loaded 不再写中断原因（重启后仍被当成在跑）',
      () => judgeNormalize(STATE_RS.replace('d.interrupted_reason = Some("应用已退出，下载已暂停".to_string());', '')),
    ],
    [
      'M5 下载入口塞进可见文字 span（纯图标约定破坏）',
      () =>
        judgeSidebar(
          SIDEBAR.replace(
            '{DOWNLOAD_META[downloadEntry].icon()}',
            '{DOWNLOAD_META[downloadEntry].icon()}<span>下载</span>',
          ),
        ),
    ],
    ['M6 返回不再走浏览器历史（用户被留在空页）', () => judgeBack(PANE.replace('navigate(-1)', ''))],
  ];
  let allRed = true;
  for (const [name, run] of mutations) {
    const red = run() === false;
    if (!red) allRed = false;
    console.log(`  ${red ? '✓' : '✗'} ${name} → ${red ? '按预期变红' : '**没有红**'}`);
  }
  console.log(
    `\nREFUTE: ${mutations.length - mutations.filter(([, run]) => run() !== false).length}/${mutations.length} 条按预期变红`,
  );
  process.exit(allRed ? 0 : 1);
}

process.exit(fail === 0 ? 0 : 1);
