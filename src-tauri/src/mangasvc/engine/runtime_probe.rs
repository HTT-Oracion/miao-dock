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
// ## 为什么又追加第六、七项（2026-10-17 真机实测，D-231③）
// 前五项**全部**来自 `--engine-bootstrap` 那条链（python 运行时 / 引擎源码 / 依赖 / 补丁），
// 而 ③ 的可执行体与翻译权重来自**另一条链**（模型清单 + `--fetch-models --extract`）。
// 两条链互不覆盖 ⇒ 一台只跑完第 1 轮（运行环境）的机器被判成"运行时已装配"，
// 引导页显示"装好了"，启动时 ③ 报 `系统找不到指定的路径 (os error 3)` ——
// 用户看到的是"引擎明明装好了却起不来"，离根因十万八千里。
// ⇒ 第六项 `llm`（`bin/llama/<版本>/llama-server[.exe]` 在不在）、第七项 `weights`
// （清单里除 `runtime` 组外的条目齐不齐）。这也正是需求"第 2 段跑完后若 engine/llm
// 仍缺件就显示下载引导页"能成立的前提 —— 判据不齐，那句话就没有事实依据。
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
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::platform::paths;

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

/// 检测报告。`ready` = 七项全真（引擎具备启动的最低条件）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbe {
    pub items: Vec<RuntimeItem>,
    pub ready: bool,
    /// 按清单档位细分的就绪与字节（五段装配流程的数据源）。
    ///
    /// 🔴 **不替代七项**：`ready` 仍是七项全真；`sets` 只回答「视觉 / 翻译 / LLM 各自
    /// 完成到哪」，供流程页逐段推进。`entries == 0` = 当前平台没有该档位。
    pub sets: BTreeMap<String, RuntimeSetView>,
}

/// 一个装配档位的对外视图（`/engine/runtime` 与 `ServiceStatus.runtime` 共用）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetView {
    pub entries: usize,
    pub ready: bool,
    pub total_bytes: u64,
    pub ready_bytes: u64,
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
///
/// `pub` 是因为 `wheels.rs` 的 pydensecrf 兼容补丁要找同一个目录 —— 两处各写一遍
/// 「Windows 是 `Lib\site-packages`、POSIX 是 `lib/python*`」这个分叉，迟早会漂移。
pub fn site_packages(venv: &Path) -> Option<PathBuf> {
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

/// 未就绪项的 `fix` 文案 —— 一律指向**产品内的一键装配**（裁定④：装配由产品代做）。
///
/// 🔴 这里**不得**出现 `node` / `npm run` / `engine/scripts/*.mjs`：打包后的用户机上
/// 既没有 Node、也没有仓库源码树，把命令行当装法等于把人引到死路（历史形态见 D-207）。
/// 命令行只留在 `docs/install-guide-*.md` 的**排障附录**里，而那份文档已写明「普通用户不需要看」。
/// 由 `check:engine-bootstrap` 的 W9 钉住（反证 M4 注回命令行字样 ⇒ 红）。
const FIX_SETUP: &str = "在「设置 → 翻译服务」点「开始下载」，喵坞会自动装配引擎运行时";
const FIX_VENV: &str = "点「开始下载」即可 —— 装配会把 Python 运行环境一并建好（无需命令行）";
const FIX_DEPS: &str = "点「开始下载」即可 —— 装配会从公网镜像安装引擎依赖（无需命令行）";
/// 补丁没打的装法：重放（幂等）而不是重装 —— 源码早就在是常见情形。
const FIX_PATCHES: &str = "点「重新下载模型」重跑一次装配，缺失的源码补丁会被重放（幂等）";
/// ③ 可执行体 / 翻译权重的装法（D-231③）。与前五项分开写文案：这两样走的是**另一条链**
/// （模型清单 + `--fetch-models --extract`），说"重装引擎"会把用户指到重下 6.9 GB 的方向。
const FIX_MODELS: &str = "点「开始下载」（或「重新下载模型」）继续 —— 引擎可执行体与翻译权重还没到位";

/// 跑一遍七项检测。
pub fn probe() -> RuntimeProbe {
    let mut items = Vec::with_capacity(7);

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

    // ---- ⑥ llm：③ 的可执行体在不在盘上（D-231③）----
    // 🔴 **为什么必须单列**：③ 的可执行体走的是**模型清单**那条链
    //    （`llama_cpp_win_cuda_x64` → `--fetch-models --extract` 解到 `bin/llama/<版本>/`），
    //    而前五项全部来自 `--engine-bootstrap` 那条链（venv / 源码 / 依赖 / 补丁）。
    //    两条链互不覆盖 ⇒ 只查五项时，`bin/` 与 `models/` **目录压根没建**的机器
    //    也会被判成"运行时已装配"：引导页说"装好了"，启动时 ③ 报
    //    `系统找不到指定的路径 (os error 3)`，而那句话离根因极远（2026-10-17 真机实测）。
    let llm_bin = super::default_llm_server_bin();
    let llm_ok = is_file(&llm_bin);
    items.push(RuntimeItem {
        id: "llm",
        ok: llm_ok,
        path: s(&llm_bin),
        detail: if llm_ok {
            format!("翻译模型运行时在位：{}", llm_bin.display())
        } else {
            format!(
                "翻译模型运行时缺失：{}（它在 `llama/{}` 解包目录下，与引擎源码不是同一条链）",
                llm_bin.display(),
                super::LLAMA_VERSION_DIR
            )
        },
        fix: (!llm_ok).then(|| FIX_MODELS.to_string()),
    });

    // ---- ⑦ weights：翻译权重（引擎视觉模型 + ③ 的 gguf）齐不齐（D-231③）----
    //    判据直接用 `model_status`（它已经在读清单、筛当前平台、逐条比大小），
    //    **不另写一套** —— 另写一套就会与界面那份"你还缺什么"分叉。
    //    🔴 落点用 `model_root()` 而不是 `runtimes_dir()`：前者是界面那份清单的根
    //    （`MIAO_MODEL_ROOT` / 设置项可改），两者默认值相同但**不是同一个事实**。
    //    🔴 排除 `runtime` 组：那一组（python 运行时 / 引擎源码归档）是前 ①–③ 项的同一件事，
    //    混进来会让一次缺件被报两遍。
    let model_root = paths::model_root();
    let ms = super::model_status::model_status(&paths::model_manifest(), &model_root, None);
    let wanted: Vec<&super::model_status::ModelFileStatus> = ms
        .files
        .iter()
        .filter(|f| f.applicable && !matches!(f.set.as_deref(), Some("runtime")))
        .collect();
    let absent: Vec<&super::model_status::ModelFileStatus> = wanted.iter().copied().filter(|f| !f.ready).collect();
    let weights_ok = !wanted.is_empty() && absent.is_empty();
    let weights_detail = if wanted.is_empty() {
        format!(
            "权重清单读不到或当前平台无条目，权重状态无从判定：{}",
            paths::model_manifest().display()
        )
    } else if weights_ok {
        format!(
            "翻译权重齐备：{}/{} 项在位（{}）",
            wanted.len(),
            wanted.len(),
            model_root.display()
        )
    } else {
        let list = absent
            .iter()
            .map(|f| format!("{}（{}）", f.id, f.path))
            .collect::<Vec<_>>()
            .join("、");
        format!("翻译权重缺 {} 项：{}；模型根 {}", absent.len(), list, model_root.display())
    };
    items.push(RuntimeItem {
        id: "weights",
        ok: weights_ok,
        // 判据作用在**模型根**（`model_status` 的落点），缺项逐条点名在 detail 里。
        path: s(&model_root),
        detail: weights_detail,
        fix: (!weights_ok).then(|| FIX_MODELS.to_string()),
    });

    // 分档视图：复用上面那次 `model_status`，不二次读清单（两套判据会漂）。
    // 四个键恒定存在：`entries == 0` 表示该档在当前平台没有条目，不是"已就绪"。
    let mut sets = BTreeMap::new();
    for id in ["visual", "translation", "llm", "runtime"] {
        let st = ms.set_stat(id);
        sets.insert(
            id.to_string(),
            RuntimeSetView {
                entries: st.entries,
                ready: st.ready,
                total_bytes: st.total_bytes,
                ready_bytes: st.ready_bytes,
            },
        );
    }

    let ready = items.iter().all(|i| i.ok);
    RuntimeProbe { items, ready, sets }
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
///
/// `requiredBytes`（D1）是**当前平台可见条目的清单求和** —— 未装配时界面要能说
/// 「需要先安装翻译引擎（模型资产约 X GB）」，而那个 X 必须**算得出来**（读
/// `models.manifest.json` 求和），不能在界面里写死一个数字；D5 的安装引导文档用的是
/// 同一个数（同一份清单、同一个 `platform_matches`）。
pub fn runtime_view() -> serde_json::Value {
    let report = probe();
    let mut v = serde_json::to_value(&report).unwrap_or_else(|_| serde_json::json!({ "items": [], "ready": false }));
    if let Some(o) = v.as_object_mut() {
        o.insert(
            "requiredBytes".to_string(),
            serde_json::json!(super::model_status::platform_total_bytes(&crate::platform::paths::model_manifest())),
        );
    }
    v
}

/// real 档启动时把「引擎运行时未就绪」**逐项**喊出来（B1 验收②）。
///
/// 没有它，用户看到的是白等 240 s 后一句 `Connection error` —— 离根因极远，且不告诉你缺什么。
/// 有了它，启动日志里就是「缺 python（<绝对路径>）—— 点「开始下载」即可」。
///
/// 🔴 只 warn 不 fail：mock 档**本来就不要真引擎**（30+ 个 mock e2e 靠它活着），而
///    "装到一半"的用户也不该被一句启动失败挡住。real 档的硬门归 D6（首启引导）——
///    那里才有完整的「缺什么 → 怎么装 → 装完重启」流程。
/// 🔴 app 进程（`service.rs::start_blocking`）与 `mangasvc` CLI（`mangasvc::run_blocking`）
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
        println!("[manga-service] ⚠ 引擎运行时未就绪 · {}：{}{}", it.id, it.detail, fix);
    }
}

/// **D6 启动前预检闸门**：real 档下运行时就绪不过 ⇒ 返回要报的文案（`None` = 放行）。
///
/// ## 为什么是闸门而不是继续 warn
/// real 档引擎探针预算是 **240 s**（`mangasvc::engine::REAL_PROBE_TIMEOUT_MS`）。
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
    // 主路径是**产品内一键装配**（裁定④）；安装引导只作排障附录，不作为用户动作。
    Some(format!(
        "运行时未装配：{items}。在「设置 → 翻译服务」点「开始下载」自动装配；排障见 docs/install-guide-*.md"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据必须打在**真实路径**上：七项各自翻转、互不影响（B2 验收②的可反证形式）。
    ///
    /// 🔴 项数与 id 顺序是**契约**：`gate_message` 的文案、e2e 的 `G1.failing`
    /// （断言 failing 条数）、`launch-gate` 的合成报告都按它写。增删项时四处一起改。
    #[test]
    fn probe_seven_items_stable_ids() {
        let p = probe();
        let ids: Vec<&str> = p.items.iter().map(|i| i.id).collect();
        assert_eq!(
            ids,
            vec!["venvRoot", "python", "source", "deps", "patches", "llm", "weights"]
        );
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
        let all = ["venvRoot", "python", "source", "deps", "patches", "llm", "weights"];
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
        RuntimeProbe { items, ready, sets: BTreeMap::new() }
    }

    /// D6：mock 档**不过闸**（30+ 个 mock e2e 靠它活着）—— 反证 M2 钉的就是这一条。
    #[test]
    fn gate_lets_mock_through_even_when_unready() {
        assert_eq!(gate_message_for("mock", &synth(&[])), None);
    }

    /// D6：real 档 + 装好了 ⇒ 放行（不能把装好的用户挡在门外）。
    #[test]
    fn gate_lets_ready_real_through() {
        let p = synth(&["venvRoot", "python", "source", "deps", "patches", "llm", "weights"]);
        assert_eq!(gate_message_for("real", &p), None);
    }

    /// D6：real 档 + 未就绪 ⇒ 拦住，且文案**点名到每一项**、带它的绝对路径与装法。
    #[test]
    fn gate_blocks_unready_real_naming_every_failing_item() {
        // 只差 python 一项：文案必须只围绕它说，不许把好的那几项也报一遍
        let p = synth(&["venvRoot", "source", "deps", "patches", "llm", "weights"]);
        let msg = gate_message_for("real", &p).expect("real + 未就绪必须被拦");
        assert!(msg.starts_with("运行时未装配："), "{msg}");
        assert!(msg.contains("python"), "{msg}");
        assert!(msg.contains("C:\\synth\\python"), "文案未带绝对路径：{msg}");
        assert!(msg.contains("python 的装法"), "文案未带装法：{msg}");
        for ok in ["venvRoot", "source", "deps", "patches", "llm", "weights"] {
            assert!(!msg.contains(ok), "把好的那几项也报了一遍（噪声）：{msg}");
        }
    }

    /// D-231③：只装完第 1 轮（运行环境）时**必须**判未就绪，且点名到 `llm` 与 `weights`。
    ///
    /// 🔴 这条钉的就是真机那台机器的形态：venv / 源码 / 依赖 / 补丁全在，
    /// 而 `bin/llama/<版本>/llama-server.exe` 与 `models/sakura/*.gguf` **目录都没建**。
    /// 没有它，"七项"就只是多了两项标签，判据仍可能整体为真。
    #[test]
    fn gate_names_llm_and_weights_when_only_bootstrap_is_done() {
        let p = synth(&["venvRoot", "python", "source", "deps", "patches"]);
        let msg = gate_message_for("real", &p).expect("只有第 1 轮 ⇒ 必须被拦");
        assert!(msg.contains("llm"), "未点名 ③ 可执行体：{msg}");
        assert!(msg.contains("weights"), "未点名翻译权重：{msg}");
    }
}
