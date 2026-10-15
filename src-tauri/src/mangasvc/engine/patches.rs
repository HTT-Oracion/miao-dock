// 上游源码补丁的**只读镜像**（B5）
// =============================================================================
// 回答一个问题：**我们打在上游引擎上的补丁，现在还在不在**。
//
// ## 为什么产品侧要有一份镜像
// 补丁的**权威表**在 `engine/scripts/setup-engine.mjs` 的 `ENGINE_PATCHES`（SSOT）——
// 装配时按它重放，`e2e/engine/engine-patches-check.mjs` 按它取证。但产品运行期
// **没有 node**（F5 + A3d 后产品运行期 node 启动点为零），检测若去跑那个脚本，
// 等于要求用户机器上同时有 node 和仓库副本 ⇒ 与「引擎 = 用户自装、我们只检测」
// （裁定②）直接冲突。故产品侧持有一份**只读镜像**，判据与 Node 侧逐字一致。
//
// ## 为什么镜像不会漂移没人知道
// 双靶交叉钉：`mangasvc --engine-patches` 导出本表，`engine-patches-check.mjs` 的 **A7**
// 断言它与 `ENGINE_PATCHES` 的 `id/mark/rel/desc` **同序同值**。任一侧改了而另一侧没改
// ⇒ A7 变红。这是本项目一贯的「两份实现 + 断言钉住」纪律（同 `check:paths` 的
// config.mjs ⟷ paths.rs 对拍），不是第三份会漂移的推导。
//
// ## 为什么不把表做成随包 JSON 资产
// `bundle.resources` 的最小集（A2 / `REQUIRED_ASSETS`）装的是**运行期必需**的东西
// （`models.manifest.json`）。补丁表是**装配期**数据：用户按 D5 的文档自己装引擎，
// 补丁由装机脚本打；产品只需要**看得出缺没缺**。把它塞进随包集合并不能换来任何功能
// （产品不重放补丁），却会放大 `REQUIRED_ASSETS` 三处事实源的交叉验证面。
//
// ## 只读，不代装
// 本模块只 `read` 文件判 mark，**不起子进程、不 import torch**（同 `runtime_probe` 的
// 纪律：诊断会被反复打开，检测不该改动机器状态）。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一条补丁的只读镜像。
///
/// `rel` 是**相对引擎源码目录**（`paths::engine_dir()`）的路径段 —— 与 Node 侧
/// `srcPy(...)` 拼出来的是同一个文件，故两侧可以用同一套 `rel` 逐字节比对。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnginePatch {
    pub id: &'static str,
    /// 幂等判据：目标文件里出现它即「已打过」。与 Node 侧同一个字符串。
    pub mark: &'static str,
    pub rel: &'static [&'static str],
    pub desc: &'static str,
}

/// 补丁表镜像（SSOT = `engine/scripts/setup-engine.mjs` 的 `ENGINE_PATCHES`）。
///
/// 🔴 **数组顺序必须与 SSOT 一致** —— A7 交叉钉按序比对，顺序变了即使集合相同也会红
///    （顺序本身就是信息：D-105 依赖 D-103 先应用，见 SSOT 里的注释）。
/// 🔴 新增补丁只改 SSOT 与这里两处，然后跑 `npm run task -- check:engine-patches` ——
///    A1（条数写死 10）与 A7（双靶一致）会同时盯住这次新增。
pub const ENGINE_PATCHES: &[EnginePatch] = &[
    EnginePatch {
        id: "sakura-fail-not-list",
        mark: "# miao-dock 补丁 D-86",
        rel: &["manga_translator", "translators", "sakura.py"],
        desc: "Sakura 翻译失败时不再 return list（上游会糊成 TypeError，D-86）",
    },
    EnginePatch {
        id: "translator-config-from-lang",
        mark: "# miao-dock 补丁 D-97a",
        rel: &["manga_translator", "config.py"],
        desc: "TranslatorConfig 增 from_lang，让「显式方向」有地方可放",
    },
    EnginePatch {
        id: "dispatch-explicit-src-lang",
        mark: "# miao-dock 补丁 D-97b",
        rel: &["manga_translator", "translators", "__init__.py"],
        desc: "dispatch 不再把源语言写死为 auto，改用 TranslatorConfig.from_lang",
    },
    EnginePatch {
        id: "nllb-load-cache-dir",
        mark: "# miao-dock 补丁 D-97c",
        rel: &["manga_translator", "translators", "nllb.py"],
        desc: "nllb 加载：cache_dir 与 _download 一致，且预置权重时零网络（local_files_only）",
    },
    EnginePatch {
        id: "nllb-tokenizer-lang-id",
        mark: "# miao-dock 补丁 D-97d",
        rel: &["manga_translator", "translators", "nllb.py"],
        desc: "nllb 不再用被 transformers>=5 移除的 lang_code_to_id（AttributeError 被 except 吞成静默空串）",
    },
    EnginePatch {
        id: "text-render-no-bitmap",
        mark: "# miao-dock 补丁 D-102",
        rel: &["manga_translator", "rendering", "text_render.py"],
        desc: "正文渲染强制矢量轮廓（FT_LOAD_NO_BITMAP），消除带点阵字体在小字号下的发虚/锯齿（D-102）",
    },
    EnginePatch {
        id: "render-font-zen-first",
        mark: "# miao-dock 补丁 D-103",
        rel: &["manga_translator", "rendering", "text_render.py"],
        desc: "FALLBACK 字体首选 Zen Maru Gothic 圆体（简体缺字由 msyh 逐字兜底），D-103",
    },
    EnginePatch {
        id: "render-font-lxgw-first",
        mark: "# miao-dock 补丁 D-105",
        rel: &["manga_translator", "rendering", "text_render.py"],
        desc: "FALLBACK 字体首选霞鹜文楷 GB（LXGW WenKai GB，GB18030 简体全覆盖），D-105",
    },
    EnginePatch {
        id: "render-warp-cubic",
        mark: "# miao-dock 补丁 D-104",
        rel: &["manga_translator", "rendering", "__init__.py"],
        desc: "warpPerspective 用 INTER_CUBIC 替代 INTER_LINEAR（文字 box 放大映射时边缘更锐，D-104）",
    },
    EnginePatch {
        id: "textblock-dehyphen",
        mark: "# miao-dock 补丁 D-98",
        rel: &["manga_translator", "utils", "textblock.py"],
        desc: "TextBlock 拼接时合并断行连字符（消除 OCR 断词导致的整句译文崩坏）",
    },
];

/// 一条补丁的**现状**。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PatchState {
    pub id: &'static str,
    pub desc: &'static str,
    /// mark 是否在目标文件里（= 补丁真的打上了）。
    pub applied: bool,
    /// 判据作用的那个绝对路径（验收要求：报出来的每一项都要能指到具体文件）。
    pub path: PathBuf,
}

/// 补丁目标文件的绝对路径（与 Node 侧 `srcPy(...)` 同一个文件）。
pub fn patch_file(src_dir: &Path, p: &EnginePatch) -> PathBuf {
    let mut f = src_dir.to_path_buf();
    for seg in p.rel {
        f.push(seg);
    }
    f
}

/// 逐条判定补丁现状。
///
/// 读不到文件（源码未装）一律 `applied = false` —— 「文件不在」与「补丁没打」
/// 对用户是同一件事（都得重跑装配），但 `detail` 文案要能分开（见 `runtime_probe`）。
pub fn patch_states(src_dir: &Path) -> Vec<PatchState> {
    ENGINE_PATCHES
        .iter()
        .map(|p| {
            let path = patch_file(src_dir, p);
            let applied = std::fs::read(&path)
                .map(|b| String::from_utf8_lossy(&b).contains(p.mark))
                .unwrap_or(false);
            PatchState { id: p.id, desc: p.desc, applied, path }
        })
        .collect()
}

/// `mangasvc --engine-patches` 的导出体（A7 双靶交叉钉的 Rust 侧事实源）。
pub fn table_json() -> serde_json::Value {
    serde_json::json!({ "patches": ENGINE_PATCHES })
}

// =============================================================================
//  补丁**应用**（零配置装配用）
// =============================================================================
//  裁定④把「装配由产品代做」写死：产品运行期**没有 node**（F5 + A3d），而补丁的变换逻辑在
//  `engine/scripts/setup-engine.mjs`（Node）里。故 Rust 侧必须能**亲自重放**补丁 —— 否则
//  打包后的产品装出来的引擎是「未打补丁的上游源码」，而那 10 处补丁每一条都对应一个真实的
//  线上故障（D-86 的 TypeError / D-97 系列「译文整页为空」/ D-102 字体发虚 / D-98 整句语义崩坏）。
//
//  应用事实源 = `engine/patches.json`（本文件同目录的 SSOT 副本，与 Node 的 ENGINE_PATCHES
//  同序同义，由 `engine-patches-check.mjs` 的 A7 交叉钉）。本模块只 `read` 文件判已打 / 改文件打补丁，
//  与 `runtime_probe` 同一条「诊断可反复打开、装配只改一次」纪律。

/// 一条补丁的「应用」形态（来自 `patches.json`）。
#[derive(Debug, Clone, serde::Deserialize)]
struct PatchApply {
    id: String,
    #[allow(dead_code)]
    mark: String,
    rel: Vec<String>,
    edits: Vec<PatchEdit>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct PatchEdit {
    anchor: String,
    patch: String,
}

/// 把补丁表里**用 `\n` 书写**的文本，转成**目标文件实际的行尾**（与 Node 侧 `norm()` 同口径）。
///
/// 🔴 上游源码并非同一套行尾：实测 `utils/textblock.py` 是 **CRLF**，而 `config.py` 是 LF
/// （见 `setup-engine.mjs` 同一处的注释）。所以只能**按文件**归一，不能全局假定一种。
///
/// 🔴 这里曾经写错过，症状极具误导性：旧实现是 `s.split('\r')…join("\n")`，
///    对 CRLF 输入会得到 `\n\n`（多插一个空行）⇒ 于是把**内容**也"归一"成双倍行高的文本，
///    与 LF 书写的锚点对不上，报「锚点未找到（源码已变）」。而源码其实一个字都没变 ——
///    错误信息把根因指向了完全无关的方向（会让人去查引擎版本）。
///    正确做法是**别动内容**，只把锚点/替换体转成文件的行尾。
fn to_eol(s: &str, eol: &str) -> String {
    // 先一律收敛成 LF（同时吃掉落单的 `\r`），再按需展开成目标行尾。
    let lf = s.replace("\r\n", "\n").replace('\r', "\n");
    if eol == "\n" { lf } else { lf.replace('\n', eol) }
}

/// 定位 `patches.json`：环境变量 > 随包资源 > 仓库内。
fn patches_json_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MIAO_ENGINE_PATCHES") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p.trim()));
        }
    }
    crate::paths::asset("engine/patches.json")
        .or_else(|| Some(crate::paths::repo_root().join("engine").join("patches.json")))
}

/// 在 `src_dir` 下重放全部补丁（幂等：mark 命中即跳过该条）。
///
/// 返回每条的 `{ id, applied }`（applied = 本次真的改了文件）。任一锚点缺失即抛错（**不静默跳过** ——
/// 源码钉在 ENGINE_COMMIT 上，锚点失效 = 「装出来的引擎已不是我们验过的那份」）。
pub fn apply_engine_patches(src_dir: &Path) -> Result<Vec<(String, bool)>, String> {
    let json_path = patches_json_path().ok_or_else(|| {
        "找不到 engine/patches.json（零配置装配需要它来打源码补丁；设 MIAO_ENGINE_PATCHES 指向它）".to_string()
    })?;
    apply_engine_patches_at(src_dir, &json_path)
}

/// 同上，但**补丁表路径由调用方给**（不读环境变量）。
///
/// 🔴 为什么要把这一步拆出来：`cargo test` 默认**多线程**跑用例，而"设 `MIAO_ENGINE_PATCHES`
///    再跑再删"是所有用例共享的进程级状态 —— 两个用例一个设一个删会把彼此的结果冲掉，
///    症状是**时绿时红**（比稳定失败更坏：会被当成偶发而忽略）。`wheels.rs::plan_crf_with_manifest`
///    就是为了同一个原因把清单路径提成参数。用例一律走这个函数，不碰环境变量。
fn apply_engine_patches_at(src_dir: &Path, json_path: &Path) -> Result<Vec<(String, bool)>, String> {
    let raw = std::fs::read_to_string(json_path)
        .map_err(|e| format!("读 patches.json 失败（{}）：{e}", json_path.display()))?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("patches.json 不是合法 JSON：{e}"))?;
    let list: Vec<PatchApply> = doc
        .get("patches")
        .and_then(|p| serde_json::from_value(p.clone()).ok())
        .ok_or_else(|| "patches.json 缺 `patches` 数组".to_string())?;

    let mut out = Vec::with_capacity(list.len());
    for p in list {
        // 应用清单的 rel 是 `Vec<String>`（JSON 形态），与只读镜像的 `&[&str]` 字段不同 ⇒ 拼接路径。
        let rel: PathBuf = p.rel.iter().map(|s| s.as_str()).collect();
        let file = src_dir.join(rel);
        let content = match std::fs::read_to_string(&file) {
            Ok(c) => c,
            Err(_) => return Err(format!("补丁 {} 的目标源码不存在：{}", p.id, file.display())),
        };
        if content.contains(&p.mark) {
            out.push((p.id, false)); // 已打过
            continue;
        }
        // 按**这个文件**的实际行尾归一（上游源码里 CRLF 与 LF 混着有）。
        let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
        let mut cur = content;
        for (i, e) in p.edits.iter().enumerate() {
            let anchor = to_eol(&e.anchor, eol);
            let patch = to_eol(&e.patch, eol);
            if !cur.contains(&anchor) {
                return Err(format!(
                    "补丁 {} 的第 {} 个锚点未找到（源码已变）；文件：{}；期望锚点首行：{}",
                    p.id,
                    i + 1,
                    file.display(),
                    anchor.lines().next().unwrap_or("")
                ));
            }
            cur = cur.replacen(&anchor, &patch, 1);
        }
        // 写回**保持该文件原本的行尾**（与 Node 侧同口径：CRLF 的文件打完补丁还是 CRLF）。
        std::fs::write(&file, cur)
            .map_err(|e| format!("写补丁 {} 失败：{e}", p.id))?;
        out.push((p.id, true));
    }
    Ok(out)
}

#[cfg(test)]
mod apply_tests {
    use super::*;

    fn write_tree(base: &Path, files: &[(&str, &str)]) {
        let _ = std::fs::remove_dir_all(base);
        for (rel, content) in files {
            let p = base.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
    }

    #[test]
    fn apply_inserts_mark_and_is_idempotent() {
        let base = std::env::temp_dir().join(format!("miao-patch-apply-{}", std::process::id()));
        write_tree(
            &base,
            &[("manga_translator/translators/sakura.py", "a\n    self.logger.error(f'Sakura API请求失败。错误信息： {e}')\n    return prompt\nb\n")],
        );
        let json = base.join("patches.json");
        std::fs::write(
            &json,
            serde_json::json!({ "patches": [ {
                "id": "t", "mark": "# miao-dock 补丁 D-86",
                "rel": ["manga_translator", "translators", "sakura.py"],
                "edits": [ { "anchor": "    self.logger.error(f'Sakura API请求失败。错误信息： {e}')\n    return prompt\n",
                            "patch": "    self.logger.error(f'Sakura API请求失败。错误信息： {e}')\n    # miao-dock 补丁 D-86\n    x\n" } ]
            } ] }).to_string(),
        )
        .unwrap();
        let r1 = apply_engine_patches_at(&base, &json).unwrap();
        assert!(r1.iter().any(|(_, a)| *a), "首次应打上");
        let c = std::fs::read_to_string(base.join("manga_translator/translators/sakura.py")).unwrap();
        assert!(c.contains("# miao-dock 补丁 D-86"), "mark 应出现");

        let r2 = apply_engine_patches_at(&base, &json).unwrap();
        assert!(!r2.iter().any(|(_, a)| *a), "第二次应幂等跳过");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn apply_anchor_missing_is_error_not_silent_skip() {
        let base = std::env::temp_dir().join(format!("miao-patch-miss-{}", std::process::id()));
        write_tree(&base, &[("manga_translator/translators/sakura.py", "x = 1\n")]);
        let json = base.join("patches.json");
        std::fs::write(
            &json,
            serde_json::json!({ "patches": [ {
                "id": "t", "mark": "# m",
                "rel": ["manga_translator", "translators", "sakura.py"],
                "edits": [ { "anchor": "没有这一行", "patch": "z = 3" } ]
            } ] }).to_string(),
        )
        .unwrap();
        // 🔴 锚点缺失必须报错：源码已变、装出来的引擎不是我们验过的那份。静默跳过 = 带病上线。
        assert!(apply_engine_patches_at(&base, &json).is_err(), "锚点缺失应报错，不得静默跳过");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 🔴 CRLF 文件必须打得进补丁，且**保持 CRLF**。
    ///
    /// 这条是从真机上咬出来的：夹具版真装配（`engine-bootstrap-real-check.mjs`）跑真源码时，
    /// 补丁阶段报「锚点未找到（源码已变）」—— 而源码一个字都没变。根因是旧的 `norm_eol`
    /// 把 CRLF 归一成 `\n\n`，锚点于是对不上。上游 `utils/textblock.py` 实测就是 CRLF，
    /// 所以这条在真机上**每次装配都会撞**。
    #[test]
    fn apply_works_on_crlf_files_and_keeps_crlf() {
        let base = std::env::temp_dir().join(format!("miao-patch-crlf-{}", std::process::id()));
        // 源码是 CRLF，而补丁表里一律用 `\n` 书写（与 Node 侧同一约定）。
        write_tree(
            &base,
            &[("manga_translator/utils/textblock.py", "class A:\r\n    def f(self):\r\n        return 1\r\n")],
        );
        let json = base.join("patches.json");
        std::fs::write(
            &json,
            serde_json::json!({ "patches": [ {
                "id": "crlf", "mark": "# miao-dock 补丁 D-99",
                "rel": ["manga_translator", "utils", "textblock.py"],
                "edits": [ { "anchor": "    def f(self):\n        return 1\n",
                            "patch": "    def f(self):\n        # miao-dock 补丁 D-99\n        return 2\n" } ]
            } ] }).to_string(),
        )
        .unwrap();
        let r = apply_engine_patches_at(&base, &json).unwrap();
        assert!(r.iter().any(|(_, a)| *a), "CRLF 文件也必须真打上");
        let raw = std::fs::read_to_string(base.join("manga_translator/utils/textblock.py")).unwrap();
        assert!(raw.contains("# miao-dock 补丁 D-99"), "mark 应在");
        assert!(raw.contains("return 2"), "替换体应生效");
        assert!(raw.contains("\r\n"), "行尾必须保持 CRLF（不许被归一成 LF）");
        assert!(!raw.contains("\n\n\n"), "不许出现双空行（旧 norm_eol 的症状）");

        // 幂等：第二次应跳过。
        let r2 = apply_engine_patches_at(&base, &json).unwrap();
        assert!(!r2.iter().any(|(_, a)| *a), "第二次应幂等跳过");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// LF 文件同样要能打（上游两种行尾混着有 ⇒ 归一必须**按文件**做，不能全局假定）。
    #[test]
    fn apply_works_on_lf_files() {
        let base = std::env::temp_dir().join(format!("miao-patch-lf-{}", std::process::id()));
        write_tree(
            &base,
            &[("manga_translator/config.py", "x = 1\ny = 2\n")],
        );
        let json = base.join("patches.json");
        std::fs::write(
            &json,
            serde_json::json!({ "patches": [ {
                "id": "lf", "mark": "# miao-dock 补丁 D-100",
                "rel": ["manga_translator", "config.py"],
                "edits": [ { "anchor": "x = 1\n", "patch": "x = 1\n# miao-dock 补丁 D-100\n" } ]
            } ] }).to_string(),
        )
        .unwrap();
        apply_engine_patches_at(&base, &json).unwrap();
        let raw = std::fs::read_to_string(base.join("manga_translator/config.py")).unwrap();
        assert!(raw.contains("# miao-dock 补丁 D-100"));
        assert!(!raw.contains("\r"), "LF 文件不许被写成 CRLF");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn patches_json_present_and_is_array() {
        // 真实 patches.json 必须存在且含 patches 数组（与 Node SSOT 同序由 A7 钉）。
        let p = crate::paths::repo_root().join("engine").join("patches.json");
        assert!(p.exists(), "engine/patches.json 必须存在（零配置装配要它打补丁）");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert!(v.get("patches").and_then(|a| a.as_array()).map(|a| !a.is_empty()).unwrap_or(false));
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 镜像必须是非空、结构完整、且 id / (file, mark) 组合唯一 —— 与 A2 同形，
    /// 放在 Rust 侧是为了「改了表就当场红」，不必等 e2e 那一边。
    #[test]
    fn mirror_is_well_formed() {
        assert_eq!(ENGINE_PATCHES.len(), 10, "补丁条数变了 ⇒ SSOT 与 A1 都要同步");
        let mut ids = std::collections::HashSet::new();
        let mut marks = std::collections::HashSet::new();
        for p in ENGINE_PATCHES {
            assert!(!p.id.is_empty() && !p.mark.is_empty() && !p.desc.is_empty());
            assert!(!p.rel.is_empty() && p.rel.iter().all(|s| !s.is_empty()));
            assert!(p.mark.starts_with("# miao-dock 补丁 D-"), "marker 命名纪律：{}", p.mark);
            assert!(p.rel.iter().all(|s| !s.contains('/') && !s.contains('\\')), "rel 必须是路径段");
            assert!(ids.insert(p.id), "id 重复：{}", p.id);
            assert!(marks.insert((p.rel, p.mark)), "同一文件同一 mark 重复：{:?}", p.rel);
        }
    }

    /// 判据必须作用在**文件内容**上：造一份带 mark 的文件 ⇒ applied；抹掉 ⇒ 不 applied。
    /// （「目录存在就算打过」是这类检测最容易犯的错，且症状是静默的。）
    #[test]
    fn applied_judges_file_content_not_directory() {
        let tmp = std::env::temp_dir().join(format!("miao-patches-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let p = &ENGINE_PATCHES[0];
        let f = patch_file(&tmp, p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, format!("x = 1\n{}\ny = 2\n", p.mark)).unwrap();
        let on = patch_states(&tmp);
        assert!(on[0].applied, "带 mark 的文件必须判为已打");
        std::fs::write(&f, "x = 1\ny = 2\n").unwrap();
        let off = patch_states(&tmp);
        assert!(!off[0].applied, "抹掉 mark 必须判为未打");
        // 其余补丁的目标文件不存在 ⇒ 一律未打（不能因"缺文件"而静默算打过）
        assert!(off[1..].iter().all(|s| !s.applied));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 导出体必须带全部补丁（A7 拿它和 Node 表比对，少一条 = 少一条断言）。
    #[test]
    fn table_json_exports_every_patch() {
        let v = table_json();
        let arr = v.get("patches").and_then(|x| x.as_array()).unwrap();
        assert_eq!(arr.len(), ENGINE_PATCHES.len());
    }
}
