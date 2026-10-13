// 运行时就绪检测（B2）—— 「缺什么说得清，且说得具体」
// =============================================================================
// 回答一个问题：**引擎现在缺哪几样**。逐项独立报真伪，`detail` 必带绝对路径，`fix` 给装法。
//
// ## 为什么是四项，不是台账原写的五项
// 台账 B2 原文含 `node`（标注"过渡期"）。F5 完成 + A3d 落地后 node **已不是产品依赖**
// （产品运行期 node 启动点为零，`bundle.resources` 无 node），此时检测 node 只有一个作用：
// 让用户以为自己还得装一个用不上的运行时 ⇒ **误导**。故本实现只保留真正决定引擎能否
// 起来的四项，并在台账 D 条目里记下这条裁剪及理由。
//
// ## 判据必须与装机脚本同源
// `engine/scripts/setup-engine.mjs` 是用户唯一的口径：
//   · `sourceReady()` = `src/server/main.py` 存在（**不能**用"src/ 非空"——
//     `fetch-models.mjs --link` 会先往 `src/models/` 建链接，于是 src/ 非空但根本没源码）；
//   · venv 就位 = **解释器文件存在**，不是"venv/ 目录存在"（目录非空但缺 Scripts/bin 是残的）。
// 检测若另写一套判据 ⇒ 「检测说没装、启动却起了」或反过来，正是 R1 要消灭的那类故障。
//
// ## 只读，不代装
// 本模块只 `stat` / `read_dir`，**不起子进程、不 import torch**。理由：
//   ① 诊断视图可以被反复打开，每次 `import torch` 是秒级操作；
//   ② 起解释器有副作用（写 `__pycache__`、可能触发首次编译），检测不该改动机器状态。
// 判据的代价是"目录在 ≠ 版本对"—— 由 `fix` 引导用户跑装机命令自查，而不是我们替他跑。
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::paths;

/// 一项检测的结果。
///
/// `path` 是**判据真正作用的那一个绝对路径**（验收要求：任一 `detail` 缺绝对路径即算缺陷）；
/// `ok` 为真时 `fix` 为 `None` —— 「已经好了还给人装法」是噪声。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeItem {
    pub id: &'static str,
    pub ok: bool,
    pub path: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

/// 检测报告。`ready` = 四项全真（引擎具备启动的最低条件）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbe {
    pub items: Vec<RuntimeItem>,
    pub ready: bool,
}

/// venv 目录（`<runtimeRoot>/manga-translator/venv`）。
pub fn venv_dir() -> PathBuf {
    paths::runtimes_dir().join("venv")
}

/// venv 里的 `site-packages`。
///
/// 🔴 POSIX 上是 `lib/python3.X/site-packages` —— 版本号随解释器变，**写死 3.11 会让
///    换解释器后依赖检测永远报缺失**（而引擎其实装得好好的）。故扫一层 `lib/python*`，
///    多个版本并存时取字典序最小者（确定性：同样输入必须给同样输出）。
fn site_packages(venv: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let p = venv.join("Lib").join("site-packages");
        return p.is_dir().then_some(p);
    }
    let lib = venv.join("lib");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&lib)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs.into_iter().map(|d| d.join("site-packages")).find(|p| p.is_dir())
}

fn is_file(p: &Path) -> bool {
    // 🔴 用 `symlink_metadata`（lstat）而不是 `is_file()`：符号链接指向文件时也算在位 ——
    //    硬链接/软链接是本产品建模型链的常规手段（D-99），判据不能把它误判成"没装"。
    std::fs::symlink_metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

fn is_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// 装机命令的 `fix` 文案。与 `engine/scripts/setup-engine.mjs` 的用法说明一致。
const FIX_SETUP: &str = "运行 node engine/scripts/setup-engine.mjs 装配引擎运行时（Python + venv + 源码）";
const FIX_VENV: &str = "运行 node engine/scripts/setup-engine.mjs --venv 创建 venv（需 Python 已就位）";
const FIX_DEPS: &str = "运行 npm run deps:engine 安装引擎依赖（pip -r requirements.txt）";

/// 跑一遍四项检测。
pub fn probe() -> RuntimeProbe {
    let mut items = Vec::with_capacity(4);

    // ---- ① venvRoot：运行时根本身在不在 ----
    let rt = paths::runtimes_dir();
    items.push(RuntimeItem {
        id: "venvRoot",
        ok: is_dir(&rt),
        path: s(&rt),
        detail: if is_dir(&rt) {
            format!("运行时根已就位：{}", rt.display())
        } else {
            format!("运行时根不存在：{}", rt.display())
        },
        fix: (!is_dir(&rt)).then(|| FIX_SETUP.to_string()),
    });

    // ---- ② python：venv 解释器文件（装机脚本的 venv 就位判据）----
    let py = paths::engine_python();
    let py_ok = is_file(&py);
    items.push(RuntimeItem {
        id: "python",
        ok: py_ok,
        path: s(&py),
        detail: if py_ok {
            format!("解释器在位：{}", py.display())
        } else {
            format!("解释器不在位：{}", py.display())
        },
        fix: (!py_ok).then(|| FIX_VENV.to_string()),
    });

    // ---- ③ source：引擎源码标志文件（`src/server/main.py`）----
    let main_py = paths::engine_dir().join("server").join("main.py");
    let src_ok = is_file(&main_py);
    items.push(RuntimeItem {
        id: "source",
        ok: src_ok,
        path: s(&main_py),
        detail: if src_ok {
            format!("引擎源码标志文件在位：{}", main_py.display())
        } else {
            format!("引擎源码标志文件缺失：{}（src/ 非空不算数 —— --link 会先建 models 链接）", main_py.display())
        },
        fix: (!src_ok).then(|| FIX_SETUP.to_string()),
    });

    // ---- ④ deps：torch（venv site-packages）+ manga_translator（源码树）----
    let venv = venv_dir();
    let sp = site_packages(&venv);
    let torch = sp.as_ref().map(|d| d.join("torch"));
    let pkg = paths::engine_dir().join("manga_translator");
    let sp_ok = sp.as_ref().map(|d| is_dir(d)).unwrap_or(false);
    let torch_ok = torch.as_ref().map(|p| is_dir(p)).unwrap_or(false);
    let pkg_ok = is_dir(&pkg);
    let deps_ok = sp_ok && torch_ok && pkg_ok;
    let deps_path = sp.clone().unwrap_or_else(|| venv.join("Lib").join("site-packages"));
    let mut missing = Vec::new();
    if !sp_ok {
        missing.push("site-packages".to_string());
    }
    if !torch_ok {
        missing.push(format!("torch（{}）", torch.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "路径未定".to_string())));
    }
    if !pkg_ok {
        missing.push(format!("manga_translator（{}）", pkg.display()));
    }
    items.push(RuntimeItem {
        id: "deps",
        ok: deps_ok,
        path: s(&deps_path),
        detail: if deps_ok {
            format!("依赖齐备：torch={} · manga_translator={}", torch.as_ref().unwrap().display(), pkg.display())
        } else {
            format!("依赖缺失：{}；site-packages={}", missing.join(" · "), deps_path.display())
        },
        fix: (!deps_ok).then(|| FIX_DEPS.to_string()),
    });

    let ready = items.iter().all(|i| i.ok);
    RuntimeProbe { items, ready }
}

/// `/engine/runtime` 的响应体（camelCase 契约）。
pub fn runtime_view() -> serde_json::Value {
    serde_json::to_value(probe()).unwrap_or_else(|_| serde_json::json!({ "items": [], "ready": false }))
}

/// real 档启动时把「引擎运行时未就绪」**逐项**喊出来（B1 验收②）。
///
/// 没有它，用户看到的是白等 240 s 后一句 `Connection error` —— 离根因极远，且不告诉你缺什么。
/// 有了它，启动日志里就是「缺 python（<绝对路径>）—— 运行 …setup-engine.mjs --venv」。
///
/// 🔴 只 warn 不 fail：mock 档**本来就不要真引擎**（30+ 个 mock e2e 靠它活着），而
///    "装到一半"的用户也不该被一句启动失败挡住。real 档的硬门归 D6（首启引导）——
///    那里才有完整的「缺什么 → 怎么装 → 装完重启」流程。
/// 🔴 app 进程（`service.rs::start_blocking`）与 `boxsvc` CLI（`boxsvc::run_blocking`）
///    是两个入口，故本函数**两边都调**而不是各写一份 —— 判据与文案分叉等于没喊。
pub fn warn_unready_if_real(is_mock: bool) {
    if is_mock {
        return;
    }
    let probe = probe();
    if probe.ready {
        return;
    }
    for it in probe.items.iter().filter(|i| !i.ok) {
        let fix = it.fix.as_deref().map(|f| format!(" —— {f}")).unwrap_or_default();
        println!("[box-service] ⚠ 引擎运行时未就绪 · {}：{}{}", it.id, it.detail, fix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据必须打在**真实路径**上：四项各自翻转、互不影响（B2 验收②的可反证形式）。
    #[test]
    fn probe_four_items_stable_ids() {
        let p = probe();
        let ids: Vec<&str> = p.items.iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["venvRoot", "python", "source", "deps"]);
        assert_eq!(p.ready, p.items.iter().all(|i| i.ok));
    }

    /// 验收③：每一项的 `detail` 都必须带绝对路径（本机上必然含分隔符或盘符）。
    #[test]
    fn every_detail_carries_absolute_path() {
        for it in probe().items {
            assert!(it.detail.contains(&it.path), "{} 的 detail 未带路径：{}", it.id, it.detail);
            assert!(!it.path.is_empty(), "{} 的 path 为空", it.id);
            // ok=true 时不得给 fix（噪声）；ok=false 时必须给（否则用户无处可去）
            assert_eq!(it.fix.is_some(), !it.ok, "{} 的 fix 与 ok 不互补", it.id);
        }
    }

    /// site-packages 的定位不得写死 python 版本号。
    #[test]
    fn site_packages_does_not_hardcode_python_version() {
        let sp = site_packages(&venv_dir());
        if let Some(p) = sp {
            let t = p.to_string_lossy();
            assert!(!t.contains("python3."), "site-packages 路径里出现了写死的版本号：{t}");
        }
    }
}
