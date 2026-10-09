// 引擎③（Sakura LLM / llama-server）的**生命周期持有者**
//
// ## 为什么在 box-service 里，而不是继续留在 Rust
// 《04》§9.1 规定 Tier1 空闲卸载（空闲 5 min → 停 ③）的**实现方是 box-service**，
// 理由原文写的是「③ 不在引擎 TTL 范围内」—— 引擎自带的 `--models-ttl` 只管视觉模型（Tier2），
// 管不到 ③。而"该不该卸载"这个判据只存在于 box-service（**任务队列在这里**，见 §9.2 的前置条件）。
//
// S2 时 ③ 是 Rust `ServiceManager` 的第三个子进程。若维持原样，box-service 既不知道 ③ 的 pid、
// 也没有拉起它的能力 ⇒ Tier1 根本无法实现。所以 S4 把归属移到这里：
//   · Rust 仍从 `print-launch-plan.mjs` 拿到 ③ 的配方，但只看 `owner: 'service'` 去**打印**（E1），不再 spawn；
//   · 配方本身仍由 `engine-client.mjs` 的 `resolveLlmLaunch()` **唯一**给出（换版本只改那一处）。
//
// ## E11（不留孤儿）靠什么保住
// 归属换了，但"主进程被 SIGKILL 后 8080 必须释放"这条不变。两条路都留着：
//   · 真档：本模块用 `engine/scripts/child-watch.mjs` 把 llama-server 包一层（外部二进制改不了、
//     指望不上它自己看住 ppid）；child-watch 盯的是**它的父进程 = 本进程(box-service)**，
//     box-service 一死它就把整棵子树带走。
//   · mock 档：替身是我们自己的 Node 进程，内部已装 `engine/src/parent-watch.mjs`（少一层进程）。
//   ⚠️ 两条路都依赖 `MIAO_NO_PARENT_WATCH` —— E11 的反证开关正是靠它**同时**关掉这两层看守。
//
// ## 状态机
// `stopped → starting → running → unloading → stopped`；异常进 `error`。
// ⚠️ 这里**不是**客户端状态机（《03》§4.5：引擎的准备/卸载/降档都不新增客户端状态机节点）。
//    它只喂 `sidecar.llm.state` 这一个诊断字段。
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { config, REPO_ROOT } from '../config.mjs';
import { resolveLlmLaunch } from '../engine-client.mjs';

/** `sidecar.llm.state` 的取值（沿用 §5.1 `sidecar.state` 的枚举词表） */
export const LLM_STATES = ['stopped', 'starting', 'running', 'unloading', 'error'];

/**
 * `child-watch` 看护器的绝对路径 —— 由 `config.REPO_ROOT`（**唯一仓库根**）拼出。
 *
 * 🔴 不再在本文件 `path.resolve(import.meta.dirname, '..', '..')`：本文件 ver2.2 被搬进了
 *    `service/src/settings/`，同样的 dots 数只到 `service/` ⇒ 路径被算成
 *    `service/engine/scripts/child-watch.mjs`，子进程 `Cannot find module` ⇒ ③ LLM 起不来
 *    ⇒ 翻译阶段报 `Sakura API请求失败…：Connection error.`（本次故障的直接根因）。
 *
 * 导出是给断言用的：`check:profile` 的 L 组直接钉「这个路径存在」——
 * 谁再把本文件搬一层、或改动仓库根算法，`npm run check:profile` 必须立刻变红，
 * 而不是等到用户点翻译才以「Connection error」的面目出现。
 */
export const CHILD_WATCH_PATH = path.join(REPO_ROOT, 'engine', 'scripts', 'child-watch.mjs');
const CHILD_WATCH = CHILD_WATCH_PATH;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function probeTcp(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function probeHttp(port, method, pathname, expect, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode === expect); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 从配方里取"人可读的模型标识"（`/engine/status` 的 `llm.model` 用它）。
 * 优先取配方**显式声明**的 `model`（`resolveLlmLaunch` 已经算好，含档位信息），
 * 其次才回落到从命令行反解 —— 反解是对**已发生的事**做字符串考古，容易在换参数时失真。
 */
function modelIdOf(launch) {
  // 🔴 两条分支必须**同形态**：从命令反解的那条本来就 `basename`，而"优先取 `launch.model`"这条
  // 原先漏了 —— 真档的 `launch.model` 是**绝对路径**（`tierModelPath()` 给的是盘上路径），
  // 于是 `/health.sidecar.model` 会把 `…/runtimes/manga-translator/models/sakura/sakura-…-fp16`
  // 整个泄出去。契约《03》§5.1 的示例是 **model id**（`sakura-1.5b-qwen2.5-v1.0-iq4xs`），
  // `/engine/status` 的 `llm.model` 同。E4.5 照出这处不一致（5/1）。
  if (launch.model) return path.basename(String(launch.model)).replace(/\.gguf$/i, '');
  const cmd = launch.cmd || [];
  const i = cmd.indexOf('-m');
  const file = i > -1 ? cmd[i + 1] : null;
  if (file) return path.basename(file).replace(/\.gguf$/i, '');
  return null;
}

export class LlmSupervisor {
  /**
   * @param {object} [opts]
   * @param {object} [opts.launch]  启动配方；缺省 `resolveLlmLaunch()`（按协议自动选 real/mock）
   * @param {boolean} [opts.watch]  是否用 child-watch 包一层；缺省 real 档为 true
   * @param {(m:string)=>void} [opts.log]
   * @param {Function} [opts.spawnImpl] 注入用（测试里替换成假的 spawn，不真的起进程）
   */
  constructor(opts = {}) {
    this.launch = opts.launch || resolveLlmLaunch();
    /** 真档才包 child-watch（见文件头）；mock 档替身自带父死看管 */
    this.watch = opts.watch ?? config.engineProtocol === 'real';
    this.log = opts.log || (() => {});
    this.spawnImpl = opts.spawnImpl || nodeSpawn;

    this.model = modelIdOf(this.launch);
    this.port = firstProbePort(this.launch);
    this.child = null;
    this.pid = null;
    this.state = 'stopped';
    this.lastError = null;
    this.startedAt = null;
    this.restarts = 0; // 空闲卸载后重新拉起的次数（E6 取证用）
    /** `_serial` 的操作链尾（见该方法注释） */
    this._op = Promise.resolve();
  }

  /**
   * 把所有会**改进程状态**的操作按 FIFO 串起来。
   *
   * 🔴 为什么必须有它：`_doStop()` 里有 `await`（等进程退出、等端口释放，真实场景可达数秒）。
   * 如果这期间插进来一个 `start()`（§9.3 懒加载恢复：任务到来 → `store.ensureLlm()`），
   * 两段代码会交错，症状是 **`_doStop()` 的收尾把新进程的状态抹掉**
   * （`state='stopped'`、`pid=null`），而新 ③ 其实还在跑 ——
   * 一个"状态说没有、实际有"的孤儿进程，正是本项目最忌讳的静默故障。
   *
   * 串行化之后，「判定 → 执行」之间不再有可插入的窗口 ⇒ §9.2 的时序前提由**结构**保证，
   * 而不是靠"这段代码跑得快"。与 `tier-downgrade.mjs` 把"仅降一次"写成幂等闩是同一种思路。
   */
  _serial(fn) {
    const next = this._op.then(fn, fn);
    this._op = next.then(() => {}, () => {});
    return next;
  }

  /** 机器可读快照 —— 直接喂 `sidecar.llm` / `/engine/status` 的 `llm` 字段 */
  snapshot() {
    return {
      state: this.state,
      model: this.model,
      port: this.state === 'stopped' ? null : this.port,
      pid: this.pid,
    };
  }

  isRunning() { return this.state === 'running'; }

  /**
   * 拉起 ③ 并等就绪探针全绿（`/v1/models` 真应答 —— 与 S2 的判据同源）。
   * 并发调用由 `_serial` 排队：后一个进入时若前一个已把它拉起（`state==='running'`），
   * 直接复用，不会拉起两个。
   */
  start(opts = {}) {
    return this._serial(() => this._startInner(opts));
  }

  async _startInner({ timeoutMs = 180_000 } = {}) {
    if (this.state === 'running') return this.snapshot();
    try {
      return await this._doStart(timeoutMs);
    } catch (err) {
      this.state = 'error';
      this.lastError = err.message;
      this.log(`[box-service] ③ LLM 拉起失败：${err.message}`);
      return this.snapshot();
    }
  }

  async _doStart(timeoutMs) {
    this.state = 'starting';
    this.lastError = null;

    // 🔴 起进程**之前**先确认看护器脚本真的在盘上。少了这一步，路径算错（或文件被移走）的表现是
    //    子进程瞬时 `MODULE_NOT_FOUND` 退出、而 supervisor 只报一句「③ LLM 未在 180s 内就绪」
    //    —— 把「路径算错了」伪装成「模型加载慢/超时」，正是本次排查一开始被误导的地方。
    if (this.watch && !fs.existsSync(CHILD_WATCH)) {
      throw new Error(`③ 看护器脚本不存在：${CHILD_WATCH}（仓库根算错或文件被移走）`);
    }

    const head = this.watch ? process.execPath : this.launch.cmd[0];
    const args = this.watch
      ? [CHILD_WATCH, '--', ...this.launch.cmd]
      : this.launch.cmd.slice(1);

    this.log(`[box-service] 拉起 ③ LLM：${[head, ...args].join(' ')}`);
    const child = this.spawnImpl(head, args, {
      cwd: this.launch.cwd || undefined,
      env: { ...process.env, ...(this.launch.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = Date.now();

    // ③ 的日志转到 box-service 的 stdout —— 卸载/重启这类事件必须**看得见**（§8/§9 都要求留痕）
    const relay = (stream, tag) => {
      stream?.on('data', (b) => {
        for (const line of String(b).split('\n')) {
          if (line.trim()) this.log(tag ? `[llm:${tag}] ${line.trim()}` : `[llm] ${line.trim()}`);
        }
      });
    };
    relay(child.stdout, '');
    relay(child.stderr, 'err');

    child.once('exit', (code, signal) => {
      if (this.child !== child) return; // 已被 stop() 接管的退出，不重复处理
      this.child = null;
      this.pid = null;
      this.state = 'stopped';
      this.log(`[box-service] ③ LLM 已退出（code=${code} signal=${signal}）`);
    });

    const ok = await this._waitReady(timeoutMs, child);
    if (!ok) {
      // 起不来不阻断服务本身：没有 LLM 只是翻译阶段会失败（S2 的崩溃分级口径）
      // ⚠️ 这里调 `_doStop`（内部实现）而不是公开的 `stop()` —— 后者会再进一次 `_serial`，
      //    而我们已经**在**串行链里了，再排队就是自己等自己（死锁）。
      await this._doStop({ reason: '启动超时' });
      throw new Error(`③ LLM 未在 ${Math.round(timeoutMs / 1000)}s 内就绪`);
    }
    this.state = 'running';
    this.log(`[box-service] ③ LLM 就绪：${this.model} @ ${this.port}（pid=${this.pid}）`);
    return this.snapshot();
  }

  async _waitReady(timeoutMs, child) {
    const probes = (this.launch.probes || []).length
      ? this.launch.probes
      : [{ kind: 'tcp', port: this.port }, { kind: 'http', port: this.port, method: 'GET', path: '/v1/models', expect: 200 }];
    const until = Date.now() + timeoutMs;
    const started = Date.now();
    let announced = false;
    for (;;) {
      // 进程已经死了就别再等满超时（否则"端口被占/参数写错"要等 3 分钟才报）
      if (child.exitCode !== null || child.signalCode) return false;
      let all = true;
      for (const p of probes) {
        if (p.kind === 'tcp') all = all && (await probeTcp(p.port, 300));
        else all = all && (await probeHttp(p.port, p.method || 'GET', p.path || '/', p.expect ?? 200, 300));
        if (!all) break;
      }
      if (all) return true;
      if (Date.now() > until) return false;
      if (!announced && Date.now() - started > 8000) {
        announced = true;
        this.log(`[box-service] ③ LLM 仍在启动（模型加载中）… 已等 ${Math.round((Date.now() - started) / 1000)}s`);
      }
      await sleep(250);
    }
  }

  /**
   * 停 ③ 并**等它真的退出、端口真的释放**。
   * 「真的退出」是本模块唯一重要的语义：§9.4 明说"卸载 ≠ 未就绪"，
   * 而"我以为它退了"和"它退了"的区别，只有等 `exit` + 回探端口能分开。
   */
  stop(opts = {}) {
    return this._serial(() => this._doStop(opts));
  }

  async _doStop({ reason = '', graceMs = 8000 } = {}) {
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      this.pid = null;
      return { stopped: false, why: '未在运行' };
    }
    this.state = 'unloading';
    this.log(`[box-service] 停止 ③ LLM${reason ? `（${reason}）` : ''}（pid=${this.pid}）`);
    // 先摘引用，让 exit 回调不再改状态（避免与这里的收尾打架）
    this.child = null;
    const pid = this.pid;

    try { child.kill('SIGTERM'); } catch { /* 已经没了 */ }
    let exited = await waitExit(child, graceMs);
    if (!exited) {
      this.log(`[box-service] ③ LLM 未在 ${graceMs}ms 内优雅退出 ⇒ SIGKILL`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      exited = await waitExit(child, 3000);
    }
    // 进程退了不等于端口已释放（内核回收 socket 有窗口）—— 必须回探，否则"卸载后立刻重启"会撞车
    const freed = await waitPortFree(this.port, 5000);
    this.pid = null;
    this.state = 'stopped';
    this.log(`[box-service] ③ LLM 已停止（pid=${pid}；优雅退出=${exited} 端口 ${this.port} 已释放=${freed}）`);
    return { stopped: true, exited, portFreed: freed };
  }

  /** 重新拉起（空闲卸载后的懒加载恢复，§9.3）。`restarts` 计数供 E6 取证。 */
  restart(opts) {
    return this._serial(() => {
      this.restarts += 1;
      return this._startInner(opts);
    });
  }

  /**
   * 换档位并重启 —— **一次原子操作**。`_doStop → 换配方 → _startInner` 全在同一个串行链里，
   * 中间插不进别人的操作。
   *
   * 为什么不让调用方自己拼 `stop(); useTier(t); start();`：那三步之间各有 await，
   * 任何一次外来 `start()`（懒加载恢复）或 `stop()`（空闲卸载）插进来，都会让
   * "配方的档位"和"实际跑着的权重"分家 —— 症状是**日志说降了档、进程还挂着旧的**。
   */
  switchTier(tier, { timeoutMs = 180_000 } = {}) {
    return this._serial(async () => {
      await this._doStop({ reason: `降档到 ${tier}`, graceMs: 5000 });
      this.useTier(tier);
      return this._startInner({ timeoutMs });
    });
  }

  /**
   * 换档位（《04》§8 降档用）：只**改配方**，什么时候重启由调用方决定。
   *
   * 为什么单独一个方法而不是让调用方直接改 `supervisor.launch`：`model`/`port` 都是从配方
   * 派生出来的，直接换 `launch` 会让三者不同步（症状是"日志说换了档、`/engine/status` 还报旧档"）。
   *
   * ⚠️ **两个前置条件，都没有运行时兜底**：
   *   ① 只在 `stopped` 状态调用 —— 运行中换配方不重启，等于换了个没人执行的配置（下面会抛）。
   *   ② 只在**串行链内**调用 —— 直接调用会绕开 `_serial`，与并发的 start/stop 打架。
   *      正常入口是 `switchTier()`（它已把三步包成原子操作）。
   */
  useTier(tier) {
    if (this.state !== 'stopped') {
      throw new Error(`换档位必须在 stopped 状态（当前 ${this.state}）—— 否则配方换了但进程没换`);
    }
    this.launch = resolveLlmLaunch({ tier });
    this.model = modelIdOf(this.launch);
    this.port = firstProbePort(this.launch);
    this.log(`[box-service] ③ 配方切到档位 ${tier}：${this.model}`);
    return this.launch;
  }
}

function firstProbePort(launch) {
  const p = (launch.probes || []).find((x) => Number.isInteger(x.port));
  return p ? p.port : null;
}

function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onExit = () => { cleanup(); resolve(true); };
    function cleanup() { clearTimeout(t); child.removeListener('exit', onExit); }
    child.once('exit', onExit);
  });
}

async function waitPortFree(port, timeoutMs) {
  if (!port) return true;
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (!(await probeTcp(port, 200))) return true;
    if (Date.now() > until) return false;
    await sleep(150);
  }
}
