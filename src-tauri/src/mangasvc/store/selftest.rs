// store 自检报告（F3-a）—— 给 e2e 一个**稳定输入**下逐条比对 Rust 与 Node 的接缝
//
// `mangasvc --store-selftest` 打印本模块的 `report()`。它把「纯函数 / serialize / 视图 / 计划 /
// 原子写」在**固定输入**下的产物一次性吐出来，`e2e/service/store-parity-check.mjs` 再用真
// `store.mjs` 算同一份并比对。
//
// 🔴 **输入是唯一事实源，而且只写在这里**：报告同时给出 `pureInputs`（各用例的输入）与
//    `fixtures`（任务夹具）—— Node 侧只负责解析这些输入、跑自己的实现、交回输出。
//    这样「夹具」不会两边各写一份而悄悄走散（那正是对照类断言最容易退化成假绿的地方）。
//
// ⚠️ `updatedAt` 是不确定值，对照脚本递归剔除后再比；`persistedBytes` 是**逐字节**比对
//    （唯一对字段序敏感的产物）。
use std::io::Write;
use std::path::Path;

use serde_json::{json, Map, Value};

use super::model::{Batch, Task};
use super::{atomic_write_json, create_private, pure, tmp_path, Store};

// ------------------------------------------------------------------ 夹具（任务）

/// 固定夹具：单任务（覆盖 serialize / 三种视图 / progress）。
pub fn fixture_task(root: &Path) -> Value {
    let out_dir = root.join("夏日重现").to_string_lossy().into_owned();
    json!({
        "taskId": "tsk_0123456789ABCDEFGHJKMNPQRS",
        "comicName": "夏日重现",
        "normalizedComicName": "夏日重现",
        "dirName": "夏日重现",
        "outputDir": out_dir,
        "status": "partial_failed",
        "queuePosition": 0,
        "lang": { "from": "ja", "to": "zh" },
        "translator": "sakura",
        "clientTaskRef": null,
        "source": "unknown",
        "idempotencyKey": null,
        "createdAt": "2026-10-13T04:35:29.000Z",
        "finishedAt": "2026-10-13T04:36:10.500Z",
        "batches": [{
            "batchIndex": 1, "count": 3, "seqFrom": 1, "seqTo": 3, "status": "partial_failed",
            "idempotencyKey": null,
            "items": [
                item_json(1, "png", 123, "success", true, Some("001.png"), Some("001_translated.png"), Some("aa"), Some(1000), 0, None),
                item_json(2, "jpg", 456, "failed", false, Some("002.jpg"), None, None, Some(2000), 1, Some("engine_error")),
                item_json(3, "webp", 789, "skipped", true, Some("003.webp"), Some("003_translated.png"), None, None, 0, Some("already_exists"))
            ]
        }],
        "events": [], "clients": [], "cancelRequested": false
    })
}

/// 固定夹具：多批次任务，覆盖 `batchStatusOf` 的**全部分支**。
pub fn fixture_batches_task(root: &Path) -> Value {
    let out_dir = root.join("批次覆盖").to_string_lossy().into_owned();
    let b = |idx: i64, from: i64, to: i64, items: Value| {
        json!({
            "batchIndex": idx, "count": to - from + 1, "seqFrom": from, "seqTo": to,
            "status": "queued", "idempotencyKey": null, "items": items
        })
    };
    json!({
        "taskId": "tsk_0123456789ABCDEFGHJKMNPQRT",
        "comicName": "批次覆盖", "normalizedComicName": "批次覆盖", "dirName": "批次覆盖",
        "outputDir": out_dir, "status": "canceled", "queuePosition": 0,
        "lang": { "from": "ja", "to": "zh" }, "translator": "sakura",
        "clientTaskRef": null, "source": "unknown", "idempotencyKey": null,
        "createdAt": "2026-10-13T04:35:29.000Z", "finishedAt": null,
        "batches": [
            b(1, 1, 1, json!([item_json(1, "png", 1, "skipped", false, None, None, None, None, 0, Some("canceled"))])),
            b(2, 2, 3, json!([
                item_json(2, "png", 1, "pending", false, None, None, None, None, 0, None),
                item_json(3, "png", 1, "pending", false, None, None, None, None, 0, None)
            ])),
            b(3, 4, 5, json!([
                item_json(4, "png", 1, "success", true, None, None, None, None, 0, None),
                item_json(5, "png", 1, "translating", false, None, None, None, None, 0, None)
            ])),
            b(4, 6, 7, json!([
                item_json(6, "png", 1, "success", true, None, None, None, None, 0, None),
                item_json(7, "png", 1, "failed", false, None, None, None, None, 0, None)
            ])),
            b(5, 8, 9, json!([
                item_json(8, "png", 1, "failed", false, None, None, None, None, 0, None),
                item_json(9, "png", 1, "failed", false, None, None, None, None, 0, None)
            ])),
            b(6, 10, 11, json!([
                item_json(10, "png", 1, "success", true, None, None, None, None, 0, None),
                item_json(11, "png", 1, "skipped", true, None, None, None, None, 0, Some("already_exists"))
            ]))
        ],
        "events": [], "clients": [], "cancelRequested": false
    })
}

/// 固定夹具：任务列表（覆盖 running / queued(在队/不在队) / 终态倒序 / finishedAt 缺失）。
pub fn fixture_tasks(root: &Path) -> Value {
    let mk = |id: &str, name: &str, status: &str, created: &str, finished: Value, items: Value| {
        json!({
            "taskId": id, "comicName": name, "normalizedComicName": name, "dirName": name,
            "outputDir": root.join(name).to_string_lossy().into_owned(),
            "status": status, "queuePosition": 0,
            "lang": { "from": "ja", "to": "zh" }, "translator": "sakura",
            "clientTaskRef": null, "source": "unknown", "idempotencyKey": null,
            "createdAt": created, "finishedAt": finished,
            "batches": [{ "batchIndex": 1, "count": 2, "seqFrom": 1, "seqTo": 2, "status": "queued",
                "idempotencyKey": null, "items": items }],
            "events": [], "clients": [], "cancelRequested": false
        })
    };
    let ok = |seq: i64| item_json(seq, "png", 1, "success", true, None, None, None, None, 0, None);
    let pend = |seq: i64| item_json(seq, "png", 1, "pending", false, None, None, None, None, 0, None);
    json!([
        mk("tsk_00000000000000000000000001", "运行中", "running", "2026-10-13T04:35:29.000Z", Value::Null, json!([ok(1), pend(2)])),
        mk("tsk_00000000000000000000000002", "排队甲", "queued", "2026-10-13T04:36:00.000Z", Value::Null, json!([pend(1), pend(2)])),
        mk("tsk_00000000000000000000000003", "排队乙", "queued", "2026-10-13T04:37:00.000Z", Value::Null, json!([pend(1), pend(2)])),
        mk("tsk_00000000000000000000000004", "完成", "done", "2026-10-13T04:38:00.000Z", json!("2026-10-13T04:40:00.000Z"), json!([ok(1), ok(2)])),
        mk("tsk_00000000000000000000000005", "失败", "failed", "2026-10-13T04:39:00.000Z", json!("2026-10-13T04:50:00.000Z"), json!([ok(1), pend(2)])),
        mk("tsk_00000000000000000000000006", "缺完成时间", "done", "2026-10-13T04:45:00.000Z", Value::Null, json!([ok(1), ok(2)]))
    ])
}

fn item_json(
    seq: i64,
    ext: &str,
    byte_size: i64,
    status: &str,
    saved: bool,
    original: Option<&str>,
    output: Option<&str>,
    sha: Option<&str>,
    duration: Option<i64>,
    retry: i64,
    reason: Option<&str>,
) -> Value {
    let mime = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    json!({
        "seq": seq, "ext": ext, "mime": mime,
        "byteSize": byte_size, "fromDisk": false, "overwrite": false,
        "status": status, "saved": saved,
        "originalFile": original, "outputFile": output, "sha256": sha,
        "durationMs": duration, "retryCount": retry, "reason": reason,
        "errorMessage": null
    })
}

// ------------------------------------------------------------------ 原子写中断模拟（可反证）

/// 模拟「写到一半进程崩」：
///  · 原子模式 ⇒ 只写 tmp、**不 rename** ⇒ 目标文件保持原样；
///  · 反证模式（`MIAO_ATOMIC_DIRECT_WRITE=1`，`atomic_write_text` 也走同一条退化路径）
///    ⇒ 半截内容**直接落在目标文件上** ⇒ 目标被污染。
fn simulate_interrupt(file: &Path, partial: &str) -> std::io::Result<()> {
    if super::atomic_is_direct() {
        return super::direct_write(file, partial, 0o600);
    }
    let tmp = tmp_path(file);
    let mut f = create_private(&tmp, 0o600)?;
    f.write_all(partial.as_bytes())?;
    f.sync_all()?;
    Ok(())
}

fn atomic_probe(dir: &Path) -> (bool, bool) {
    // ① 正常路径：两次覆写后无 `.tmp-` 残留
    let ok_dir = dir.join("ok");
    let _ = std::fs::create_dir_all(&ok_dir);
    let ok_target = ok_dir.join("probe.json");
    let _ = atomic_write_json(&ok_target, &json!({ "v": 1 }));
    let _ = atomic_write_json(&ok_target, &json!({ "v": 2 }));
    let no_tmp_residue = std::fs::read_dir(&ok_dir)
        .map(|rd| {
            !rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .any(|n| n.contains(".tmp-"))
        })
        .unwrap_or(false);

    // ② 中断路径：写 old → 模拟中断 → 目标必须未被污染
    let crash_dir = dir.join("crash");
    let _ = std::fs::create_dir_all(&crash_dir);
    let target = crash_dir.join("probe.json");
    let _ = atomic_write_json(&target, &json!({ "v": "old" }));
    let before = std::fs::read_to_string(&target).unwrap_or_default();
    let _ = simulate_interrupt(&target, "{\n  \"v\": \"half");
    let after = std::fs::read_to_string(&target).unwrap_or_default();
    let target_intact = !before.is_empty() && before == after;

    (target_intact, no_tmp_residue)
}

// ------------------------------------------------------------------ 报告

/// 打印整份自检报告。
pub fn report() -> Value {
    let root = crate::platform::paths::manga_root_dir();
    let store = Store::new(&root);

    // ============ 纯函数：输入 + 输出（同一张表产出两侧，杜绝走散）============

    // orderImages
    let files: Vec<Value> = vec![json!("a.png"), json!("b.png"), json!("c.png")];
    let names: Vec<Option<String>> = vec![Some("a.png".into()), Some("b.png".into()), Some("c.png".into())];
    let mut oi_in = Map::new();
    let mut order_images = Map::new();
    for (id, order) in [
        ("byName", json!(["c.png", "a.png"])),
        ("byIndex", json!([2, 2])),
        ("empty", json!([])),
        ("unknownKey", json!(["zzz"])),
        ("trim", json!([" a.png "])),
        ("exprIndex", json!(["2", "1"])),
    ] {
        let arr: Vec<Value> = pure::order_images_indices(&names, order.as_array().unwrap())
            .into_iter()
            .map(|i| json!(i))
            .collect();
        oi_in.insert(id.into(), json!({ "files": files.clone(), "order": order }));
        order_images.insert(id.into(), Value::Array(arr));
    }

    // endStatusOf
    let mut es_in = Map::new();
    let mut end_status = Map::new();
    for (id, sts) in [
        ("allOk", vec!["success", "skipped"]),
        ("someFail", vec!["success", "failed"]),
        ("allFail", vec!["failed"]),
        ("empty", vec![]),
    ] {
        es_in.insert(id.into(), json!({ "statuses": sts }));
        end_status.insert(id.into(), json!(pure::end_status_of(sts.into_iter())));
    }

    // formatEtaText
    let mut et_in = Map::new();
    let mut eta_text = Map::new();
    for (id, a, b) in [("sec", 10i64, 30i64), ("min", 60, 180), ("edge59", 1, 59), ("edge60", 60, 60)] {
        et_in.insert(id.into(), json!({ "min": a, "max": b }));
        eta_text.insert(id.into(), json!(pure::format_eta_text(a, b)));
    }

    // sniffImageType
    let mut sn_in = Map::new();
    let mut sniff = Map::new();
    for (id, bytes) in [
        ("png", vec![137u8, 80, 78, 71, 13, 10, 26, 10]),
        ("jpg", vec![255, 216, 255, 224]),
        ("webp", vec![82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
        ("gif", vec![71, 73, 70, 56, 57, 97]),
        ("empty", vec![]),
        ("shortPng", vec![137, 80, 78]),
    ] {
        sn_in.insert(id.into(), json!({ "bytes": bytes }));
        sniff.insert(id.into(), json!(pure::sniff_image_type(&bytes)));
    }

    // isSafeDirName
    let mut sd_in = Map::new();
    let mut safe = Map::new();
    for (id, name) in [
        ("cjk", "夏日重现"),
        ("dotInMiddle", "a..b"),
        ("slash", "a/b"),
        ("dotdot", ".."),
        ("empty", ""),
        ("backslash", "a\\b"),
    ] {
        sd_in.insert(id.into(), json!({ "name": name }));
        safe.insert(id.into(), json!(pure::is_safe_dir_name(name)));
    }

    // 目录扫描
    let scan_names = ["001.png", "042.jpg", "003_translated.png", "cover.jpg", "1000.png", "001_translated.webp"];
    let mut scan = Map::new();
    for name in scan_names {
        scan.insert(
            name.into(),
            json!({ "original": pure::match_original(name), "translated": pure::match_translated(name) }),
        );
    }

    let pure_inputs = json!({
        "orderImages": Value::Object(oi_in),
        "endStatusOf": Value::Object(es_in),
        "formatEtaText": Value::Object(et_in),
        "sniffImageType": Value::Object(sn_in),
        "isSafeDirName": Value::Object(sd_in),
        "fileScan": { "names": scan_names }
    });
    let pure_out = json!({
        "orderImages": Value::Object(order_images),
        "endStatusOf": Value::Object(end_status),
        "formatEtaText": Value::Object(eta_text),
        "sniffImageType": Value::Object(sniff),
        "isSafeDirName": Value::Object(safe),
        "fileScan": Value::Object(scan)
    });

    // ============ 夹具任务 → serialize / 视图 / 批次状态 ============
    let task: Task = serde_json::from_value(fixture_task(&root)).expect("夹具任务应可解析");
    let batches_task: Task = serde_json::from_value(fixture_batches_task(&root)).expect("批次夹具应可解析");

    let batch_statuses: Vec<Value> = batches_task
        .batches
        .iter()
        .map(|b: &Batch| json!(pure::batch_status_of(&batches_task.status, &b.items)))
        .collect();

    let tasks_val = fixture_tasks(&root);
    let mut list_store = Store::new(&root);
    list_store.tasks = tasks_val
        .as_array()
        .unwrap()
        .iter()
        .map(|v| serde_json::from_value::<Task>(v.clone()).expect("列表夹具应可解析"))
        .collect();
    list_store.queue = vec!["tsk_00000000000000000000000002".into()];
    list_store.current_task_id = Some("tsk_00000000000000000000000001".into());

    // 计划（依赖磁盘上的夹具目录；由对照脚本预置）
    let resume = store.resume_plan("测试漫画").map(|p| json!(p)).unwrap_or(Value::Null);
    let retranslate = store.retranslate_plan("测试漫画").map(|p| json!(p)).unwrap_or(Value::Null);
    let next_seq = store.next_seq_for("测试漫画");

    // 隐藏清单（ASCII 名，规避 locale collation 偏离）
    let hidden = {
        let mut s2 = Store::new(&root);
        s2.hide_comic("B Comic");
        s2.hide_comic("A Comic");
        s2.hide_comic("A Comic"); // 幂等
        s2.hidden_comics_view()
    };

    // 持久化字节（逐字节）+ 原子写探针
    let persist_dir = crate::platform::paths::manga_state_dir().join("selftest");
    let _ = std::fs::create_dir_all(&persist_dir);
    let persist_file = persist_dir.join("probe-persist");
    let persisted_bytes = {
        let rec = store.record_of(&task);
        let _ = atomic_write_json(&persist_file, &rec);
        std::fs::read_to_string(&persist_file).unwrap_or_default()
    };
    let (atomic_intact, atomic_no_residue) = atomic_probe(&persist_dir.join("atomic"));

    json!({
        "pureInputs": pure_inputs,
        "pure": pure_out,
        "fixtures": {
            "task": fixture_task(&root),
            "batchesTask": fixture_batches_task(&root),
            "tasks": tasks_val,
            "queueIds": ["tsk_00000000000000000000000002"],
            "currentTaskId": "tsk_00000000000000000000000001",
            "planComicDir": "测试漫画",
            "hiddenSeeds": ["B Comic", "A Comic", "A Comic"]
        },
        "ulidOk": ulid_shape_ok(),
        "serializedTask": store.serialize(&task),
        "views": {
            "progress": json!(store.progress_of(&task)),
            "create": json!(store.create_view(&task)),
            "detail": json!(store.detail_view(&task, None, None)),
            "detailFiltered": json!(store.detail_view(&task, Some(2), Some(3))),
            "list": json!(store.list_view(&task)),
            "batchStatuses": Value::Array(batch_statuses),
            "taskList": json!(list_store.task_list_view(None, None)),
            "taskListFiltered": json!(list_store.task_list_view(Some("done,failed"), Some(2))),
            "queue": json!(list_store.queue_snapshot())
        },
        "plans": { "resume": resume, "retranslate": retranslate, "nextSeq": next_seq },
        "hidden": hidden,
        "persistedBytes": persisted_bytes,
        "atomic": { "targetIntactAfterAbort": atomic_intact, "noTmpResidue": atomic_no_residue }
    })
}

fn ulid_shape_ok() -> bool {
    let id = super::model::ulid();
    id.len() == 26 && id.bytes().all(|b| super::model::CROCKFORD.contains(&b))
}
