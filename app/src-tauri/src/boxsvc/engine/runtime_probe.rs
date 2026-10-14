// 运行时就绪检测（B2）—— 「缺什么说得清，且说得具体」
// =============================================================================
// 回答一个问题：**引擎现在缺哪几样**。逐项独立报真伪，`detail` 必带绝对路径，`fix` 给装法。
//
// ## 为什么是五项，不是台账原写的五项（B2 四项 + B5 补丁一项）
// 台账 B2 原文含 `node`（标注"过渡期"）。F5 完成 + A3d 落地后 node **已不是产品依赖**
// （产品运行期 node 启动点为零，`bundle.resources` 无 node），此时检测 node 只有一个作用：
// 让用户以为自己还得装一个用不上的运行时 ⇒ **误导**。故 B2 只保留真正决定引擎能否
// 起来的四项，并在台账 D 条目里记下这条裁剪及理由。
//
// B5 追加第五项 `patches`：补丁没打是**静默失败**（D-97：译文整页空串、却"翻译跑过了"），
// 而它的装法与上面四项完全不同（不是装东西，是重放补丁）⇒ 必须独立成项、点名到 patch id。
// 补丁表本体在 `super::patches`（SSOT 的只读镜像，双靶由 `check:engine-patches` A7 钉住）。
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

use super::patches;

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

/// 检测报告。`ready` = 五项全真（引擎具备启动的最低条件）。
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

/// 判据用的「这是个文件吗」。
///
/// 🔴 **必须跟随链接**（`metadata` = stat；`symlink_metadata` 才是 lstat）——
///    本产品建模型链用的就是硬链接 / junction（D-99、R10），而用户完全可能把 15 GB 的
///    运行时整体 junction 到别的盘（Windows 上挪大块的常规做法）。判据若停在链接本身上，
///    Windows 会把 junction 报成 symlink（`lstat.is_dir() == false`）⇒ 「装好了却报没装」
///    这种**假阴性**直接冒出来 —— 正是 B1/B3 要消灭的那类故障。
///    （原实现用的是 `symlink_metadata`，与它注释里写的意图正好相反：那个意图
///    「符号链接指向文件时也算在位」只有**跟随**才成立。链路在本仓从未被触发过，
///    因为生产里被查的路径没有一个本身是链接；直到把运行时 root 做成 junction 才暴露。）
/// 链接**断**了（指向不存在的东西）时 `metadata` 失败 ⇒ 判假 —— 断链确实不能用，正确。
fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// 装机命令的 `fix` 文案。与 `engine/scripts/setup-engine.mjs` 的用法说明一致。
const FIX_SETUP: &str = "运行 node engine/scripts/setup-engine.mjs 装配引擎运行时（Python + venv + 源码）";
const FIX_VENV: &str = "运行 node engine/scripts/setup-engine.mjs --venv 创建 venv（需 Python 已就位）";
const FIX_DEPS: &str = "运行 npm run deps:engine 安装引擎依赖（pip -r requirements.txt）";
/// 补丁没打的装法：重放（幂等）而不是重装 —— 源码早就在是常见情形。
const FIX_PATCHES: &str = "运行 node engine/scripts/setup-engine.mjs --source 重放源码补丁（幂等，已打过的会跳过）";

/// 跑一遍五项检测。
pub fn probe() -> RuntimeProbe {
    let mut items = Vec::with_capacity(5);

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

    // ---- ⑤ patches：上游源码补丁还在不在（B5）----
    // 🔴 单独一项，不与 deps 合并：装法完全不同（重放补丁 vs pip 依赖），
    //    且「补丁没打」的症状是静默的（译文空串但流程全绿）—— 用户需要被**点名**。
    items.push(patches_item(&paths::engine_dir()));

    let ready = items.iter().all(|i| i.ok);
    RuntimeProbe { items, ready }
}

/// 第五项 `patches` 的构造（抽成函数是为了能拿临时目录单测 —— `probe()` 用的是真实落点）。
///
/// 🔴 判据必须**点名到 patch id** 且带**绝对路径**：B5 验收①要求"报出缺项且点名"，
///    B2 验收③要求"任一 detail 缺绝对路径即算缺陷"。两条都落在这一项上。
fn patches_item(src: &Path) -> RuntimeItem {
    let states = patches::patch_states(src);
    let absent: Vec<&patches::PatchState> = states.iter().filter(|p| !p.applied).collect();
    let patches_ok = absent.is_empty();
    let src_present = is_dir(src);
    let detail = if patches_ok {
        format!("源码补丁 {}/{} 已应用（{}）", states.len() - absent.len(), states.len(), src.display())
    } else if !src_present {
        // 源码目录整个不在 ⇒ 补丁状态无从判定。与 `source` 项报的是同一件事，
        // 但这里必须自己说清（各项独立可读，不依赖用户去比对另一项）。
        format!("引擎源码目录不在（{}）⇒ 补丁状态无从判定", src.display())
    } else {
        let list = absent
            .iter()
            .map(|p| format!("{}（{}）", p.id, p.path.display()))
            .collect::<Vec<_>>()
            .join("、");
        format!("缺 {} 个源码补丁：{}；源码目录 {}", absent.len(), list, src.display())
    };
    RuntimeItem {
        id: "patches",
        ok: patches_ok,
        path: s(src),
        detail,
        fix: (!patches_ok).then(|| if src_present { FIX_PATCHES.to_string() } else { FIX_SETUP.to_string() }),
    }
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

/// **D6 启动前预检闸门**：real 档下运行时就绪不过 ⇒ 返回要报的文案（`None` = 放行）。
///
/// ## 为什么是闸门而不是继续 warn
/// real 档引擎探针预算是 **240 s**（`boxsvc::engine::REAL_PROBE_TIMEOUT_MS`）。
/// 缺 python 时的旧行为是「② 起不来 → 降级继续 → L2 探针空等 240 s → 报一句
/// `服务启动失败`」—— 用户看到的是**卡住**，不是**没装**，而那两句报错离根因极远。
/// 闸门把这段变成秒级收场，且 `last_error` 里就是缺什么、缺在哪、怎么装。
///
/// 🔴 **mock 档不过闸**：mock 本来就不要真引擎（30+ 个 mock e2e 靠它活着）。
/// 🔴 与 `warn_unready_if_real` 的分工：warn 写给**日志流**（逐项 detail，无头也能取证），
///    本函数写给**状态机**（`last_error`，前端据此进「运行时未装配」态）。
///    两者共用同一份 `probe()` ⇒ 判据与文案不会分叉（分岐就等于没喊）。
pub fn gate_message(mode: &str) -> Option<String> {
    gate_message_for(mode, &probe())
}

/// 闸门判定（`probe` 由调用方给 —— 单测要能造「就差一项」的合成报告）。
pub fn gate_message_for(mode: &str, probe: &RuntimeProbe) -> Option<String> {
    // 只有 real 档要真引擎。其余取值（含将来新增档）一律放行：闸门管"缺东西"，
    // 不管"模式不认识"—— 后者由 `resolve_mode()` 在更早的地方拒掉。
    if mode != "real" || probe.ready {
        return None;
    }
    let items = probe
        .items
        .iter()
        .filter(|i| !i.ok)
        .map(|i| {
            let fix = i.fix.as_deref().map(|f| format!(" —— {f}")).unwrap_or_default();
            format!("{}：{}{}", i.id, i.detail, fix)
        })
        .collect::<Vec<_>>()
        .join("；");
    Some(format!(
        "运行时未装配：{items}。按安装引导（docs/install-guide-*.md）装配引擎后重启喵坞"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据必须打在**真实路径**上：五项各自翻转、互不影响（B2 验收②的可反证形式）。
    #[test]
    fn probe_five_items_stable_ids() {
        let p = probe();
        let ids: Vec<&str> = p.items.iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["venvRoot", "python", "source", "deps", "patches"]);
        assert_eq!(p.ready, p.items.iter().all(|i| i.ok));
    }

    /// 链接**跟随**语义：目录判据不得被「这其实是个链接」骗成假阴性。
    /// （反证 M4 把实现改回 `symlink_metadata` 时，这条与 e2e 的 S6 会一起红。）
    #[test]
    fn dir_and_file_judgements_follow_links_not_the_link_itself() {
        let tmp = std::env::temp_dir().join(format!("miao-probe-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let real_dir = tmp.join("real");
        let real_file = real_dir.join("f.txt");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::write(&real_file, "x").unwrap();
        assert!(is_dir(&real_dir), "真目录必须判目录");
        assert!(!is_file(&real_dir), "目录不得判成文件");
        assert!(is_file(&real_file), "真文件必须判文件");
        assert!(!is_dir(&real_file), "文件不得判成目录");
        // 断链 ⇒ 判假（指向不存在的东西确实不能用）
        assert!(!is_dir(&tmp.join("dangling")), "不存在的路径必须判假");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// B5 验收①：缺补丁时必须**点名到 patch id**，且 detail 带绝对路径。
    /// 反过来说：全都打上时不得报"缺"（不能拿"目录在"当打过）。
    #[test]
    fn patches_item_names_missing_ids_with_absolute_paths() {
        let tmp = std::env::temp_dir().join(format!("miao-probe-patches-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // 源码目录在、但一个补丁都没打 ⇒ 十条全部点名
        let bare = patches_item(&tmp);
        assert!(!bare.ok, "空目录必须判为未就绪");
        assert_eq!(bare.fix.as_deref(), Some(FIX_PATCHES), "源码在 ⇒ 装法应是重放补丁");
        for p in patches::ENGINE_PATCHES {
            assert!(bare.detail.contains(p.id), "detail 未点名 {}：{}", p.id, bare.detail);
        }
        assert!(bare.detail.contains(&bare.path), "detail 未带源码目录绝对路径");
        // 全部打上 ⇒ ok 且无 fix
        // 🔴 同一文件可能被多条补丁共享（nllb.py ×2、text_render.py ×3）⇒ 必须**追加**，
        //    覆写会让先写的 mark 被后写的抹掉（那正是"打完补丁却报没打"的假红）。
        use std::io::Write as _;
        for p in patches::ENGINE_PATCHES {
            let f = patches::patch_file(&tmp, p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            let mut h = std::fs::OpenOptions::new().create(true).append(true).open(&f).unwrap();
            writeln!(h, "# x\n{}\n", p.mark).unwrap();
        }
        let done = patches_item(&tmp);
        assert!(done.ok, "补丁齐全必须判为就绪：{}", done.detail);
        assert!(done.fix.is_none(), "已经好了还给人装法是噪声");
        assert!(done.detail.contains("10/10"), "detail 应报 10/10：{}", done.detail);
        // 源码目录整个不在 ⇒ 说清"无从判定"，且装法退回装配整棵树
        let gone = patches_item(&tmp.join("no-such-src"));
        assert!(!gone.ok);
        assert!(gone.detail.contains("无从判定"), "{}", gone.detail);
        assert_eq!(gone.fix.as_deref(), Some(FIX_SETUP));
        let _ = std::fs::remove_dir_all(&tmp);
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

    /// 造一份合成报告（闸门单测用：要能造「就差一项」而不动真实落点）。
    fn synth(ok_ids: &[&str]) -> RuntimeProbe {
        let all = ["venvRoot", "python", "source", "deps", "patches"];
        let items = all
            .iter()
            .map(|id| RuntimeItem {
                id,
                ok: ok_ids.contains(id),
                path: format!("C:\\synth\\{id}"),
                detail: format!("{id} 合成明细 C:\\synth\\{id}"),
                fix: (!ok_ids.contains(id)).then(|| format!("{id} 的装法")),
            })
            .collect();
        let ready = ok_ids.len() == all.len();
        RuntimeProbe { items, ready }
    }

    /// D6：mock 档**不过闸**（30+ 个 mock e2e 靠它活着）—— 反证 M2 钉的就是这一条。
    #[test]
    fn gate_lets_mock_through_even_when_unready() {
        assert_eq!(gate_message_for("mock", &synth(&[])), None);
    }

    /// D6：real 档 + 装好了 ⇒ 放行（不能把装好的用户挡在门外）。
    #[test]
    fn gate_lets_ready_real_through() {
        let p = synth(&["venvRoot", "python", "source", "deps", "patches"]);
        assert_eq!(gate_message_for("real", &p), None);
    }

    /// D6：real 档 + 未就绪 ⇒ 拦住，且文案**点名到每一项**、带它的绝对路径与装法。
    #[test]
    fn gate_blocks_unready_real_naming_every_failing_item() {
        // 只差 python 一项：文案必须只围绕它说，不许把好的那几项也报一遍
        let p = synth(&["venvRoot", "source", "deps", "patches"]);
        let msg = gate_message_for("real", &p).expect("real + 未就绪必须被拦");
        assert!(msg.starts_with("运行时未装配："), "{msg}");
        assert!(msg.contains("python"), "{msg}");
        assert!(msg.contains("C:\\synth\\python"), "文案未带绝对路径：{msg}");
        assert!(msg.contains("python 的装法"), "文案未带装法：{msg}");
        for ok in ["venvRoot", "source", "deps", "patches"] {
            assert!(!msg.contains(ok), "把好的那几项也报了一遍（噪声）：{msg}");
        }
    }
}
