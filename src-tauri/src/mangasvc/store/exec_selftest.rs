// store 执行态自检（F3-b）—— 给 e2e 一个**稳定输入**下逐条比对 Rust 与 Node 的接缝
//
// `mangasvc --store-exec-selftest` 打印本模块的 `report()`。它把「建单 → 排队/启跑 → 单图处理
// （幂等短路 / 重试 / 总预算 / 落盘 / 终态）→ 取消 / 重试 / 删除」在**固定输入**下跑一遍，
// 连同每步的产物（持久化记录 / 事件序列 / 磁盘文件清单）一次性吐出来；
// `e2e/service/store-exec-parity-check.mjs` 用真 `store.mjs` 跑同一份输入并比对。
//
// 🔴 **场景定义是唯一事实源，而且只写在这里**：报告里带 `scenarios`（含每个场景的 env /
//    payload / 图片字节 / 预置文件 / 翻译脚本），Node 侧只负责「解析这些输入、跑自己的实现、
//    交回输出」。夹具两边各写一份必然悄悄走散 —— 那正是对照类断言最容易退化成假绿的地方。
//
// 🔴 **翻译是喂进去的**（见 `exec.rs` 模块头 ①）：Rust 用进程内脚本化 `Translator`，
//    Node 用 `MIAO_ENGINE_PROTOCOL=mock` 打对拍脚本里的伪引擎，两边拿到**逐字节相同**的
//    翻译结果 —— 于是这里比的是**编排语义**（记账 / 状态机 / 落盘 / 事件），不是引擎。
//
// ⚠️ 归一化（时间戳 / taskId / 绝对路径 / 事件 id / durationMs）**只在对拍脚本里做一次**，
//    本模块只吐**原始**产物；两边各自归一化 = 两套规则，又是一次走散的机会。
use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::mangasvc::engine::client::{TranslateOk, TranslateOpts};
use crate::mangasvc::engine::EngineError;
use crate::platform::paths;

use super::exec::{CreatePayload, InputImage, Translator};
use super::model::{Lang, Task};
use super::{EnvConfig, Store};

// ================================================================ 字节 / 图片夹具

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.as_bytes()).unwrap_or_default()
}

/// 造一份**可被 `sniffImageType` 认出**的 PNG 伪图：8 字节魔数 + 任意尾巴。
/// 尾巴里带 `tag` ⇒ 不同 seq 的字节不同 ⇒ `sha256` / `byteSize` 在对照时是真有区分度的。
fn png(tag: &str) -> Vec<u8> {
    let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(tag.as_bytes());
    v
}

/// 上传图片（`{filename,data}`）的 JSON 形态。
fn image_json(name: &str, tag: &str) -> Value {
    json!({ "filename": name, "b64": b64(&png(tag)) })
}

// ================================================================ 翻译脚本

/// 一次翻译的**脚本结果**。`Hang` 走「睡够再报超时」——用来把 `_processItem` 的
/// **单项总预算**分支逼出来（睡时长远大于 `itemTimeoutMs` ⇒ 第二次尝试开始前预算已耗尽）。
enum Step {
    Ok(Vec<u8>),
    Err(String, String),
    Hang { code: String, message: String, sleep_ms: u64 },
}

/// 按 seq 回放的翻译引擎（进程内，不打网络）。
struct Scripted {
    map: HashMap<i64, Step>,
    default: Step,
}

impl Translator for Scripted {
    fn translate(&self, _bytes: &[u8], opts: &TranslateOpts) -> Result<TranslateOk, EngineError> {
        let step = self.map.get(&opts.seq).unwrap_or(&self.default);
        match step {
            Step::Ok(b) => Ok(mk_ok(b.clone())),
            Step::Err(code, msg) => Err(EngineError::new(code, msg)),
            Step::Hang { code, message, sleep_ms } => {
                std::thread::sleep(std::time::Duration::from_millis(*sleep_ms));
                Err(EngineError::new(code, message))
            }
        }
    }
}

fn mk_ok(bytes: Vec<u8>) -> TranslateOk {
    let ext = super::pure::sniff_image_type(&bytes).unwrap_or("png").to_string();
    let mime = if ext == "jpg" { "image/jpeg".to_string() } else { format!("image/{ext}") };
    TranslateOk { bytes, ext, mime }
}

fn build_translator(sc: &Value) -> Scripted {
    let mut map = HashMap::new();
    if let Some(obj) = sc.get("translate").and_then(|x| x.as_object()) {
        for (k, v) in obj {
            let Ok(seq) = k.parse::<i64>() else { continue };
            let mode = v.get("mode").and_then(|x| x.as_str()).unwrap_or("ok");
            let step = match mode {
                "err" => Step::Err(
                    v.get("code").and_then(|x| x.as_str()).unwrap_or("ENGINE_ERROR").to_string(),
                    v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                ),
                "hang" => Step::Hang {
                    code: v.get("code").and_then(|x| x.as_str()).unwrap_or("ENGINE_TIMEOUT").to_string(),
                    message: v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    sleep_ms: v.get("sleepMs").and_then(|x| x.as_u64()).unwrap_or(400),
                },
                _ => Step::Ok(unb64(v.get("b64").and_then(|x| x.as_str()).unwrap_or(""))),
            };
            map.insert(seq, step);
        }
    }
    // 未在脚本里的 seq：回一份与 seq 绑定的稳定字节（两边的伪引擎都按 seq 认，见对拍脚本）。
    // 这里给一个**固定**兜底，脚本没写就说明场景没打算跑到它 —— 走到了两边都会一样地"成功"，
    // 不会因为兜底不同而误判。
    Scripted { map, default: Step::Ok(png("default-translated")) }
}

// ================================================================ env 覆盖

/// 场景自带的 env（`EnvConfig` 是**运行期可覆盖**的字段，本函数把它从场景里读出来）。
fn env_from(v: &Value) -> EnvConfig {
    let i = |k: &str, d: i64| v.get(k).and_then(|x| x.as_i64()).unwrap_or(d);
    EnvConfig {
        skip_existing: v.get("skipExisting").and_then(|x| x.as_bool()).unwrap_or(true),
        disk_full: v.get("diskFull").and_then(|x| x.as_bool()).unwrap_or(false),
        eta_null: v.get("etaNull").and_then(|x| x.as_bool()).unwrap_or(false),
        item_timeout_ms: i("itemTimeoutMs", 150),
        engine_timeout_ms: i("engineTimeoutMs", 600),
        fail_seqs: v
            .get("failSeqs")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default(),
        item_fail_rate: v.get("itemFailRate").and_then(|x| x.as_f64()).unwrap_or(0.0),
        // 反证开关不进场景定义（它不是被测行为，是元验证钩子）⇒ 恒 false。
        sniff_skip: false,
    }
}

// ================================================================ 预置文件（两边各自在**自己的 root** 下建）

fn create_pre_files(root: &Path, sc: &Value) {
    if let Some(arr) = sc.get("preFiles").and_then(|x| x.as_array()) {
        for f in arr {
            let rel = f.get("rel").and_then(|x| x.as_str()).unwrap_or("");
            let data = unb64(f.get("b64").and_then(|x| x.as_str()).unwrap_or(""));
            if rel.is_empty() {
                continue;
            }
            let p = root.join(rel);
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&p, data);
        }
    }
}

// ================================================================ payload / 图片

fn build_payload(sc: &Value) -> CreatePayload {
    let p = sc.get("payload").cloned().unwrap_or(Value::Null);
    let lang = p.get("lang").cloned().and_then(|l| serde_json::from_value::<Lang>(l).ok());
    CreatePayload {
        comic_name: p.get("comicName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        normalized_name: p.get("normalizedName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        lang,
        translator: p.get("translator").and_then(|x| x.as_str()).map(|s| s.to_string()),
        client_task_ref: p.get("clientTaskRef").and_then(|x| x.as_str()).map(|s| s.to_string()),
        idempotency_key: p.get("idempotencyKey").and_then(|x| x.as_str()).map(|s| s.to_string()),
    }
}

fn build_images(sc: &Value) -> Vec<InputImage> {
    sc.get("images")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .map(|i| InputImage {
                    data: unb64(i.get("b64").and_then(|x| x.as_str()).unwrap_or("")),
                    filename: i.get("filename").and_then(|x| x.as_str()).map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ================================================================ 种子任务（取消 / 重试 / 删除）

fn seed_into(store: &mut Store, sc: &Value, root: &Path) {
    let mut ids: Vec<String> = Vec::new();
    if let Some(arr) = sc.get("seeds").and_then(|x| x.as_array()) {
        for s in arr {
            let mut task: Task = serde_json::from_value(s.clone()).expect("种子任务应可解析");
            // `outputDir` 由各自 root 现算 —— 绝对路径不写进夹具（两边 root 不同）。
            task.output_dir = root.join(&task.dir_name).to_string_lossy().into_owned();
            ids.push(task.task_id.clone());
            store.tasks.push(task);
        }
    }
    // 队列里放谁：`queueIds` 指明了（顺序即位次）。
    if let Some(q) = sc.get("queueIds").and_then(|x| x.as_array()) {
        for id in q {
            if let Some(s) = id.as_str() {
                store.queue.push(s.to_string());
            }
        }
    }
    // `currentTaskId`：置 running 的当前任务（删除场景用不到，取消/重试用不到 —— 留口子给将来）。
    if let Some(cur) = sc.get("currentTaskId").and_then(|x| x.as_str()) {
        store.current_task_id = Some(cur.to_string());
    }
    // 幂等表种子（可选）
    if let Some(arr) = sc.get("idempotency").and_then(|x| x.as_array()) {
        for e in arr {
            let key = e.get("key").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let task_id = e.get("taskId").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let batch_index = e.get("batchIndex").and_then(|x| x.as_i64()).unwrap_or(1);
            store.idempotency.push(super::IdemEntry { key, task_id, batch_index, at: super::model::now_ms() });
        }
    }
    let _ = ids;
}

// ================================================================ 场景定义（唯一事实源）

/// 一条 item 的 JSON（与 `Task` / Node 的任务对象逐字段对齐）。
#[allow(clippy::too_many_arguments)]
fn item_json(
    seq: i64,
    ext: &str,
    byte_size: i64,
    status: &str,
    saved: bool,
    from_disk: bool,
    original_file: Option<&str>,
    output_file: Option<&str>,
    reason: Option<&str>,
) -> Value {
    let mime = if ext == "jpg" { "image/jpeg" } else { "image/png" };
    json!({
        "seq": seq, "ext": ext, "mime": mime, "byteSize": byte_size,
        "fromDisk": from_disk, "overwrite": false,
        "status": status, "saved": saved,
        "originalFile": original_file, "outputFile": output_file,
        "sha256": null, "durationMs": null, "retryCount": 0,
        "reason": reason, "errorMessage": null
    })
}

fn seed_task(id: &str, comic: &str, dir: &str, status: &str, queue_pos: i64, items: Vec<Value>) -> Value {
    let count = items.len() as i64;
    let seqs: Vec<i64> = items.iter().filter_map(|i| i.get("seq").and_then(|x| x.as_i64())).collect();
    let seq_from = seqs.iter().min().copied().unwrap_or(1);
    let seq_to = seqs.iter().max().copied().unwrap_or(seq_from);
    json!({
        "taskId": id,
        "comicName": comic,
        "normalizedComicName": dir,
        "dirName": dir,
        "outputDir": "",
        "status": status,
        "queuePosition": queue_pos,
        "lang": { "from": "ja", "to": "zh" },
        "translator": "sakura",
        "clientTaskRef": null,
        "source": "unknown",
        "idempotencyKey": null,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "finishedAt": null,
        "batches": [{
            "batchIndex": 1, "count": count, "seqFrom": seq_from, "seqTo": seq_to,
            "status": "queued", "idempotencyKey": null, "items": items
        }],
        "events": [], "cancelRequested": false
    })
}

/// 全部场景（**唯一事实源**）。`report()` 会把这套输入连同 Rust 侧产物一起吐出来。
pub fn scenarios() -> Vec<Value> {
    let base_env = json!({ "skipExisting": true, "itemTimeoutMs": 150, "engineTimeoutMs": 600 });

    // S1 顺跑：无失败注入 ⇒ done。3 张，覆盖"整批成功"。
    let s1 = json!({
        "name": "happy", "kind": "create", "comic": "01_顺跑",
        "env": { "skipExisting": true, "itemTimeoutMs": 150, "engineTimeoutMs": 600, "failSeqs": [] },
        "payload": { "comicName": "01_顺跑", "normalizedName": "01_顺跑", "lang": { "from": "ja", "to": "zh" }, "translator": "sakura" },
        "images": [image_json("a.png", "orig-1"), image_json("b.png", "orig-2"), image_json("c.png", "orig-3")],
        "imageOrder": [], "source": "unknown", "drain": true,
        "translate": {
            "1": { "mode": "ok", "b64": b64(&png("t-1")) },
            "2": { "mode": "ok", "b64": b64(&png("t-2")) },
            "3": { "mode": "ok", "b64": b64(&png("t-3")) }
        }
    });

    // S2 部分失败：seq2 注入失败 ⇒ partial_failed；seq2 的原图按 G-11 落盘。
    let s2 = json!({
        "name": "partial-failed", "kind": "create", "comic": "02_部分失败",
        "env": { "skipExisting": true, "itemTimeoutMs": 150, "engineTimeoutMs": 600, "failSeqs": [2] },
        "payload": { "comicName": "02_部分失败", "normalizedName": "02_部分失败", "lang": { "from": "ja", "to": "zh" }, "translator": "sakura" },
        "images": [image_json("a.png", "orig-1"), image_json("b.png", "orig-2"), image_json("c.png", "orig-3")],
        "imageOrder": [], "source": "unknown", "drain": true,
        "translate": {
            "1": { "mode": "ok", "b64": b64(&png("t-1")) },
            "3": { "mode": "ok", "b64": b64(&png("t-3")) }
        }
    });

    // S3 幂等续做短路：001_translated.png 已存在 ⇒ seq1 skipped(already_exists)，不送引擎。
    let s3 = json!({
        "name": "skip-existing", "kind": "create", "comic": "03_已有译文",
        "env": { "skipExisting": true, "itemTimeoutMs": 150, "engineTimeoutMs": 600, "failSeqs": [] },
        "payload": { "comicName": "03_已有译文", "normalizedName": "03_已有译文", "lang": { "from": "ja", "to": "zh" }, "translator": "sakura" },
        "images": [image_json("a.png", "orig-1"), image_json("b.png", "orig-2")],
        "imageOrder": [], "source": "unknown", "drain": true,
        "preFiles": [ { "rel": "03_已有译文/001_translated.png", "b64": b64(&png("pre-translated")) } ],
        "translate": { "2": { "mode": "ok", "b64": b64(&png("t-2")) } }
    });

    // S4 取消排队中的任务：不跑引擎、无文件、无目录；未处理页一律 skipped(canceled)。
    let s4 = json!({
        "name": "cancel-queued", "kind": "seed", "comic": "04_取消",
        "env": base_env,
        "seeds": [ seed_task("tsk_0123456789ABCDEFGHJKMNPQRS", "04_取消", "04_取消", "queued", 1, vec![
            item_json(1, "png", 11, "pending", false, false, None, None, None),
            item_json(2, "png", 12, "pending", false, false, None, None, None)
        ]) ],
        "queueIds": ["tsk_0123456789ABCDEFGHJKMNPQRS"],
        "op": "cancel", "opArg": "tsk_0123456789ABCDEFGHJKMNPQRS", "drain": false
    });

    // S5 重试：把失败页复位后**真的重跑**（failSeqs 已清空）⇒ 最终 done。
    let s5 = json!({
        "name": "retry-then-run", "kind": "seed", "comic": "05_重试",
        "env": { "skipExisting": true, "itemTimeoutMs": 150, "engineTimeoutMs": 600, "failSeqs": [] },
        "seeds": [ seed_task("tsk_0123456789ABCDEFGHJKMNPQRT", "05_重试", "05_重试", "partial_failed", 0, vec![
            item_json(1, "png", 11, "success", true, false, Some("001.png"), Some("001_translated.png"), None),
            item_json(2, "png", 12, "failed", false, false, Some("002.png"), None, Some("engine_error"))
        ]) ],
        "preFiles": [
            { "rel": "05_重试/001.png", "b64": b64(&png("orig-1")) },
            { "rel": "05_重试/001_translated.png", "b64": b64(&png("t-1")) },
            { "rel": "05_重试/002.png", "b64": b64(&png("orig-2")) }
        ],
        "op": "retry", "opArg": "tsk_0123456789ABCDEFGHJKMNPQRT", "drain": true,
        "translate": { "2": { "mode": "ok", "b64": b64(&png("t-2")) } }
    });

    // S6 单项总预算耗尽：引擎挂住 ⇒ 第 2 次尝试开始前预算已尽 ⇒ failed(engine_engine_timeout)。
    let s6 = json!({
        "name": "budget-exhausted", "kind": "create", "comic": "06_预算耗死",
        "env": { "skipExisting": true, "itemTimeoutMs": 150, "engineTimeoutMs": 600, "failSeqs": [] },
        "payload": { "comicName": "06_预算耗死", "normalizedName": "06_预算耗死", "lang": { "from": "ja", "to": "zh" }, "translator": "sakura" },
        "images": [image_json("a.png", "orig-1")],
        "imageOrder": [], "source": "unknown", "drain": true,
        "translate": { "1": { "mode": "hang", "code": "ENGINE_TIMEOUT", "message": "引擎响应超时（150ms 内没等到结帧；期间收到 0 字节）", "sleepMs": 400 } }
    });

    // S7 删除：逐条回报，不整批抛错；运行中不可删、不存在记 not_found。
    let s7 = json!({
        "name": "delete-mixed", "kind": "seed",
        "env": base_env,
        "seeds": [
            seed_task("tsk_0123456789ABCDEFGHJKMNPQRV", "07_删掉", "07_删掉", "done", 0, vec![
                item_json(1, "png", 11, "success", true, false, Some("001.png"), Some("001_translated.png"), None)
            ]),
            seed_task("tsk_0123456789ABCDEFGHJKMNPQRW", "07_在跑", "07_在跑", "running", 0, vec![
                item_json(1, "png", 11, "pending", false, false, None, None, None)
            ])
        ],
        "op": "delete",
        "deleteIds": ["tsk_0123456789ABCDEFGHJKMNPQRS", "tsk_0123456789ABCDEFGHJKMNPQRV", "tsk_0123456789ABCDEFGHJKMNPQRW"],
        "drain": false
    });

    vec![s1, s2, s3, s4, s5, s6, s7]
}

// ================================================================ 单个场景

fn run_scenario(sc: &Value) -> Value {
    let root = paths::manga_root_dir();
    create_pre_files(&root, sc);

    let mut store = Store::new(&root);
    store.env = env_from(sc.get("env").unwrap_or(&Value::Null));
    let tr = build_translator(sc);

    let kind = sc.get("kind").and_then(|x| x.as_str()).unwrap_or("create");
    let mut outcome = Value::Null;
    let mut result = Value::Null;
    let mut err = Value::Null;
    let mut tid = String::new();

    if kind == "create" {
        let payload = build_payload(sc);
        let images = build_images(sc);
        let order: Vec<Value> =
            sc.get("imageOrder").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let source = sc.get("source").and_then(|x| x.as_str()).map(|s| s.to_string());
        match store.create_task(&payload, &images, &order, source) {
            Ok(oc) => {
                tid = oc.task_id.clone();
                outcome = json!({ "taskId": oc.task_id, "replay": oc.replay });
                if sc.get("drain").and_then(|x| x.as_bool()).unwrap_or(true) {
                    store.drain(&tr);
                }
            }
            Err(e) => err = json!({ "code": e.code }),
        }
    } else {
        seed_into(&mut store, sc, &root);
        let op = sc.get("op").and_then(|x| x.as_str()).unwrap_or("");
        let arg = sc.get("opArg").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if !arg.is_empty() {
            tid = arg.clone();
        }
        match op {
            "cancel" => match store.cancel_task(&arg) {
                Ok(r) => result = serde_json::to_value(r).unwrap_or(Value::Null),
                Err(e) => err = json!({ "code": e.code }),
            },
            "retry" => match store.retry_task(&arg) {
                Ok(r) => {
                    result = serde_json::to_value(r).unwrap_or(Value::Null);
                    if sc.get("drain").and_then(|x| x.as_bool()).unwrap_or(false) {
                        store.drain(&tr);
                    }
                }
                Err(e) => err = json!({ "code": e.code }),
            },
            "delete" => {
                let ids: Vec<String> = sc
                    .get("deleteIds")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let r = store.delete_tasks(&ids);
                result = serde_json::to_value(r).unwrap_or(Value::Null);
            }
            _ => {}
        }
    }

    let task_val = store.get_task(&tid).map(|t| store.serialize(t)).unwrap_or(Value::Null);
    let events = store
        .get_task(&tid)
        .map(|t| serde_json::to_value(&t.events).unwrap_or(Value::Null))
        .unwrap_or_else(|| json!([]));

    // 漫画目录清单（排序；无用例目录 ⇒ `null`，不拿"根目录下所有东西"充数）
    let comic = sc.get("comic").and_then(|x| x.as_str()).unwrap_or("");
    let disk = if comic.is_empty() {
        Value::Null
    } else {
        let dir = root.join(comic);
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        names.sort();
        Value::Array(names.into_iter().map(Value::String).collect())
    };

    // 失败页的 `errorMessage`（**运行期字段，不落盘** —— 但它才是「总预算耗尽」与
    // 「单次请求超时」唯一能分开的证据：两者 `reason` 都是 `engine_engine_timeout`）。
    let mut item_errors = serde_json::Map::new();
    if let Some(t) = store.get_task(&tid) {
        for b in &t.batches {
            for it in &b.items {
                if let Some(m) = &it.error_message {
                    item_errors.insert(it.seq.to_string(), Value::String(m.clone()));
                }
            }
        }
    }

    let mut remaining: Vec<String> = store.tasks.iter().map(|t| t.task_id.clone()).collect();
    remaining.sort();

    json!({
        "outcome": outcome,
        "result": result,
        "error": err,
        "task": task_val,
        "events": events,
        "itemErrors": Value::Object(item_errors),
        "disk": disk,
        "remainingTaskIds": remaining
    })
}

// ================================================================ 报告

/// 打印整份自检报告：`{scenarios:[{...输入..., report:{...}}]}`。
pub fn report() -> Value {
    let defs = scenarios();
    let scenarios: Vec<Value> = defs
        .iter()
        .map(|sc| {
            let rep = run_scenario(sc);
            let mut obj = sc.clone();
            if let Some(m) = obj.as_object_mut() {
                m.insert("report".to_string(), rep);
            }
            obj
        })
        .collect();
    json!({ "scenarios": scenarios })
}
