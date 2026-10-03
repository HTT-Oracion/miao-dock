// 任务 / 批次 / 单图三层状态 + 串行 FIFO 队列 + 落盘 + eta
// 契约依据：§3 数据模型、§4 状态机、§5.2–5.7、§7 落盘、§8.2 安全
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  BATCH_LIMIT, ETA_SAMPLE_WINDOW, MAX_SEQ, FILE_NAME_RE, ORIGINAL_SCAN_RE,
  TRANSLATED_SCAN_RE, TASKS_STATE_DIR, IDEMPOTENCY_FILE,
  assertInsideRoot, canonicalize, config, seq3,
} from './config.mjs';
import { ApiError } from './errors.mjs';
import { sniffImageType } from './image.mjs';
import { translateImage, EngineError } from './engine-client.mjs';
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
    this.startedAt = nowIso();
  }

  // ---------------------------------------------------------------- 启动恢复

  init() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(TASKS_STATE_DIR, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) this.idempotency.set(k, v);
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
          // 重启后内存中的原图字节已丢失，无法续做：按失败收尾（见交付说明中的歧义处置）
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
        }
        this.tasks.set(task.taskId, task);
        restored++;
      } catch { /* 单个任务文件损坏则跳过 */ }
    }
    return { restored, aborted };
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
    for (const item of items) this.blobs.set(`${task.taskId}:${item.seq}`, item.__bytes);
    for (const item of items) delete item.__bytes;

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
      createdAt: nowIso(),
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
    for (const item of items) this.blobs.set(`${task.taskId}:${item.seq}`, item.__bytes);
    for (const item of items) delete item.__bytes;

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
    };
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

  // ---------------------------------------------------------------- 单图处理

  async _processItem(task, batch, item) {
    const dir = this.taskDir(task);
    const blobKey = `${task.taskId}:${item.seq}`;

    // 幂等续做：NNN_translated.* 已存在 → skipped(already_exists)，序号不变
    if (config.skipExisting && this._translatedExists(dir, item.seq)) {
      item.status = 'skipped';
      item.reason = 'already_exists';
      item.saved = true;
      item.outputFile = this._findTranslatedName(dir, item.seq);
      this.blobs.delete(blobKey);
      this._emitItemStatus(task, batch, item);
      this._syncBatchStatuses(task);
      await this._persist(task);
      return;
    }

    item.status = 'translating';
    this._emitItemStatus(task, batch, item);
    this._syncBatchStatuses(task);

    const t0 = Date.now();
    // 字节来源二选一：上传路径在内存（this.blobs），续做路径在磁盘（原图早已落盘）
    const bytes = item.fromDisk ? this._readOriginalFromDisk(task, item.seq) : this.blobs.get(blobKey);
    if (!bytes) {
      if (!item.fromDisk) throw new Error('原图字节已丢失（服务可能重启过）');
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

    let attempt = 0;
    let translated = null;
    let lastErr = null;
    for (;;) {
      attempt++;
      try {
        if (forceFail) throw new EngineError('ENGINE_ERROR', 'injected_failure');
        translated = await translateImage(bytes, { seq: item.seq, from: 'ja', to: 'zh', mime: item.mime });
        break;
      } catch (err) {
        lastErr = err;
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

  /**
   * 落盘：惰性 mkdir + 三次安全校验 + 独占写入。
   * 原图扩展名取**上传字节的嗅探结果**（item.ext）；译文扩展名取**引擎返回字节的嗅探结果**
   * —— 两侧都不信任任何自带声明（契约 §7.2）。
   */
  async _writeItem(task, item, originalBytes, translated) {
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

    // 译文的扩展名由引擎返回字节决定；极端情况下引擎改换了容器格式也不会写出错误扩展名的文件
    const translatedExt = sniffImageType(translated.bytes) || item.ext;
    const translatedName = `${seq3(item.seq)}_translated.${translatedExt}`;

    if (!FILE_NAME_RE.test(original) || !FILE_NAME_RE.test(translatedName)) {
      throw new ApiError('PERMISSION_DENIED', '服务端生成的文件名不合法', { original, translated: translatedName });
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
      if (!onDisk.equals(originalBytes)) {
        throw new ApiError('SEQUENCE_OVERFLOW',
          `序号 ${seq3(item.seq)} 已被另一张原图占用（内容不一致），拒绝覆盖`,
          { seq: item.seq, dirName: task.dirName, onDiskBytes: onDisk.length, newBytes: originalBytes.length });
      }
      item.originalFile = original;
    } else {
      fs.writeFileSync(originalPath, originalBytes, { flag: 'wx', mode: 0o600 });
      item.originalFile = original;
    }

    fs.writeFileSync(path.join(dir, translatedName), translated.bytes, { flag: 'wx', mode: 0o600 });
    item.outputFile = translatedName;
    item.sha256 = sha256(translated.bytes);
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
    task.finishedAt = nowIso();
    task.queuePosition = 0;
    const idx = this.queue.indexOf(task);
    if (idx >= 0) this.queue.splice(idx, 1);
    // 移出队列后必须重排名次，否则余下任务的 queuePosition 与 GET /queue 的 position 打架（§5.7）
    this._reindexQueue();
    this._syncBatchStatuses(task);
    this._emitTaskStatus(task);
    this._persistNow(task);
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
