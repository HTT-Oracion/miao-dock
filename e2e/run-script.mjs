#!/usr/bin/env node
/**
 * 命令清单派发器 —— `npm run task -- <id>` 跑 `e2eScripts.json` 里的某一条。
 *
 * ## 为什么需要它（`package.json` 收束的代价必须在这里补回来）
 * 149 条 scripts 收束成三类入口之后，`package.json` 一眼可读了，但**"这条命令叫什么、
 * 怎么跑、属于哪一层"的入口没了**。没有替代品的收束只有两种结局：要么被人加回去，
 * 要么散进各人的历史命令里（`node e2e/xxx-check.mjs --refute` 手敲）。
 * 本文件就是那个替代品：清单是数据（`e2eScripts.json`），这里是唯一入口。
 *
 * ## 分层聚合仍然归 `run-checks.mjs`
 * 本文件**只跑一条**：不做分层、不做并行、不做 `--changed`、不产报告 ——
 * 那是 `npm run check[:full|:nightly|:changed]` 与 `node e2e/run-checks.mjs --only <id>`
 * 的活。两条路各有一个"专业"，重叠越少越好：多跑几条请用 `--only`（那里有分层、
 * 端口串行纪律、超时与失败尾部输出）。
 *
 * ## 三条纪律（照抄 run-checks 的防假绿口径）
 *   ① **条数写死并断言**：清单条数与分层由 `check:registry` 双向断言，不在这里数。
 *   ② **跳过必须非零退出**：点名一个不存在的 id ⇒ 退出码 2（不是"跑了个空说通过"）；
 *      清单里的 `cmd` 形态非法 / 指向的脚本不在盘上 ⇒ 退出码 3 并点名。
 *   ③ **不认识的形态一律响亮失败**：本 runner 只认 `node <相对路径> [args…]`，
 *      不做 shell、不接 `&&`（见 `_commands.mjs` 的解析口径）。
 *
 * ## 用法
 *   node e2e/run-script.mjs                     # 列清单（分组 + id + 说明），退出码 2
 *   node e2e/run-script.mjs --list [分组…]      # 同上，退出码 0
 *   node e2e/run-script.mjs check:units         # 跑一条
 *   node e2e/run-script.mjs check:units:refute  # 反证轮（基条目派生，见 _commands.mjs）
 *   node e2e/run-script.mjs fetch:models --link # id 之后的参数原样透传给脚本（多一个 `--` 也认）
 * 等价 npm 形态：`npm run task -- <id>`
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

import { buildCommands, commandIndex, GROUP_ORDER, ROOT } from './_commands.mjs';

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const pad = (s, n) => String(s).padEnd(n);

const COMMANDS = buildCommands();
const BY_ID = commandIndex();

function printList(groups) {
  const picked = COMMANDS.filter((c) => groups.length === 0 || groups.includes(c.group));
  let w = 0;
  for (const c of picked) w = Math.max(w, c.id.length);
  for (const g of GROUP_ORDER) {
    const inGroup = picked.filter((c) => c.group === g);
    if (inGroup.length === 0) continue;
    console.log(`\n── ${g}（${inGroup.length} 条）──`);
    for (const c of inGroup) console.log(`  ${pad(c.id, w)}  ${c.desc}`);
  }
  console.log(`\n共 ${picked.length} 条（清单 ${COMMANDS.length} 条 = 基条目 + 派生反证轮）`);
  console.log(`跑一条：npm run task -- <id>      （分层聚合：npm run check[:full|:nightly]）`);
  console.log(`看说明：npm run task -- --list <分组>  （分组：${GROUP_ORDER.join(' / ')}）`);
}

const argv = process.argv.slice(2);

// 没给参数：只列清单，但**退出码非零** —— "什么都没跑"不许长得像成功
if (argv.length === 0) {
  console.log('⚠️ 这是清单，不是执行：没有跑任何命令。');
  printList([]);
  process.exit(2);
}

if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(
    '用法：node e2e/run-script.mjs <id> [脚本参数…] | --list [分组…]\n' +
      '      等价形态：npm run task -- <id>\n' +
      `      分层聚合不在这里：npm run check / check:full / check:nightly / check:changed`,
  );
  process.exit(0);
}

if (argv[0] === '--list') {
  const groups = argv.slice(1);
  const bad = groups.filter((g) => !GROUP_ORDER.includes(g));
  if (bad.length) {
    console.error(`未知分组：${bad.join(', ')}（可选 ${GROUP_ORDER.join(' / ')}）`);
    process.exit(2);
  }
  printList(groups);
  process.exit(0);
}

const [id, ...passthrough] = argv;
const entry = BY_ID.get(id);
if (!entry) {
  // 点名一个不存在的 id **必须**非零退出（静默跑空是最坏的形态）
  const near = [...BY_ID.keys()].filter((k) => k.includes(id) || id.includes(k.split(':').pop() ?? '')).slice(0, 8);
  console.error(`✗ 清单里没有这个 id：${id}`);
  if (near.length) console.error(`  是不是想跑：${near.join(' / ')}`);
  console.error(`  看全部：npm run task -- --list（清单共 ${COMMANDS.length} 条）`);
  process.exit(2);
}

if (entry.bad) {
  console.error(`✗ ${id} 这一条本身不合法：${entry.bad}`);
  console.error(`  清单：e2eScripts.json（分组 ${entry.group}）`);
  process.exit(3);
}

// `--` 是 npm 自己的分隔符。老写法 `npm run task -- fetch:models -- --link` 里那个多余的 `--`
// 当分隔符吃掉：留着它会让被测脚本看到 `--`（不少解析器到这里就停止解析后续旗标），
// 于是"同一个命令、从 runner 跑与直跑行为不一致" —— 那是最难查的一类差异。
const extra = passthrough[0] === '--' ? passthrough.slice(1) : passthrough;
const args = [...entry.args, ...extra];
const cmdLine = `node ${entry.script}${args.length ? ` ${args.join(' ')}` : ''}`;
console.log(`▶ ${entry.group} · ${id}`);
console.log(`  ${entry.desc}`);
console.log(`  ${cmdLine}${extra.length ? `   （后 ${extra.length} 个参数来自命令行透传）` : ''}\n`);

const t0 = Date.now();
const child = spawn(process.execPath, [entry.script, ...args], { cwd: ROOT, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`\n✗ 起不来：${err.message}`);
  process.exit(3);
});
child.on('exit', (code, signal) => {
  const ms = secs(Date.now() - t0);
  if (signal) {
    // 被信号打死不是"通过"，也不是普通的非零退出 —— 必须说出来是哪个信号
    console.error(`\n✗ ${id} 被信号 ${signal} 终止（${ms}）`);
    process.exit(1);
  }
  console.log(`\n${code === 0 ? '✓' : '✗'} ${id} ${code === 0 ? '通过' : `失败（退出码 ${code}）`} ${ms}`);
  process.exit(code ?? 1);
});
