#!/usr/bin/env node
/**
 * F3-b 的 **Node 侧执行器**：读一个场景定义（由 Rust `--store-exec-selftest` 吐出的唯一事实源），
 * 用**真 `store.mjs`** 跑一遍，把同形报告打到 stdout。
 *
 * 为什么单独一个文件而不是内联在钉子脚本里：钉子要 spawn 它**每场景一个进程**
 * （Node 的 `config` 在模块加载期读 env ⇒ 换 env 就得换进程），内联会让钉子变得难读。
 *
 * 🔴 它扮演的是 **server 层** 那一小段接线（`POST /tasks` 的入参组装）：
 *    · `payload.__normalizedName` 是 server 层注入的目录名（`store.createTask` 只认双下划线那个键）
 *    · 引擎走 `MIAO_ENGINE_PROTOCOL=mock` 打钉子脚本里的伪引擎（由钉子设在进程 env 上）
 *
 * 用法：MIAO_ROOT=... MIAO_STATE_DIR=... MIAO_ENGINE_PROTOCOL=mock MIAO_ENGINE_PORT=... \
 *       node e2e/service/_store-exec-node-runner.mjs <scenario.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const unb64 = (s) => Buffer.from(s || '', 'base64');

function itemErrorsOf(task) {
  const out = {};
  if (!task) return out;
  for (const b of task.batches || []) {
    for (const it of b.items || []) {
      if (it.errorMessage != null) out[String(it.seq)] = it.errorMessage;
    }
  }
  return out;
}

function diskOf(root, comic) {
  if (!comic) return null;
  const dir = path.join(root, comic);
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

async function main() {
  const sc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ROOT = process.env.MIAO_ROOT;
  const { Store } = await import(pathToFileURL(path.join(REPO_ROOT, 'service/src/manga/store.mjs')).href);

  // 预置文件（两边各自在自己的 root 下建）
  for (const f of sc.preFiles || []) {
    const p = path.join(ROOT, f.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, unb64(f.b64));
  }

  const store = new Store(ROOT);
  let outcome = null;
  let result = null;
  let error = null;
  let tid = '';

  try {
    if (sc.kind === 'create') {
      const images = (sc.images || []).map((i) => ({ filename: i.filename, data: unb64(i.b64) }));
      const payload = { ...sc.payload };
      // server 层注入的目录名（`store.createTask` 只读 `__normalizedName`）
      if (payload.normalizedName != null) payload.__normalizedName = payload.normalizedName;
      const r = store.createTask({ payload, images, imageOrder: sc.imageOrder || [], source: sc.source });
      tid = r.task.taskId;
      outcome = { taskId: tid, replay: r.replay };
      if (sc.drain !== false) await store._settled(r.task, 60000);
    } else {
      for (const s of sc.seeds || []) {
        const t = JSON.parse(JSON.stringify(s));
        t.clients = new Set();
        t.events = [];
        t.cancelRequested = false;
        t.outputDir = path.join(ROOT, t.dirName);
        store.tasks.set(t.taskId, t);
      }
      for (const id of sc.queueIds || []) store.queue.push(store.tasks.get(id));
      if (sc.currentTaskId) store.currentTaskId = sc.currentTaskId;
      for (const e of sc.idempotency || []) {
        store.idempotency.set(e.key, { taskId: e.taskId, batchIndex: e.batchIndex, at: Date.now() });
      }

      if (sc.op === 'cancel') {
        tid = sc.opArg;
        result = await store.cancelTask(sc.opArg);
      } else if (sc.op === 'retry') {
        tid = sc.opArg;
        const r = await store.retryTask(sc.opArg);
        result = { taskId: r.task.taskId, reused: r.reused };
        if (sc.drain) await store._settled(r.task, 60000);
      } else if (sc.op === 'delete') {
        result = store.deleteTasks(sc.deleteIds || []);
      }
    }
  } catch (e) {
    error = { code: (e && e.code) || 'internal_error' };
  }

  const task = tid && store.tasks.get(tid) ? store.serialize(store.tasks.get(tid)) : null;
  const events = tid && store.tasks.get(tid) ? store.tasks.get(tid).events : [];
  const remainingTaskIds = [...store.tasks.keys()].sort();

  process.stdout.write(
    JSON.stringify({
      outcome,
      result,
      error,
      task,
      events,
      itemErrors: itemErrorsOf(tid ? store.tasks.get(tid) : null),
      disk: diskOf(ROOT, sc.comic),
      remainingTaskIds,
    }),
  );
}

await main();
