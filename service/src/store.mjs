// 任务 / 批次 / 单图三层状态 + 串行 FIFO 队列 + 落盘 + eta
// 契约依据：§3 数据模型、§4 状态机、§5.2–5.7、§7 落盘、§8.2 安全
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  BATCH_LIMIT, ETA_SAMPLE_WINDOW, MAX_SEQ, FILE_NAME_RE, ORIGINAL_SCAN_RE,
  TRANSLATED_SCAN_RE, TASKS_STATE_DIR, IDEMPOTENCY_FILE, PENDING_DIR,
  HIDDEN_COMICS_FILE,
  assertInsideRoot, canonicalize, config, seq3,
} from './config.mjs';
import { ApiError } from './errors.mjs';
import { sniffImageType } from './image.mjs';
import { translateImage, EngineError } from './engine-client.mjs';
import { isOomError } from './tier-downgrade.mjs';
import { isSafeDirName } from './names.mjs';
import { writeSseEvent } from './sse.mjs';

const TASK_TERMINAL = new Set(['done', 'partial_failed', 'failed', 'canceled']);
const ITEM_TERMINAL = new Set(['success', 'failed', 'skipped']);
const MAX_ATTEMPTS = 2; // 首次 + 1 次重试（契约 §4.2「重试 N 次后失败」）
/** 重试前的退避间隔：引擎瞬时抖动（未就绪/超时）不应立刻判死单图 */
const RETRY_BACKOFF_MS = 400;
const MAX_EVENT_LOG = 20000;

/**
 * 允许降级为 `saved:false` 的**落盘/资源**错误（契约 §4.2「落盘失败不阻断主路径」）。
 *  · ENOSPC/EDQUOT/EROFS/EMFILE/ENFILE：磁盘满 / 配额 / 只读 / 句柄耗尽。
 *  · EEXIST：`wx` 独占写命中已存在文件——这是「文件已存在」这类**落盘失败**，
 *    正是 §7.4 幂等续做关掉开关（MIAO_SKIP_EXISTING=0）后要反向演练的旧行为。
 * 其余错误——特别是路径/安全类异常（§8.2 校验点 2 抛出的 ApiError PERMISSION_DENIED）——
 * 必须向上抛，绝不能静默变成 `success` 让任务走到 `done`。
 */
const DEGRADABLE_WRITE_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EEXIST']);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * taskId 由服务端生成（`tsk_` + 26 位 Crockford ULID），此处**再断言一次**。
 * 它现在会参与暂存区的目录名拼接（`state/pending/<taskId>/`），
 * 所以适用与 §8.2 校验点 2 同一套纪律：凡是拼进路径的东西都要能自证形状，
 * 不能因为「它是我们自己造的」就免检。
 */
const TASK_ID_RE = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

function ulid() {
  let ts = Date.now();
  const time = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[ts % 32];
    ts = Math.floor(ts / 32);
  }
  const rnd = crypto.randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rnd[i] % 32];
  return time.join('') + tail;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 任务时间戳专用的 ISO（**保留毫秒**）。
 *
 * 🔴 为什么不复用上面那个 `nowIso()`：它截掉毫秒（给人看的字段够用），而
 *   `createdAt` / `finishedAt` 会被 `idle-policy.lastActivityAt()` 拿去和
 *   `store.runtimeStartedAtMs`（`Date.now()`，**毫秒**）比大小。两侧精度差最多 1 秒 ⇒
 *   **与 Store 构造同一秒内创建的任务**，其 `Date.parse(createdAt)` 会落在下界**之前**，
 *   于是被判成"上一轮的历史"过滤掉 ⇒ 本次运行永远落到 `neverRan`
 *   ⇒ **这一轮的空闲卸载完全不生效**（③ LLM 常驻、不释放）。
 *   实测（`check:e5e6` 第 2~5 轮稳定 11/5，E6 整组红）：下界 `1791304803088`，
 *   任务 `createdAt` 截断成 `...803000` ⇒ `803000 < 803088` ⇒ `la=null`，
 *   该轮 82 次巡检里 81 次是 `never_ran`。
 *
 * 🔴 为什么修**精度**而不是给比较**加松弛**（把下界也截到秒）：加松弛会把"上一轮刚结束"
 *   的任务拉进同一秒、算成本次运行的**热态** —— 那正是 `runtimeStartedAtMs` 要挡的事
 *   （E6.7「重启后 ③ 刚被拉起就被卸掉」）。flaky 只会从 E6.1 搬到 E6.7，白改。
 */
const nowIsoMs = () => new Date().toISOString();

export class Store {
  /** @param {string} rootDir 落盘根目录（已校验） */
  constructor(rootDir) {
    this.root = validateAndPrepare(rootDir);
    /** @type {Map<string, any>} taskId → task */
    this.tasks = new Map();
    /** @type {any[]} 等待执行的 task（不含当前运行中的） */
    this.queue = [];
    /** taskId:seq → Buffer，上传的原图字节（内存暂存，落盘时消费） */
    this.blobs = new Map();
    /** 近 N 张已完成 item 的耗时（毫秒），用于 eta */
    this.durations = [];
    this.eventSeq = 0;
    this.currentTaskId = null;
    this._loopActive = false;
    /** idempotencyKey → { taskId, batchIndex, at } */
    this.idempotency = new Map();
    /**
     * 已从漫画库**隐藏**的漫画名（用户不勾选「删除本地文件」时只隐藏、保留磁盘文件）。
     * 扫描 `/library` 时跳过这些目录；`unhideComic` 可恢复。见 `HIDDEN_COMICS_FILE` 注释。
     * @type {Set<string>}
     */
    this.hiddenComics = new Set();
    this.startedAt = nowIso();
    /**
     * **本进程**的启动时刻（ms，毫秒精度）。
     *
     * 🔴 为什么必须单独存一个毫秒精度的字段，而不是复用上面的 `startedAt`：
     *   1. 参与比较的**两侧必须同精度**。`startedAt` 是给人看的 ISO（`nowIso()` **截掉了毫秒**），
     *      拿它当比大小的下界就引入最多 1 s 的偏斜；而**任务侧**的 `createdAt` / `finishedAt`
     *      一度也走 `nowIso()`（同样秒精度）—— 那边才是真正踩过的坑：与 Store 构造**同一秒内**
     *      创建的任务会被判成"上一轮的历史"⇒ 本轮永远 `neverRan` ⇒ 空闲卸载整轮失效。
     *      故本字段是毫秒精度，**任务侧改用 `nowIsoMs()`**，两侧对齐（见 `nowIsoMs()` 注释）。
     *   2. 更要紧的是它承载一条**语义边界**：`init()` 会把**上一轮**的终态任务从盘上
     *      恢复进 `this.tasks`（任务清单要显示历史），而 `idle-policy.mjs` 的
     *      `lastActivityAt()` 若把这些历史记录也算作"任务活动"，就会得出
     *      「距上次活动 18 小时」⇒ ③ LLM 刚被拉起就被第一次 tick 卸掉。
     *      那正是"用户重启 Box 后翻译永远起不来"的现场。本字段是这个过滤的**下界**。
     *   见 `idle-policy.mjs` 的 `lastActivityAt()` / `runtimeStartMs()`。
     */
    this.runtimeStartedAtMs = Date.now();
    /**
     * 翻译前的**懒加载恢复**钩子（《04》§9.3）：③ 被空闲卸载后再来任务时，先拉起它。
     * 由 server.mjs 在装配阶段注入（`store.ensureLlm = () => supervisor.start()`）。
     * 缺省 `null` ⇒ 纯 Store 场景（单测/自检）行为完全不变。
     */
    this.ensureLlm = null;
    /**
     * 档位降档控制器（《04》§8）。由 server.mjs 注入（进程级单例 ⇒ 天然是"服务级"作用域）。
     * 缺省 `null` ⇒ 纯 Store 场景（单测/自检）不做降档，行为完全不变。
     */
    this.tierDowngrade = null;
  }

  // ---------------------------------------------------------------- 启动恢复

  init() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(TASKS_STATE_DIR, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) this.idempotency.set(k, v);
    } catch { /* 首次启动无文件 */ }

    // 已隐藏的漫画名（非数组/坏文件一律当作"没有隐藏"—— 与 idempotency 同一处置：
    // 读盘失败绝不能连带把服务带不起来，那会让"少看见几部漫画"升级成"整个库打不开"。
    this.hiddenComics = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(HIDDEN_COMICS_FILE, 'utf8'));
      if (Array.isArray(raw?.comics)) for (const n of raw.comics) if (typeof n === 'string') this.hiddenComics.add(n);
    } catch { /* 首次启动无文件 */ }

    let restored = 0;
    let aborted = 0;
    let files = [];
    try {
      files = fs.readdirSync(TASKS_STATE_DIR).filter((f) => f.endsWith('.json'));
    } catch { /* ignore */ }

    for (const f of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(TASKS_STATE_DIR, f), 'utf8'));
        if (!task || !task.taskId) continue;
        task.events = [];
        task.clients = new Set();
        task.cancelRequested = false;
        if (!TASK_TERMINAL.has(task.status)) {
          // G-12（用户裁定 B ＋「只标为待译、由用户点继续翻译」，2026-10-03）：
          // **先把上传时暂存的原图搬回漫画目录**，再按老规矩把这条任务标失败收尾。
          // 搬回来之后这几页就是普通的「有原图、缺译文」——库里显示「待译」、
          // `/resume` 列得出来、用户点「继续翻译」即可。**不做任何后台自动续做**（用户裁定）。
          // 修之前这里只能写「重启后内存中的原图字节已丢失，无法续做」，那些页永久消失。
          const moved = this._materializeStaged(task);
          for (const batch of task.batches || []) {
            for (const item of batch.items || []) {
              if (!ITEM_TERMINAL.has(item.status)) {
                item.status = 'failed';
                item.reason = 'service_restarted';
              }
            }
          }
          task.status = 'failed';
          aborted++;
          this._persistNow(task);
          this._sweepStaged(task.taskId); // 搬空的目录顺手收掉；没搬动的会被保留并告警
          if (moved > 0) {
            console.log(`[G-12] 任务 ${task.taskId}：已把 ${moved} 张暂存原图搬回漫画目录，可在「继续翻译」里补译文`);
          }
        }
        this.tasks.set(task.taskId, task);
        restored++;
      } catch { /* 单个任务文件损坏则跳过 */ }
    }
    const swept = this._sweepOrphanStaging();
    return { restored, aborted, swept };
  }

  /**
   * 把**暂存区**里属于该任务的字节搬进漫画目录（G-12 的重启恢复）。
   *
   * 只搬「任务被打断时**还没处理完**」的页（item 状态非终态）。已终态的页一律不看：
   *  · `success` 的原图早已落盘；
   *  · `failed` 的按 G-11 也已经落过原图（若当时落盘被降级，暂存那份会被刻意留下）；
   *  · `skipped` 属**取消**语义 —— 不问自取就正好违反了《02》§4.3「未开始的 item 原图不落盘」。
   * 这也顺手挡掉了「已取消、但清单上的状态没来得及落」那个窄窗口：那种任务里
   * 未处理的页都已是 `skipped`，一张也不会被搬。
   */
  _materializeStaged(task) {
    let moved = 0;
    for (const batch of task.batches || []) {
      for (const item of batch.items || []) {
        if (ITEM_TERMINAL.has(item.status)) continue;
        const bytes = this._readStagedBytes(task.taskId, item.seq);
        if (!bytes) continue; // 该页从没上传过字节（续做路径 fromDisk），或已落盘撤过暂存
        try {
          this._writeOriginal(task, item, bytes); // 内部顺带撤该页的暂存
          moved++;
        } catch (err) {
          // 搬不动就把它留在暂存区（`_sweepStaged` 会告警），
          // 但**绝不能因此让服务起不来**：单页的落盘问题不该升级成启动失败。
          const why = (err && err.code) || (err && err.message) || String(err);
          console.warn(`[G-12] seq ${item.seq} 的暂存原图搬回失败（${why}）：保留在暂存区`);
        }
      }
    }
    return moved;
  }

  /**
   * 启动时的暂存区清扫（G-12）。只删**空**目录。
   *
   * 空目录只有一个来源：上一次收尾（`_sweepStaged`）或建单回滚跑了一半就被打断 ——
   * 里面已经没有任何字节，删掉不丢东西，留着却会逐年累积。
   * **非空的一律保留并告警**：那里面是某页原图**仅存的一份**（或一份没人认领的孤本），
   * 删掉就是把「可能还有救」变成「彻底没有」。与 `_sweepStaged` 是同一条纪律：
   * **宁可留一个目录，让它出现在日志里。**
   *
   * 仍在跑的任务（非终态）绝不碰 —— 那是它们唯一的字节来源。
   */
  _sweepOrphanStaging() {
    let dirs = [];
    try { dirs = fs.readdirSync(PENDING_DIR); } catch { return 0; } // 首次启动无该目录
    let removed = 0;
    for (const d of dirs) {
      const p = path.join(PENDING_DIR, d);
      try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
      const task = this.tasks.get(d);
      if (task && !TASK_TERMINAL.has(task.status)) continue;
      let entries = [];
      try { entries = fs.readdirSync(p); } catch { continue; }
      if (entries.length === 0) {
        try { fs.rmdirSync(p); removed++; } catch { /* ignore */ }
      } else {
        console.warn(`[G-12] 暂存目录 ${d} 里还有 ${entries.length} 份字节且没有对应的在跑任务：`
          + '保留不删（可能是某页原图仅存的一份），请人工确认后清理');
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------- 查询工具

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  mustTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new ApiError('TASK_NOT_FOUND', `任务不存在：${taskId}`, { taskId });
    return task;
  }

  currentTask() {
    return this.currentTaskId ? this.tasks.get(this.currentTaskId) : null;
  }

  allItems(task) {
    return task.batches.flatMap((b) => b.items);
  }

  pendingCount(task) {
    return this.allItems(task).filter((i) => i.status === 'pending').length;
  }

  taskDir(task) {
    return path.join(this.root, task.dirName);
  }

  // ---------------------------------------------------------------- 创建/追加

  /**
   * POST /tasks
   * @param {object} input { payload, images:[{filename,data}], imageOrder }
   */
  createTask({ payload, images, imageOrder, source }) {
    const key = payload && payload.idempotencyKey;
    const replay = this._idempotencyHit(key);
    if (replay) {
      const task = this.mustTask(replay.taskId);
      return { task, replay: true };
    }

    const comicName = payload.comicName;
    const dirName = payload.__normalizedName; // 由 server 层规范化后注入
    const seqFrom = this._nextSeqFor(dirName);
    const count = images.length;
    this._assertSeqRange(seqFrom, count, dirName);

    const items = this._buildItems(seqFrom, images, imageOrder);
    const task = this._newTask({
      comicName,
      dirName,
      source,
      batches: [{
        batchIndex: 1,
        count,
        seqFrom,
        seqTo: seqFrom + count - 1,
        status: 'queued',
        idempotencyKey: key || null,
        items,
      }],
      lang: payload && payload.lang,
      translator: payload && payload.translator,
      clientTaskRef: payload && payload.clientTaskRef,
      idempotencyKey: key,
    });
    this._adoptBytes(task.taskId, items);

    this.tasks.set(task.taskId, task);
    if (key) this._rememberIdempotency(key, task.taskId, 1);
    this._persistNow(task);
    this._enqueueOrStart(task);
    return { task, replay: false };
  }

  /** 组装 Task 的三层模型骨架（建单与本地续做共用，避免两处字面量走偏） */
  _newTask({ comicName, dirName, source, batches, lang, translator, clientTaskRef, idempotencyKey }) {
    return {
      taskId: `tsk_${ulid()}`,
      comicName,
      normalizedComicName: dirName,
      dirName,
      outputDir: path.join(this.root, dirName),
      status: 'queued',
      queuePosition: 0,
      lang: lang || { from: 'ja', to: 'zh' },
      translator: translator || 'sakura',
      clientTaskRef: clientTaskRef || null,
      // 来源归因：由 server 层按契约 §2 的可选头 `X-Box-Client` 判定（见 spec-notes G-04）
      source: source || 'unknown',
      idempotencyKey: idempotencyKey || null,
      createdAt: nowIsoMs(),
      finishedAt: null,
      batches,
      events: [],
      clients: new Set(),
      cancelRequested: false,
    };
  }

  /** POST /tasks/{taskId}/batches */
  appendBatch(taskId, { payload, images, imageOrder }) {
    const task = this.mustTask(taskId);
    if (TASK_TERMINAL.has(task.status)) {
      throw new ApiError('TASK_NOT_APPENDABLE',
        `任务已处于终态 ${task.status}，无法追加批次`, { taskId, status: task.status });
    }
    const key = payload && payload.idempotencyKey;
    const replay = this._idempotencyHit(key);
    if (replay && replay.taskId === taskId) {
      return { task, replay: true };
    }

    const lastBatch = task.batches[task.batches.length - 1];
    // B(n+1).seqFrom 恒等于 B(n).seqTo + 1
    const seqFrom = lastBatch.seqTo + 1;
    const count = images.length;
    this._assertSeqRange(seqFrom, count, task.dirName);

    const items = this._buildItems(seqFrom, images, imageOrder);
    const batchIndex = task.batches.length + 1;
    task.batches.push({
      batchIndex,
      count,
      seqFrom,
      seqTo: seqFrom + count - 1,
      status: 'queued',
      idempotencyKey: key || null,
      items,
    });
    this._adoptBytes(task.taskId, items);

    if (key) this._rememberIdempotency(key, task.taskId, batchIndex);
    this._persistNow(task);
    this._emitBatchStatus(task, task.batches[batchIndex - 1]);
    return { task, replay: false };
  }

  _idempotencyHit(key) {
    if (!key) return null;
    const rec = this.idempotency.get(key);
    if (!rec) return null;
    if (Date.now() - rec.at > 24 * 3600 * 1000) {
      this.idempotency.delete(key);
      return null;
    }
    return rec;
  }

  _rememberIdempotency(key, taskId, batchIndex) {
    this.idempotency.set(key, { taskId, batchIndex, at: Date.now() });
    try {
      const obj = {};
      for (const [k, v] of this.idempotency) obj[k] = v;
      fs.writeFileSync(IDEMPOTENCY_FILE, JSON.stringify(obj, null, 2));
    } catch { /* ignore */ }
  }

  _buildItems(seqFrom, images, imageOrder) {
    const ordered = orderImages(images, imageOrder);
    const items = [];
    for (let i = 0; i < ordered.length; i++) {
      const img = ordered[i];
      const bytes = img.data;
      const ext = sniffImageType(bytes);
      if (!ext || bytes.length === 0) {
        throw new ApiError('INVALID_IMAGE', '图片 0 字节或无法解码（嗅探失败）', {
          index: i, filename: img.filename || null, bytes: bytes.length,
        });
      }
      items.push({
        seq: seqFrom + i,
        ext,
        mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
        byteSize: bytes.length,
        status: 'pending',
        saved: false,
        outputFile: null,
        originalFile: null,
        sha256: null,
        durationMs: null,
        retryCount: 0,
        reason: null,
        __bytes: bytes,
      });
    }
    return items;
  }

  _assertSeqRange(seqFrom, count, dirName) {
    if (seqFrom + count - 1 > MAX_SEQ) {
      throw new ApiError('SEQUENCE_OVERFLOW',
        `该漫画名页数已达上限（${MAX_SEQ}），请另存为新目录`,
        { limit: MAX_SEQ, seqFrom, seqTo: seqFrom + count - 1, normalizedComicName: dirName });
    }
  }

  // ---------------------------------------------------------------- 本地续做

  /**
   * 扫描目录，找出「有原图、缺译文」的页。
   *
   * 契约 §5.8 的 `GET /library` 只给张数汇总，没有「哪几页还没翻」这一信息；
   * 而 X-D1 的「继续翻译」按钮要的正是这个集合（spec-notes.md G-07）。
   * 这里**不维护第二份索引**——直接读目录，落盘依旧是唯一真源。
   */
  resumePlan(dirName) {
    const dir = path.join(this.root, dirName);
    const originals = new Map(); // seq → { ext, byteSize, name }
    const translated = new Set();
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      throw new ApiError('TASK_NOT_FOUND', '漫画目录不存在', { comicName: dirName, outputDir: dir });
    }
    for (const f of entries) {
      let m = ORIGINAL_SCAN_RE.exec(f);
      if (m) {
        let byteSize = 0;
        try { byteSize = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
        originals.set(Number(m[1]), { ext: f.split('.').pop().toLowerCase(), byteSize, name: f });
        continue;
      }
      m = TRANSLATED_SCAN_RE.exec(f);
      if (m) translated.add(Number(m[1]));
    }
    const pendings = [...originals.entries()]
      .filter(([seq]) => !translated.has(seq))
      .map(([seq, meta]) => ({ seq, ext: meta.ext, byteSize: meta.byteSize, originalFile: meta.name }))
      .sort((a, b) => a.seq - b.seq);
    return {
      comicName: dirName,
      dirName,
      outputDir: dir,
      imageCount: originals.size,
      translatedCount: translated.size,
      pendingCount: pendings.length,
      pendings,
      /**
       * 已有译文的页号（升序）。
       *
       * 为什么要在这里就把集合给出：`GET /library` 的汇总里只有**张数**，
       * 回答不了"哪几页译过了"。`pendings` 只能反推（在有原图的前提下），
       * 一遇到"有译文但原图没了"的页就漏 —— 而返工计划（`retranslatePlan`）
       * 需要精确判断每一页**是否将被覆盖**，靠张数推断会把结论整体错位。
       */
      translatedSeqs: [...translated].sort((a, b) => a - b),
    };
  }

  /**
   * 返工计划：目录里**所有有原图的页**（不论是否已有译文）。
   *
   * 与 `resumePlan` 的差别只有一条，却决定了整个功能的语义：
   * `resumePlan` 取的是「有原图 **且缺译文**」，返工取的是「有原图」——
   * 译错了的那几页**已经有译文**了，正是 `resumePlan` 明确排除掉的那些。
   * 若复用它，返工会对「已译完」的漫画报"没有待续做的页"，功能形同虚设。
   *
   * ⚠️ 页数上限：单次提交仍受 `BATCH_LIMIT` 约束，所以整部返工需要分批
   * （由 `createRetranslateTask` 报 409，前端据此提示分批）。
   */
  retranslatePlan(dirName) {
    const plan = this.resumePlan(dirName); // 复用同一遍扫描，不维护第二份索引
    const dir = path.join(this.root, dirName);
    const candidates = [];
    for (const f of this._listDir(dir)) {
      const m = ORIGINAL_SCAN_RE.exec(f);
      if (!m) continue;
      const seq = Number(m[1]);
      let byteSize = 0;
      try { byteSize = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
      candidates.push({
        seq,
        ext: f.split('.').pop().toLowerCase(),
        byteSize,
        originalFile: f,
        hadTranslation: plan.translatedSeqs.includes(seq),
      });
    }
    candidates.sort((a, b) => a.seq - b.seq);
    return {
      comicName: dirName,
      dirName,
      outputDir: dir,
      imageCount: plan.imageCount,
      translatedCount: plan.translatedCount,
      retranslateCount: candidates.length,
      /** 已被译文覆盖、这次会被真正重写的页（前端用来提示"会覆盖 N 张"） */
      overwriteCount: candidates.filter((c) => c.hadTranslation).length,
      candidates,
    };
  }

  /** 列目录，目录不存在返回空数组（`resumePlan` 抛 404，返工计划要能"空目录也不炸"） */
  _listDir(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  /**
   * 单张漫画返工重译：为「有原图」的页**重新**跑一遍引擎，**覆盖已有译文**。
   *
   * ## 与 `createResumeTask` 的分工（别混）
   *  · resume    = 补**缺**的页，遇到已有译文就跳过（幂等续做，可反复点）。
   *  · retranslate = 重跑**已译**的页（译错了要返工），译文会被覆盖。
   *
   * ## 覆盖是怎么做到的（两处配套，缺一不可）
   * ① `item.overwrite = true` ⇒ `_processItem` **跳过** `skipExisting` 的幂等短路
   *    （否则每一页都会以 `already_exists` 被跳过，任务秒完但什么都没重译）；
   * ② `_writeItem` 对 `overwrite` 的页改用 `flag:'w'` 而非 `'wx'` 覆盖写译文。
   *
   * ## 为什么不覆盖原图
   * 原图是**用户的数据**，返工只重译 —— `_writeOriginal` 的「永不覆盖」原样保留，
   * 且续做路径 `fromDisk:true` 读的就是磁盘上那份原图，一个字节都不会动。
   *
   * 单次上限沿用 `BATCH_LIMIT`（20）：整部漫画上百页时必须分批，
   * 一次建单塞 200 页会让引擎队列被单个任务占死。
   */
  createRetranslateTask(dirName, { seqs, source } = {}) {
    const plan = this.retranslatePlan(dirName);
    const want = seqs && seqs.length ? new Set(seqs.map(Number)) : null;
    const picked = want ? plan.candidates.filter((c) => want.has(c.seq)) : plan.candidates;

    if (picked.length === 0) {
      throw new ApiError('TASK_NOT_FOUND',
        plan.imageCount === 0 ? '该漫画目录里没有原图，无从返工' : '指定的页在本机没有原图',
        { comicName: dirName, imageCount: plan.imageCount });
    }
    if (picked.length > BATCH_LIMIT) {
      throw new ApiError('BATCH_LIMIT_EXCEEDED',
        `返工 ${picked.length} 张，超过单次上限 ${BATCH_LIMIT} 张；请分批返工`,
        { limit: BATCH_LIMIT, submitted: picked.length, seqs: picked.map((c) => c.seq) });
    }

    const items = picked.map((c) => ({
      seq: c.seq,
      ext: c.ext,
      mime: c.ext === 'jpg' ? 'image/jpeg' : `image/${c.ext}`,
      byteSize: c.byteSize,
      /** 原图从磁盘读，内存里没有上传字节 */
      fromDisk: true,
      /** 🔴 返工标记：让 worker 跳过幂等短路 + 允许覆盖译文（见方法头的两处配套） */
      overwrite: true,
      status: 'pending',
      saved: false,
      outputFile: null,
      originalFile: c.originalFile,
      sha256: null,
      durationMs: null,
      retryCount: 0,
      reason: null,
    }));

    const seqFrom = picked[0].seq;
    const seqTo = picked[picked.length - 1].seq;
    const task = this._newTask({
      comicName: dirName,
      dirName,
      source,
      batches: [{
        batchIndex: 1,
        count: items.length,
        seqFrom,
        seqTo,
        status: 'queued',
        idempotencyKey: null,
        items,
      }],
      idempotencyKey: null,
    });

    this.tasks.set(task.taskId, task);
    this._persistNow(task);
    this._enqueueOrStart(task);
    return { task, replay: false, plan };
  }

  /**
   * 本地续做：为目录中「有原图、缺译文」的页补译文。
   *
   * 与 `POST /tasks` 的两处关键差异，都是为了「不重复、不覆盖」：
   *  · **不新增编号**：item.seq 沿用磁盘上原图的序号 —— 续做是在补同一本漫画缺的那几页，
   *    不是往里追加新页。若走 `_nextSeqFor`，会产生与既有原图重复的第二份原图。
   *  · **不重写原图**：只有译文落盘（原图已存在，契约 §7.2「永不覆盖」）。
   *
   * 单次上限沿用契约 §5.2 的 20 —— 续做同样是一批 ≤20 张的提交，只是字节来源不同。
   */
  createResumeTask(dirName, { seqs, source } = {}) {
    const plan = this.resumePlan(dirName);
    const want = seqs && seqs.length ? new Set(seqs.map(Number)) : null;
    const pendings = want ? plan.pendings.filter((p) => want.has(p.seq)) : plan.pendings;

    if (pendings.length === 0) {
      throw new ApiError('TASK_NOT_FOUND',
        plan.imageCount === plan.translatedCount
          ? '该漫画已全部翻译完成，没有待续做的页'
          : '指定的页不存在或已有译文',
        { comicName: dirName, imageCount: plan.imageCount, translatedCount: plan.translatedCount });
    }
    if (pendings.length > BATCH_LIMIT) {
      throw new ApiError('BATCH_LIMIT_EXCEEDED',
        `待续做 ${pendings.length} 张，超过单次上限 ${BATCH_LIMIT} 张；请分批续做`,
        { limit: BATCH_LIMIT, submitted: pendings.length, seqs: pendings.map((p) => p.seq) });
    }

    const items = pendings.map((p) => ({
      seq: p.seq,
      ext: p.ext,
      mime: p.ext === 'jpg' ? 'image/jpeg' : `image/${p.ext}`,
      byteSize: p.byteSize,
      /** 提示 worker：原图从磁盘读，内存里没有上传字节 */
      fromDisk: true,
      status: 'pending',
      saved: false,
      outputFile: null,
      originalFile: p.originalFile,
      sha256: null,
      durationMs: null,
      retryCount: 0,
      reason: null,
    }));

    const seqFrom = pendings[0].seq;
    const seqTo = pendings[pendings.length - 1].seq;
    const task = this._newTask({
      comicName: dirName,
      dirName,
      source,
      batches: [{
        batchIndex: 1,
        count: items.length,
        seqFrom,
        seqTo,
        status: 'queued',
        idempotencyKey: null,
        items,
      }],
      idempotencyKey: null,
    });

    this.tasks.set(task.taskId, task);
    this._persistNow(task);
    this._enqueueOrStart(task);
    return { task, replay: false };
  }

  /**
   * 重跑**同一个任务**：把失败页复位为待译，用**原来的 taskId** 回到队列。
   *
   * 为什么不复用 `createResumeTask`（那会产生新 taskId）：队列行上「重试」的语义是
   * 「**这一行**重新开始跑」。新建任务的话，原失败行留在历史里、旁边又冒出一条新行 ——
   * 用户看到的是「点了重试，历史里多出一个任务」，而不是「这一行变回翻译中」。
   *（`createResumeTask` 继续服务漫画库 X-D1 的「继续翻译」，那条路按目录找缺页，语义不同。）
   *
   * 字节来源：失败页的原图已按 G-11 落盘（`_keepOriginalOnFailure`），而上传那份暂存字节
   * 在任务收尾时已被清扫（`_sweepStaged` / `_forgetBlobs`）⇒ 复位时把 `fromDisk` 置真，
   * 走「从磁盘读原图」那条路。若某页连原图都没能留下（G-11 的降级路径），它重跑会以
   * `original_missing` 再次失败 —— 那是**如实的失败**，不该被这里掩盖成成功。
   *
   * 只复位 `failed`：`success` / `skipped` 的页是已经拿到结果的（skipped 多为
   * `already_exists`），重跑它们既浪费又会与「不覆盖」冲突。
   */
  retryTask(taskId) {
    const task = this.mustTask(taskId);
    if (!TASK_TERMINAL.has(task.status)) {
      throw new ApiError('TASK_NOT_RETRYABLE',
        `任务还在 ${task.status}，无需重试`, { taskId, status: task.status });
    }

    let reused = 0;
    for (const batch of task.batches) {
      for (const item of batch.items) {
        if (item.status !== 'failed') continue;
        item.status = 'pending';
        item.fromDisk = true;
        item.saved = false;
        item.outputFile = null;
        item.sha256 = null;
        item.durationMs = null;
        item.retryCount = 0;
        item.reason = null;
        item.errorMessage = null;
        reused++;
      }
    }
    if (reused === 0) {
      throw new ApiError('TASK_NOT_RETRYABLE',
        '该任务没有可重试的页（只有失败的页需要重跑）', { taskId, status: task.status });
    }

    // 回到「未收尾」姿态：清掉上一次的终态痕迹，否则队列页会同时显示新的活动状态与旧的完成时间。
    task.finishedAt = null;
    task.cancelRequested = false;
    task.lastError = null;
    this._syncBatchStatuses(task);
    // 与新建任务**同一套调度**：空闲 ⇒ 立刻 running（就是用户要的「直接变成翻译中」），
    // 否则排进队尾（此时显示「等待中」才是诚实的 —— 引擎同一时刻只跑一个任务）。
    this._enqueueOrStart(task);
    return { task, reused };
  }

  /**
   * 批量删除任务**记录**（队列页多选删除）。
   *
   * 逐条回报、不整批抛错 —— 一批多选里混着「翻译中的」（删不掉）与「已完成的」（删得掉）
   * 是常态，整批失败会让用户无从下手；只有逐条说清"哪几条没删成、为什么"，按钮才有意义。
   *
   * 只删「记录」：内存里的 task + 落盘的 `state/tasks/<taskId>.json`。
   * **绝不碰漫画目录** —— 队列删的是"任务"，用户在漫画库删的才是"漫画"（两者是两回事，
   * 一部漫画可能对应多条历史任务）。翻译中 / 排队中不可删：它们还在跑、进程随时回写状态，
   * 删内存副本只会让"列表说没了、服务还在写"两者失配。
   */
  deleteTasks(taskIds) {
    const deleted = [];
    const skipped = [];
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (!task) {
        skipped.push({ taskId, reason: 'not_found' });
        continue;
      }
      if (!TASK_TERMINAL.has(task.status)) {
        skipped.push({ taskId, reason: 'not_deletable', status: task.status });
        continue;
      }
      // 收尾资源：终态任务的暂存区早已清空，这里兜底再扫一次；内存字节引用同理。
      this._sweepStaged(taskId);
      this._forgetBlobs(taskId);
      this.tasks.delete(taskId);
      try {
        fs.rmSync(path.join(TASKS_STATE_DIR, `${taskId}.json`), { force: true });
      } catch { /* 盘上已无该文件，无需处理 */ }
      deleted.push(taskId);
    }
    return { deleted, skipped };
  }

  // ---------------------------------------------------------------- 漫画库「隐藏」

  /** 已隐藏的漫画名（按中文排序），供 `/library` 过滤与「管理已隐藏」展示。 */
  hiddenComicsView() {
    return [...this.hiddenComics].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  /** 隐藏一部漫画（保留磁盘文件），返回最新隐藏清单。 */
  hideComic(comicName) {
    if (!this.hiddenComics.has(comicName)) {
      this.hiddenComics.add(comicName);
      this._persistHidden();
    }
    return this.hiddenComicsView();
  }

  /** 取消隐藏（恢复显示），返回最新隐藏清单。 */
  unhideComic(comicName) {
    if (this.hiddenComics.delete(comicName)) this._persistHidden();
    return this.hiddenComicsView();
  }

  /**
   * 目录被**真删掉**时顺手清掉隐藏记录。
   * 不清的后果：同名漫画日后重建（重新翻译同名作品）会被无声跳过，用户只看到"库是空的"。
   */
  forgetHidden(comicName) {
    if (this.hiddenComics.delete(comicName)) this._persistHidden();
  }

  _persistHidden() {
    try {
      fs.mkdirSync(path.dirname(HIDDEN_COMICS_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(HIDDEN_COMICS_FILE, JSON.stringify({ comics: this.hiddenComicsView() }, null, 2));
    } catch (e) {
      // 写不进盘不该让这次隐藏失败（内存里已生效），但必须说一声：否则用户重启后
      // 会看到"我删掉的漫画又回来了"，却查不出为什么。
      console.warn(`[box-service] ⚠ 隐藏清单写入失败（内存已生效，重启后会丢失）：${e.message}`);
    }
  }

  /** 读磁盘上已有的原图字节（续做路径专用）；找不到返回 null，由调用方按失败收尾 */
  _readOriginalFromDisk(task, seq) {
    const dir = this.taskDir(task);
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = ORIGINAL_SCAN_RE.exec(f);
        if (m && Number(m[1]) === seq) {
          const p = path.join(dir, f);
          assertInsideRoot(this.root, p); // 与上传路径同一套校验，不多不少
          return fs.readFileSync(p);
        }
      }
    } catch { /* 落到调用方的 null 分支 */ }
    return null;
  }

  /** nextSeq = max(目录内 ^(\d{3})\.(png|jpg|jpeg|webp)$ 的 N) + 1 */
  _nextSeqFor(dirName) {
    let diskMax = 0;
    const dir = path.join(this.root, dirName);
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = ORIGINAL_SCAN_RE.exec(f);
        if (m) diskMax = Math.max(diskMax, Number(m[1]));
      }
    } catch { /* 目录不存在 → 1 */ }

    // 已创建但尚未落盘的任务同样占用序号（避免同目录多个排队任务重号）
    let reserved = 0;
    for (const t of this.tasks.values()) {
      if (t.dirName !== dirName) continue;
      if (TASK_TERMINAL.has(t.status)) continue;
      const last = t.batches.length ? t.batches[t.batches.length - 1].seqTo : 0;
      reserved = Math.max(reserved, last);
    }
    return Math.max(diskMax, reserved) + 1;
  }

  // ---------------------------------------------------------------- 队列调度

  _enqueueOrStart(task) {
    const idle = !this.currentTaskId && this.queue.length === 0;
    if (idle) {
      // 创建即判定：立刻 running，queuePosition 0
      task.status = 'running';
      task.queuePosition = 0;
      this.currentTaskId = task.taskId;
      this._emitTaskStatus(task);
      this._persistNow(task);
      this._runTask(task)
        .catch(() => { /* 内部已兜底 */ })
        .finally(() => {
          // 仅当仍在跑自己时才清空，避免把已被 _runLoop 接手的后继任务误清
          if (this.currentTaskId === task.taskId) this.currentTaskId = null;
          this._runLoop();
        });
    } else {
      task.status = 'queued';
      this.queue.push(task);
      task.queuePosition = this.queue.length;
      this._emitTaskStatus(task);
      this._persistNow(task);
      this._runLoop();
    }
  }

  async _runLoop() {
    if (this._loopActive) return;
    this._loopActive = true;
    try {
      // 串行铁律：同一时刻只跑一个 Task（Task 是调度单位，Batch 不参与调度）
      while (this.currentTaskId === null && this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task || task.status !== 'queued') continue;
        task.status = 'running';
        task.queuePosition = 0;
        this.currentTaskId = task.taskId;
        this._reindexQueue();
        this._emitTaskStatus(task);
        await this._runTask(task);
        this.currentTaskId = null;
      }
    } finally {
      this._loopActive = false;
    }
  }

  _reindexQueue() {
    this.queue.forEach((t, i) => { t.queuePosition = i + 1; });
  }

  async _runTask(task) {
    try {
      this._syncBatchStatuses(task);
      for (;;) {
        if (task.cancelRequested) break;
        const found = this._nextPendingItem(task);
        if (!found) break;
        await this._processItem(task, found.batch, found.item);
      }
      if (task.cancelRequested) {
        this._skipAllPending(task, 'canceled');
        this._finalize(task, 'canceled');
      } else {
        this._finalize(task, endStatusOf(this.allItems(task)));
      }
    } catch (err) {
      task.lastError = String((err && err.message) || err);
      // 正在处理中的 item 不能留在 translating（否则任务终态里挂着一个假「进行中」）
      for (const batch of task.batches) {
        for (const item of batch.items) {
          if (item.status === 'translating') {
            item.status = 'failed';
            item.saved = false;
            item.reason = 'internal_error';
            // G-11 的口径是「**已处理**的页一律保原图」，异常路径也是失败的一种，
            // 不能因为异常是从别处抛上来的就漏掉这一页 —— 那正是它最需要被续做的时候。
            // 进过 _processItem 的页，原图字节此刻还在内存 blobs 里，取现成的一份即可。
            const lastBytes = this.blobs.get(`${task.taskId}:${item.seq}`)
              || this._readStagedBytes(task.taskId, item.seq);
            if (lastBytes) {
              // 已经在错误路径上了，这里**绝不能再抛**（否则会把一条错误变成两条）
              try { this._keepOriginalOnFailure(task, item, lastBytes); } catch { /* 见 _keepOriginalOnFailure */ }
            }
            this._emitItemStatus(task, batch, item);
          }
        }
      }
      this._skipAllPending(task, 'internal_error');
      this._finalize(task, 'failed');
    }
  }

  _nextPendingItem(task) {
    for (const batch of task.batches) {
      for (const item of batch.items) {
        if (item.status === 'pending') return { batch, item };
      }
    }
    return null;
  }

  // ------------------------------------------------- 上传字节暂存区（G-12）

  /**
   * 上传字节的**暂存目录**：`state/pending/<taskId>/`，每页一份 `<seq>.bin`。
   *
   * 为什么需要它（G-12，用户裁定 **B**，2026-10-03）：
   * 字节原先只活在内存（`this.blobs`），进程一崩就全丢 —— 不只是「正在翻译那一张」，
   * 而是**所有尚未落盘的页**。而它又**不能**提前写进漫画目录：
   * 《02》§4.3 + 契约 §4.1 明令「未开始的 item 原图不落盘」（取消不得留下残缺目录）。
   * 于是唯一能同时满足两条明文条款的位置，是**漫画目录之外的某处** —— 就是这里。
   * 与契约 §7.5 把任务清单放 state 区是同一套理由（「不放漫画目录内」）。
   *
   * **只存字节、不存文件名**：漫画目录里的名字始终由服务端按 `item.ext` 现算再校验
   * （§8.2 校验点 2「绝不取自用户输入」），暂存文件名因此不含任何外部信息。
   */
  _stageDir(taskId) {
    if (!TASK_ID_RE.test(String(taskId))) {
      throw new ApiError('PERMISSION_DENIED', 'taskId 形状不合法，拒绝用于暂存路径', { taskId });
    }
    return path.join(PENDING_DIR, taskId);
  }

  _stagePath(taskId, seq) {
    return path.join(this._stageDir(taskId), `${seq3(seq)}.bin`);
  }

  /**
   * 建单 / 追加批次的**唯一**字节落点：同一份字节**同时**放进内存与暂存区。
   *
   * 两处都由这一个方法写，是为了不出现「内存有、暂存没有」这种**只在崩溃时才会暴露**
   * 的半成品状态 —— 那种状态恰恰是这次要修的缺陷本身。任一步失败即回滚**本次新落的那几份**
   * （刻意**不用** `_dropStaged` 整目录删：追加批次时那会连带抹掉**前几批尚未落盘**的暂存字节）。
   * （`createResumeTask` **不走这里**：续做路径的原图本来就在磁盘上，`fromDisk:true`。）
   */
  _adoptBytes(taskId, items) {
    const staged = [];
    try {
      for (const item of items) {
        this._stageBytes(taskId, item.seq, item.__bytes);
        staged.push(item.seq);
      }
    } catch (err) {
      for (const seq of staged) this._unstageBytes(taskId, seq);
      throw err;
    }
    for (const item of items) this.blobs.set(`${taskId}:${item.seq}`, item.__bytes);
    for (const item of items) delete item.__bytes;
  }

  _stageBytes(taskId, seq, bytes) {
    fs.mkdirSync(this._stageDir(taskId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this._stagePath(taskId, seq), bytes, { flag: 'wx', mode: 0o600 });
  }

  _readStagedBytes(taskId, seq) {
    try { return fs.readFileSync(this._stagePath(taskId, seq)); } catch { return null; }
  }

  /**
   * 撤掉某一页的暂存 —— 调用时机**只有一个**：「该页原图已确认落在漫画目录」。
   * 放在 `_writeOriginal` 内部正是为了让这个时机只存在一处定义（见那里的注释）。
   */
  _unstageBytes(taskId, seq) {
    try { fs.rmSync(this._stagePath(taskId, seq), { force: true }); } catch { /* ignore */ }
  }

  /** 丢弃整条任务的暂存（**取消**专用：漫画目录不得因未处理的页留下任何痕迹，《02》§4.3） */
  _dropStaged(taskId) {
    let dir;
    try { dir = this._stageDir(taskId); } catch { return; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /**
   * **正常终态**的收尾：此刻暂存目录**应当已空** —— 每一页都按各自规则落了盘
   * （成功写原图+译文，失败按 G-11 保原图）。空则删目录，非空则**留着并告警**：
   * 非空意味着某页的落盘被降级过（`saved:false`），那一份就是它还剩下的唯一字节，
   * 删掉等于把「还有救」变成「彻底没有」。宁可留一个目录，让它出现在日志里。
   */
  _sweepStaged(taskId) {
    let left = [];
    try { left = fs.readdirSync(this._stageDir(taskId)); } catch { return; }
    if (left.length === 0) { this._dropStaged(taskId); return; }
    console.warn(`[G-12] 任务 ${taskId} 收尾时暂存区仍剩 ${left.length} 份字节（${left.join(', ')}）：`
      + '对应页的原图不在漫画目录里，保留以免彻底丢失');
  }

  /**
   * 与暂存区**成对**清理的内存侧。同一份字节有了两个存放处，就不能只清一个 ——
   * 漏掉哪一边，那一边的残留都会在下次崩溃 / 收尾时冒出来（而这种漂移只有崩溃才照得出）。
   */
  _forgetBlobs(taskId) {
    const prefix = `${taskId}:`;
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) this.blobs.delete(key);
    }
  }

  // ---------------------------------------------------------------- 单图处理

  async _processItem(task, batch, item) {
    const dir = this.taskDir(task);
    const blobKey = `${task.taskId}:${item.seq}`;

    // 幂等续做：NNN_translated.* 已存在 → skipped(already_exists)，序号不变
    // ⚠️ `item.overwrite`（返工重译）必须**绕过**这条短路，否则每一页都会以
    // `already_exists` 被跳过 —— 任务秒完、进度条走满、译文却一个字没换。
    if (config.skipExisting && !item.overwrite && this._translatedExists(dir, item.seq)) {
      item.status = 'skipped';
      item.reason = 'already_exists';
      item.saved = true;
      item.outputFile = this._findTranslatedName(dir, item.seq);
      this.blobs.delete(blobKey);
      // G-12：这一页已有译文，暂存那份通常就没用了 —— 但**前提是原图确实在磁盘上**。
      // 若原图缺失（例如有人手删过原图，A16b 造的就是这个形状），暂存那份就是该页
      // 原图的**唯一一份**，此时必须留下，否则这一页会变成「只有译文没有原图」。
      if (this._findOriginalName(dir, item.seq)) this._unstageBytes(task.taskId, item.seq);
      this._emitItemStatus(task, batch, item);
      this._syncBatchStatuses(task);
      await this._persist(task);
      return;
    }

    item.status = 'translating';
    this._emitItemStatus(task, batch, item);
    this._syncBatchStatuses(task);
    // 🔴 必须落盘。`_emitItemStatus` / `_syncBatchStatuses` 只改内存并发事件，
    // 不写盘 —— 于是"这一页正在跑"在**磁盘上不存在**，落盘的永远是上一次终态。
    // U10② 的现场就吃了这个亏：快照读到 `{total:13, done:8, failed:0, current:0}`，
    // 看起来"什么都没在跑"，而实际有一页正卡在引擎里、连"它存在"都看不出来。
    // 磁盘状态必须能回答"现在在跑哪一页"，否则崩溃/挂死现场一律无法归因。
    await this._persist(task);

    const t0 = Date.now();
    // 字节来源三选一：内存（`this.blobs`，快路径）→ **暂存区**（G-12 的持久副本，活得过进程）
    // → 磁盘（续做路径，原图早已落盘）。内存那份是缓存，暂存那份才是崩溃时的唯一依据。
    const bytes = item.fromDisk
      ? this._readOriginalFromDisk(task, item.seq)
      : (this.blobs.get(blobKey) || this._readStagedBytes(task.taskId, item.seq));
    if (!bytes) {
      if (!item.fromDisk) throw new Error('原图字节已丢失（内存与暂存区均无）');
      // 续做时原图不见了：单张失败，不中断任务（其余页照常续做）
      item.status = 'failed';
      item.reason = 'original_missing';
      item.durationMs = Date.now() - t0;
      this._emitItemStatus(task, batch, item);
      this._syncBatchStatuses(task);
      await this._persist(task);
      return;
    }

    // 失败注入（覆盖 failed / partial_failed / 重试路径）；真实失败来自引擎
    const forceFail = config.failSeqs.has(item.seq) ||
      (config.itemFailRate > 0 && Math.random() < config.itemFailRate);

    // 《04》§9.3 懒加载恢复：③ LLM 可能已被空闲卸载（§9.1 Tier1）。任务到来时先把它拉回来，
    // 再走正常链路 —— 对用户表现为「这张稍慢」，而**不是失败**（§9.4：卸载 ≠ 未就绪）。
    // ⚠️ 必须放在**重试循环之外**：③ 没起来时每一张都会失败，把它放进循环里只会把 3 次重试
    //    浪费在同一次等待上（而且三次都是同一个原因失败，看着像"引擎坏了"）。
    if (typeof this.ensureLlm === 'function') {
      try { await this.ensureLlm(); } catch { /* 起不来就照常往下走 —— 真正的失败原因由 translateImage 给出 */ }
    }

    let attempt = 0;
    let translated = null;
    let lastErr = null;
    // 单项**总预算**（含所有重试）。见 config.itemTimeoutMs 的注释：
    // 没有它，一次挂住 = 单次超时 × 重试次数 = **20 分钟完全静默**，
    // 而且中途不写状态、不打日志 ⇒ 外部无法区分"在慢慢想"与"已经死了"。
    const deadline = t0 + config.itemTimeoutMs;
    for (;;) {
      attempt++;
      // 预算耗尽就**不再开新的一次尝试** —— 这条是"静默有上界"的承重点：
      // 少了它，重试会把等待时间叠乘（`engineTimeoutMs × MAX_ATTEMPTS`）。
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        lastErr = new EngineError('ENGINE_TIMEOUT',
          `单项总预算 ${config.itemTimeoutMs}ms 已耗尽（第 ${attempt} 次尝试开始前）`);
        break;
      }
      // 每次尝试的**请求超时**取两者之小：剩余预算 × 「单次请求多久算没响应」。
      // 少了后半截，只要有人把单项预算调大（`MIAO_ITEM_TIMEOUT_MS` > `MIAO_ENGINE_TIMEOUT_MS`），
      // 一次挂住就能吃掉整个预算 —— 「单次请求上限」这个旋钮会形同虚设。
      const attemptTimeoutMs = Math.min(remaining, config.engineTimeoutMs);
      try {
        if (forceFail) throw new EngineError('ENGINE_ERROR', 'injected_failure');
        translated = await translateImage(bytes, {
          seq: item.seq, from: 'ja', to: 'zh', mime: item.mime, timeoutMs: attemptTimeoutMs,
        });
        break;
      } catch (err) {
        lastErr = err;
        // 🔴 **每一次尝试失败都留痕**。U10② 最致命的地方不是"超时了"，而是**超时了却没有任何输出**：
        // 从外面看，它与"引擎正在慢慢推理"逐字节相同，于是只能登记成"偶发、成因待抓"。
        // 这一行把三件事说清楚：第几次、已经花了多久、**引擎最后在做什么**
        //（超时时 engine-client 会把已收到的帧解析成阶段附在 `detail.frames` 上）。
        const stage = (err && err.detail && Array.isArray(err.detail.frames))
          ? err.detail.frames.filter((f) => f.text || f.code === 4)
            .slice(-3).map((f) => f.text || '等待翻译实例').join(' → ')
          : '';
        console.warn(`[item ${task.taskId}#${item.seq}] 第 ${attempt}/${MAX_ATTEMPTS} 次尝试失败：`
          + `${(err && err.code) || 'internal_error'} · 已用 ${Date.now() - t0}ms`
          + ` · 预算剩 ${Math.max(0, deadline - Date.now())}ms`
          + (stage ? ` · 引擎阶段：${stage}` : ' · 引擎无阶段帧'));
        // 《04》§8.2：OOM ⇒ 降一档重试**一次**，且**不叠加** item 级重试 —— 所以这里把
        // attempt 回退一格再重试（一次 OOM 只算降档那一次，不额外吃掉 item 的重试预算）。
        // 降档是**服务级**的：`this.tierDowngrade` 是进程级单例，降完之后后续所有 item 都走新档。
        // ⚠️ 不会打转：闩落下后再 OOM，`tryDowngrade()` 返回 `already-downgraded` ⇒ 落到下面的
        //    常规重试/失败分支（§8.2 底线「已是最低档仍 OOM ⇒ 任务 failed」）。
        if (this.tierDowngrade && isOomError(err)) {
          const r = await this.tierDowngrade.tryDowngrade();
          if (r.downgraded) {
            attempt -= 1;
            continue;
          }
        }
        if (attempt >= MAX_ATTEMPTS) break;
        await sleep(RETRY_BACKOFF_MS);
      }
    }

    if (!translated) {
      const code = lastErr instanceof EngineError ? lastErr.code : 'internal_error';
      item.status = 'failed';
      item.retryCount = attempt - 1;
      item.reason = forceFail
        ? (config.failSeqs.has(item.seq) ? 'injected_failure' : 'random_failure')
        : `engine_${String(code).toLowerCase()}`;
      item.errorMessage = lastErr ? String(lastErr.message || lastErr) : null;
      item.durationMs = Date.now() - t0;
      this._recordDuration(item.durationMs);
      // G-11（用户裁定 A，2026-10-03）：失败页的**原图也要落盘**。
      // 不落的话该页会同时丢掉三件事：
      //   ① 不可续做 —— /library/{name}/resume 只挑「有原图、缺译文」的页，它永远不在清单里；
      //   ② 库里的说法是错的 —— 它落进 missingSeqs 显示「缺页」（读起来像用户没给过这页），
      //      而队列屏同一条记录写的是「1 张失败」，同一张图两屏两个故事；
      //   ③ 契约 §4.3「单图重跑」与插件《README》「重新翻译」都假定服务端还拿得到原图，
      //      不落盘就等于承诺了一个做不到的动作。
      // 语义边界：约束的是「**已处理但失败**」的页。用户主动取消、从未处理的页仍不落盘
      //（_skipAllPending 根本不进 _processItem），「避免残缺目录」那条设计意图不受影响。
      this._keepOriginalOnFailure(task, item, bytes);
      this.blobs.delete(blobKey);
      this._emitItemStatus(task, batch, item);
      this._syncBatchStatuses(task);
      await this._persist(task);
      return;
    }

    // 落盘原图 + 译文。只有真正的落盘/资源错误才降级为 saved:false 且不阻断主路径
    // （§4.2「落盘失败不阻断主路径」）；其余错误（尤其是 §8.2 安全/路径类 ApiError）向上抛。
    try {
      await this._writeItem(task, item, bytes, translated);
      item.saved = true;
    } catch (err) {
      const degradable = !(err instanceof ApiError) && DEGRADABLE_WRITE_ERRNOS.has(err && err.code);
      if (!degradable) throw err;
      item.saved = false;
      item.reason = err.code === 'ENOSPC' ? 'disk_full' : `write_failed:${err.code}`;
    } finally {
      this.blobs.delete(blobKey);
    }
    item.status = 'success';
    item.durationMs = Date.now() - t0;
    this._recordDuration(item.durationMs);
    this._emitItemStatus(task, batch, item);
    this._syncBatchStatuses(task);
    await this._persist(task);
  }

  _translatedExists(dir, seq) {
    return this._findTranslatedName(dir, seq) !== null;
  }

  _findTranslatedName(dir, seq) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = TRANSLATED_SCAN_RE.exec(f);
        if (m && Number(m[1]) === seq) return f;
      }
    } catch { /* 目录不存在 */ }
    return null;
  }

  /** 与 `_findTranslatedName` 对称：该 seq 的原图在不在磁盘上（G-12 判「暂存处不处理」） */
  _findOriginalName(dir, seq) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = ORIGINAL_SCAN_RE.exec(f);
        if (m && Number(m[1]) === seq) return f;
      }
    } catch { /* 目录不存在 */ }
    return null;
  }

  /**
   * 落盘：原图 + 译文。
   *
   * 两个文件名的校验都放在**创建目录之前**（先算译文名 —— 它只依赖引擎返回字节，
   * 不需要目录存在），这样任一侧名字不合法时都不会留下一个空目录。
   */
  async _writeItem(task, item, originalBytes, translated) {
    // 译文的扩展名由引擎返回字节决定；极端情况下引擎改换了容器格式也不会写出错误扩展名的文件
    const translatedExt = sniffImageType(translated.bytes) || item.ext;
    const translatedName = `${seq3(item.seq)}_translated.${translatedExt}`;
    if (!FILE_NAME_RE.test(translatedName)) {
      throw new ApiError('PERMISSION_DENIED', '服务端生成的文件名不合法', { translated: translatedName });
    }

    this._writeOriginal(task, item, originalBytes);

    const dir = this.taskDir(task);
    /**
     * 译文的落盘 flag：**默认 `'wx'`（独占，已存在即失败）**，这是「不覆盖」的硬保证。
     *
     * 返工重译（`item.overwrite`）是**唯一**允许覆盖译文的场景 —— 用户明确要求重译，
     * 不覆盖的话旧译文会永远留在那儿，返工等于没做。改用 `'w'` 之前先删掉旧文件：
     * 扩展名可能与上次不同（上次 png、这次 jpg），只覆盖同名会留下**两份**译文，
     * 而扫描按 readdir 顺序认第一个 ⇒ 用户看到"重译了但还是旧图"。
     */
    if (item.overwrite) {
      const stale = this._findTranslatedName(dir, item.seq);
      if (stale && stale !== translatedName) {
        try { fs.rmSync(path.join(dir, stale), { force: true }); } catch { /* 删不掉就下面写同名那份 */ }
      }
    }
    fs.writeFileSync(path.join(dir, translatedName), translated.bytes,
      { flag: item.overwrite ? 'w' : 'wx', mode: 0o600 });
    item.outputFile = translatedName;
    item.sha256 = sha256(translated.bytes);
  }

  /**
   * 只把**原图**写下去：惰性 mkdir + 三次安全校验 + 独占写入，永不覆盖。
   * 扩展名取**上传字节的嗅探结果**（`item.ext`，创建时已校验非空）——
   * 不信任任何自带声明（契约 §7.2）。
   *
   * 单独成一个方法是因为它现在有**三个调用点**：成功路径（原图 + 译文）、
   * 失败路径（G-11：失败页也保原图）、以及**启动时把暂存的原图搬回漫画目录**（G-12）。
   * 三处必须走**同一套**安全校验，不能各写一份 —— 那种重复迟早会漂移成
   * 「一个路径有校验、另一个没有」。
   *
   * 它同时是**撤暂存的唯一时机**（末尾那行）：见那里的注释。
   */
  _writeOriginal(task, item, bytes) {
    if (!isSafeDirName(task.dirName)) {
      throw new ApiError('PERMISSION_DENIED', '漫画名含路径成分，拒绝落盘', { dirName: task.dirName });
    }
    if (config.diskFull) {
      // 演练用：强制落盘失败（契约 §2.2 DISK_FULL / §4.2 saved:false）
      const err = new Error('ENOSPC: no space left on device（MIAO_DISK_FULL 演练）');
      err.code = 'ENOSPC';
      throw err;
    }
    const dir = this.taskDir(task);
    const original = `${seq3(item.seq)}.${item.ext}`;
    if (!FILE_NAME_RE.test(original)) {
      throw new ApiError('PERMISSION_DENIED', '服务端生成的文件名不合法', { original });
    }

    // 校验点 3：拼接后前缀（创建目录前）
    assertInsideRoot(this.root, path.join(dir, original));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // 目录惰性创建
    assertInsideRoot(this.root, path.join(dir, original)); // 校验点 3：打开文件前

    const originalPath = path.join(dir, original);
    if (fs.existsSync(originalPath)) {
      /*
       * 原图已在磁盘上：**永不覆盖**（契约 §7.2）。
       *  · 续做路径（item.fromDisk）下这是正常情形 —— 我们本来就是来补译文的。
       *  · 但「已存在」必须是**同一份字节**；内容不同意味着 seq 撞号，此时静默跳过会让
       *    用户的第 N 页被悄悄替换成别的图，故宁可报 409 让上层显式处理。
       */
      const onDisk = fs.readFileSync(originalPath);
      if (!onDisk.equals(bytes)) {
        throw new ApiError('SEQUENCE_OVERFLOW',
          `序号 ${seq3(item.seq)} 已被另一张原图占用（内容不一致），拒绝覆盖`,
          { seq: item.seq, dirName: task.dirName, onDiskBytes: onDisk.length, newBytes: bytes.length });
      }
    } else {
      fs.writeFileSync(originalPath, bytes, { flag: 'wx', mode: 0o600 });
    }
    item.originalFile = original;
    // G-12：到这一行为止，该页的原图已**确认**在漫画目录里 —— 暂存那份的使命结束。
    // 这个「只有原图真的落了盘才撤暂存」的时机刻意只在这里定义一处：
    // 降级路径（ENOSPC 等抛出）会跳过它，于是暂存那份**被留下**，正是我们想要的兜底。
    this._unstageBytes(task.taskId, item.seq);
  }

  /**
   * G-11：失败页保原图的**降级纪律**。
   *
   * 只用同一套「可降级」判据（`DEGRADABLE_WRITE_ERRNOS`）：该页**本来就是失败的**，
   * 不能因为「顺手留个原图」也失败，就把整条任务从 `partial_failed` 升级成 `failed`
   * —— 那是把损失的**范围**放大了，与 §4.2「落盘失败不阻断主路径」同一条纪律。
   * 但 §8.2 的路径/安全类 `ApiError` 仍**向上抛**：那是必须让人看见的拒绝，不是可降级的噪声。
   *
   * 失败时**不改 `item.reason`** —— 它记的是「这张图为什么没译出来」，比「原图也没留下」
   * 更值得保留；后一件事由日志与磁盘实况承载（reason 被覆盖会把主因抹掉）。
   */
  _keepOriginalOnFailure(task, item, bytes) {
    try {
      this._writeOriginal(task, item, bytes);
    } catch (err) {
      const degradable = !(err instanceof ApiError) && DEGRADABLE_WRITE_ERRNOS.has(err && err.code);
      if (!degradable) throw err;
      item.originalFile = null;
      console.warn(`[G-11] seq ${item.seq} 翻译失败且原图未能保存（${err && err.code}）：该页将不可续做`);
    }
  }

  // ---------------------------------------------------------------- 终态

  _skipAllPending(task, reason) {
    for (const batch of task.batches) {
      for (const item of batch.items) {
        if (item.status === 'pending') {
          item.status = 'skipped';
          item.reason = reason;
          this._emitItemStatus(task, batch, item);
        }
      }
    }
    this._syncBatchStatuses(task);
  }

  _finalize(task, status) {
    task.status = status;
    task.finishedAt = nowIsoMs();
    task.queuePosition = 0;
    const idx = this.queue.indexOf(task);
    if (idx >= 0) this.queue.splice(idx, 1);
    // 移出队列后必须重排名次，否则余下任务的 queuePosition 与 GET /queue 的 position 打架（§5.7）
    this._reindexQueue();
    this._syncBatchStatuses(task);
    this._emitTaskStatus(task);
    this._persistNow(task);
    // G-12 的两种终态收尾（放在 persist **之后**：先让「任务已结束」落到清单上，
    // 中途被打断也只会留下一个空目录，而下一次启动会把它扫掉 —— 见 _sweepOrphanStaging）：
    //  · 取消 → **丢弃全部暂存**：未处理的页不得在漫画目录留下任何痕迹（《02》§4.3），
    //           而它们的字节也就此作废，留着只会变成孤儿；
    //  · 其余终态 → **清扫**：此时每页都已按各自规则落盘，暂存目录理应已空。
    if (status === 'canceled') this._dropStaged(task.taskId);
    else this._sweepStaged(task.taskId);
    this._forgetBlobs(task.taskId);
    if (task._settleResolve) {
      task._settleResolve();
      task._settleResolve = null;
    }
  }

  _settled(task, timeoutMs) {
    if (TASK_TERMINAL.has(task.status)) return Promise.resolve();
    if (!task._settlePromise) {
      task._settlePromise = new Promise((resolve) => { task._settleResolve = resolve; });
    }
    let timer = null;
    return Promise.race([
      task._settlePromise,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** POST /tasks/{taskId}/cancel（§5.6） */
  async cancelTask(taskId) {
    const task = this.mustTask(taskId);
    if (TASK_TERMINAL.has(task.status)) {
      throw new ApiError('TASK_NOT_CANCELABLE',
        `任务已处于终态 ${task.status}，无法取消`, { taskId, status: task.status });
    }
    task.cancelRequested = true;

    if (task.status === 'queued') {
      // 未开始：无文件、无目录产生；队列余下不受影响
      this._skipAllPending(task, 'canceled');
      this._finalize(task, 'canceled');
      return this._cancelResult(task);
    }
    // 正在 running：等当前张跑完（不中断 sidecar）
    await this._settled(task, 30000);
    if (!TASK_TERMINAL.has(task.status)) {
      this._skipAllPending(task, 'canceled');
      this._finalize(task, 'canceled');
    }
    return this._cancelResult(task);
  }

  _cancelResult(task) {
    const keptItems = this.allItems(task).filter((i) => i.status === 'success' && i.saved).length;
    return {
      taskId: task.taskId,
      status: 'canceled',
      keptItems,
      outputDir: task.outputDir,
    };
  }

  // ---------------------------------------------------------------- 视图

  /** §5.2 / §5.3 的创建与追加响应 */
  createView(task) {
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      normalizedComicName: task.normalizedComicName,
      outputDir: task.outputDir,
      status: task.status,
      queuePosition: task.queuePosition,
      batches: task.batches.map(batchBrief),
      eta: this.etaFor(task),
      createdAt: task.createdAt,
    };
  }

  /** §5.4 的任务详情 */
  detailView(task, { itemsFrom, itemsTo } = {}) {
    const items = this.allItems(task).filter((i) => {
      if (itemsFrom !== undefined && i.seq < itemsFrom) return false;
      if (itemsTo !== undefined && i.seq > itemsTo) return false;
      return true;
    });
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      normalizedComicName: task.normalizedComicName,
      outputDir: task.outputDir,
      status: task.status,
      queuePosition: task.queuePosition,
      progress: this.progressOf(task),
      batches: task.batches.map(batchBrief),
      items: items.map(itemBrief),
      eta: this.etaFor(task),
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    };
  }

  progressOf(task) {
    const items = this.allItems(task);
    const done = items.filter((i) => i.status === 'success' || i.status === 'skipped').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const cur = items.find((i) => i.status === 'translating');
    return { total: items.length, done, failed, current: cur ? cur.seq : 0 };
  }

  /** §5.7 队列快照（排队位次与 eta 的唯一来源） */
  queueSnapshot() {
    const running = this.currentTask();
    if (process.env.MIAO_DEBUG) {
      console.error('[debug] queueSnapshot', 'currentTaskId=', this.currentTaskId,
        'running=', running && running.comicName, 'queue=', this.queue.map((t) => t.comicName),
        'tasks=', [...this.tasks.keys()].length);
    }
    return {
      running: running ? {
        taskId: running.taskId,
        comicName: running.comicName,
        progress: (() => { const p = this.progressOf(running); return { done: p.done, total: p.total }; })(),
      } : null,
      queued: this.queue.map((t, i) => ({
        taskId: t.taskId,
        comicName: t.comicName,
        position: i + 1,
        imageCount: this.allItems(t).length,
        etaSeconds: this.etaSecondsFor(t),
      })),
      updatedAt: nowIso(),
    };
  }

  /** 队列页的一行（列表端点专用，非契约端点；见 docs/spec-notes.md G-04） */
  listView(task) {
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      /**
       * 归一化后的目录名。
       *
       * 为什么列表行也要带它：漫画库要判「这本书是否已有任务在跑」，
       * 而库里显示的是**原始漫画名**、落盘用的是**归一化名**（两者可能差空格/大小写）。
       * 前端拿原始名去比会漏判 ⇒ 已经排队的书还能再点一次返工 ⇒ 同一本被两个任务
       * 前后脚跑、译文互相覆盖。与其让前端猜归一化规则，不如把真值给出去。
       */
      normalizedComicName: task.normalizedComicName,
      source: task.source || 'unknown',
      status: task.status,
      queuePosition: task.queuePosition,
      progress: this.progressOf(task),
      outputDir: task.outputDir,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    };
  }

  /**
   * 任务列表：运行中 → 排队中 → 终态（终态按 finishedAt 倒序，最新在上）。
   *
   * 数据源是 `this.tasks`：`init()` 已把 `STATE_DIR/tasks/*.json` 的清单全部恢复进来，
   * 所以这张列表**天然跨重启**——用户在队列页看到的已完成/失败行，正是上次会话留下的
   * 真实记录，而不是内存里的残影。契约 §5.7 的 `/queue` 只给 running+queued，
   * 无法承载 X-C1 的「已完成 / 部分失败 / 失败」行（见 spec-notes G-04）。
   */
  taskListView({ status, limit } = {}) {
    const all = [...this.tasks.values()];

    const running = all.filter((t) => t.status === 'running');
    const queued = this.queue.slice(); // 数组顺序即 queuePosition
    const seen = new Set(queued.map((t) => t.taskId));
    for (const t of all) {
      if (t.status === 'queued' && !seen.has(t.taskId)) queued.push(t); // 兜底，理论不触发
    }
    const terminal = all
      .filter((t) => TASK_TERMINAL.has(t.status))
      .sort((a, b) => tsOf(b.finishedAt || b.createdAt) - tsOf(a.finishedAt || a.createdAt));

    let rows = [...running, ...queued, ...terminal];
    if (status && status !== 'all') {
      const want = new Set(String(status).split(',').map((s) => s.trim()).filter(Boolean));
      rows = rows.filter((t) => want.has(t.status));
    }
    const total = rows.length;
    const limited = Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows;

    return {
      count: limited.length,
      total,
      running: running.length,
      queued: queued.length,
      tasks: limited.map((t) => this.listView(t)),
      updatedAt: nowIso(),
    };
  }

  // ---------------------------------------------------------------- eta

  _recordDuration(ms) {
    if (!Number.isFinite(ms)) return;
    this.durations.push(ms);
    if (this.durations.length > ETA_SAMPLE_WINDOW) this.durations.shift();
  }

  _avgDuration() {
    if (this.durations.length === 0) return null;
    return this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
  }

  /** 前方剩余总张数（见交付说明的 eta 口径裁决） */
  aheadCountFor(task) {
    if (task.status === 'running' || task.queuePosition === 0) return this.pendingCount(task);
    let n = 0;
    const running = this.currentTask();
    if (running && running.taskId !== task.taskId) n += this.pendingCount(running);
    for (const t of this.queue) {
      if (t.taskId === task.taskId) break;
      n += this.pendingCount(t);
    }
    return n;
  }

  /** §5.2 的 eta 对象；MIAO_ETA_NULL=1 时恒为 null */
  etaFor(task) {
    if (config.etaNull) return null;
    const avg = this._avgDuration();
    if (avg === null) {
      // 无历史样本（首跑）：仍是区间
      return { minSeconds: 60, maxSeconds: 180, text: '预计 1–3 分钟' };
    }
    const ahead = this.aheadCountFor(task);
    const base = (avg * ahead) / 1000;
    const min = Math.max(1, Math.round(base * 0.8));
    const max = Math.max(min + 1, Math.round(base * 1.5));
    return { minSeconds: min, maxSeconds: max, text: formatEtaText(min, max) };
  }

  /** §5.7 的 etaSeconds；无样本时同样返回 1–3 分钟区间 */
  etaSecondsFor(task) {
    if (config.etaNull) return null;
    const eta = this.etaFor(task);
    return { min: eta.minSeconds, max: eta.maxSeconds, text: eta.text };
  }

  // ---------------------------------------------------------------- 事件

  _emit(task, event, data) {
    const rec = { id: ++this.eventSeq, event, data };
    task.events.push(rec);
    if (task.events.length > MAX_EVENT_LOG) task.events.splice(0, task.events.length - MAX_EVENT_LOG);
    for (const res of task.clients) {
      if (!writeSseEvent(res, rec)) task.clients.delete(res);
    }
    this.lastEventAt = Date.now();
    return rec;
  }

  _emitTaskStatus(task) {
    this._emit(task, 'task.status', {
      taskId: task.taskId,
      status: task.status,
      queuePosition: task.queuePosition,
    });
  }

  _emitBatchStatus(task, batch) {
    this._emit(task, 'batch.status', {
      taskId: task.taskId,
      batchIndex: batch.batchIndex,
      status: batch.status,
      seqFrom: batch.seqFrom,
      seqTo: batch.seqTo,
    });
  }

  _emitItemStatus(task, batch, item) {
    this._emit(task, 'item.status', {
      taskId: task.taskId,
      batchIndex: batch.batchIndex,
      seq: item.seq,
      status: item.status,
      saved: item.saved,
      outputFile: item.outputFile,
      durationMs: item.durationMs,
    });
  }

  /** 心跳：不进入事件日志，只发给当前订阅者（id 仍递增，保证 Last-Event-ID 语义） */
  broadcastHeartbeat() {
    const ts = nowIso();
    for (const task of this.tasks.values()) {
      if (task.clients.size === 0) continue;
      const rec = { id: ++this.eventSeq, event: 'heartbeat', data: { ts } };
      for (const res of task.clients) {
        if (!writeSseEvent(res, rec)) task.clients.delete(res);
      }
    }
  }

  /** SSE 订阅：先按 Last-Event-ID 重放，再挂上实时推送 */
  subscribe(taskId, res, lastEventId) {
    const task = this.mustTask(taskId);
    const last = Number.isFinite(lastEventId) ? lastEventId : -1;
    for (const rec of task.events) {
      if (rec.id > last) writeSseEvent(res, rec);
    }
    task.clients.add(res);
    return () => { task.clients.delete(res); };
  }

  // ---------------------------------------------------------------- 状态同步

  _syncBatchStatuses(task) {
    for (const batch of task.batches) {
      const next = batchStatusOf(task, batch);
      if (batch.status !== next) {
        batch.status = next;
        this._emitBatchStatus(task, batch);
      }
    }
  }

  // ---------------------------------------------------------------- 持久化

  serialize(task) {
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      normalizedComicName: task.normalizedComicName,
      dirName: task.dirName,
      outputDir: task.outputDir,
      status: task.status,
      lang: task.lang,
      translator: task.translator,
      clientTaskRef: task.clientTaskRef,
      source: task.source || 'unknown',
      idempotencyKey: task.idempotencyKey,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      finalProgress: this.progressOf(task),
      batches: task.batches.map((b) => ({
        batchIndex: b.batchIndex,
        count: b.count,
        seqFrom: b.seqFrom,
        seqTo: b.seqTo,
        status: b.status,
        idempotencyKey: b.idempotencyKey,
        items: b.items.map((i) => ({
          seq: i.seq,
          ext: i.ext,
          byteSize: i.byteSize,
          fromDisk: !!i.fromDisk,
          status: i.status,
          saved: i.saved,
          originalFile: i.originalFile,
          outputFile: i.outputFile,
          sha256: i.sha256,
          durationMs: i.durationMs,
          retryCount: i.retryCount,
          reason: i.reason,
        })),
      })),
    };
  }

  _persistNow(task) {
    try {
      fs.mkdirSync(TASKS_STATE_DIR, { recursive: true, mode: 0o700 });
      const file = path.join(TASKS_STATE_DIR, `${task.taskId}.json`);
      fs.writeFileSync(file, JSON.stringify(this.serialize(task), null, 2), { mode: 0o600 });
    } catch { /* 任务清单写入失败不影响主路径 */ }
  }

  async _persist(task) {
    this._persistNow(task);
  }
}

// ------------------------------------------------------------------ 纯函数

/** ISO 时间 → 毫秒；缺失/非法一律 0（排序时排到最后） */
function tsOf(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

function batchBrief(b) {
  return {
    batchIndex: b.batchIndex,
    count: b.count,
    seqFrom: b.seqFrom,
    seqTo: b.seqTo,
    status: b.status,
  };
}

function itemBrief(i) {
  return {
    seq: i.seq,
    status: i.status,
    saved: i.saved,
    outputFile: i.outputFile,
    durationMs: i.durationMs,
    retryCount: i.retryCount,
    reason: i.reason,
    sha256: i.sha256,
  };
}

export function endStatusOf(items) {
  const success = items.filter((i) => i.status === 'success' || i.status === 'skipped').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  if (failed === 0) return 'done';
  if (success > 0) return 'partial_failed';
  return 'failed';
}

function batchStatusOf(task, batch) {
  const st = batch.items.map((i) => i.status);
  if (task.status === 'canceled' &&
      st.some((s, idx) => s === 'skipped' && batch.items[idx].reason === 'canceled')) {
    return 'canceled';
  }
  if (st.every((s) => s === 'pending')) return 'queued';
  if (st.some((s) => s === 'pending' || s === 'translating')) return 'running';
  const ok = st.filter((s) => s === 'success' || s === 'skipped').length;
  const bad = st.filter((s) => s === 'failed').length;
  if (bad === 0) return 'done';
  if (ok === 0) return 'failed';
  return 'partial_failed';
}

export function formatEtaText(minSeconds, maxSeconds) {
  if (maxSeconds < 60) return `预计 ${minSeconds}–${maxSeconds} 秒`;
  const m1 = Math.max(1, Math.floor(minSeconds / 60));
  const m2 = Math.max(m1 + 1, Math.ceil(maxSeconds / 60));
  return `预计 ${m1}–${m2} 分钟`;
}

/** imageOrder[] 显式顺序兜底：支持「原始 filename」或「1 起序号」两种写法 */
export function orderImages(images, imageOrder) {
  if (!imageOrder || imageOrder.length === 0) return images;
  const byName = new Map();
  images.forEach((img, i) => {
    if (img.filename && !byName.has(img.filename)) byName.set(img.filename, i);
    if (!byName.has(String(i + 1))) byName.set(String(i + 1), i);
  });
  const picked = new Set();
  const out = [];
  for (const key of imageOrder) {
    const idx = byName.get(String(key).trim());
    if (idx === undefined || picked.has(idx)) continue;
    picked.add(idx);
    out.push(images[idx]);
  }
  images.forEach((img, i) => { if (!picked.has(i)) out.push(img); });
  return out;
}

function validateAndPrepare(dir) {
  // 启动时校验一次由 server 层通过 validateRoot 完成；此处只做规范化兜底
  return canonicalize(dir);
}

export { BATCH_LIMIT, MAX_SEQ };
