//! 番剧库的落盘模型（「番 / 集 / 进度」三层）。
//!
//! ## 为什么一部番一个目录 + `manifest.json`
//! 目录本身就是「番」的身份（名字可读写、可被用户直接管理）；manifest 只放
//! **元数据与进度**。这样换机器时整个目录可搬运，服务只做"读目录、读清单"，
//! 不另建一份全局数据库 —— 全局库与目录一旦不一致，症状是"文件在盘上但库里没有"。
//!
//! ## 与漫画库隔离（D-242）
//! 本模块只认 `animeRootDir`；漫画库的目录结构与这里无关。两边共用根会让番剧
//! 出现在漫画库里（`check:anime` A4 双向断言把守）。
//!
//! ## 缺 manifest 不算坏数据
//! 用户把一个番剧文件夹拖进来时不会有 manifest。此时**按目录名 + 集目录名合成**
//! 一份（标题=目录名、集号=目录名前导数字），首次保存时落盘。这样"先有文件后有清单"
//! 与"先有清单后有文件"都成立。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MANIFEST_NAME: &str = "manifest.json";
pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Airing {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_original: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episodes_total: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    #[serde(default)]
    pub progress: u32,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airing: Option<Airing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub subject_id: String,
    pub index: f64,
    pub title: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<Segment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ed: Option<Segment>,
    #[serde(default)]
    pub watched: bool,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// 一部的清单：元数据 + 集 + 预留字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default = "default_version")]
    pub version: u32,
    pub subject: Subject,
    #[serde(default)]
    pub episodes: Vec<Episode>,
    /// 弹幕轨预留（本期不渲染，字段先留好，避免以后改清单结构）
    #[serde(default)]
    pub danmaku: Value,
}

fn default_version() -> u32 {
    MANIFEST_VERSION
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn subject_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

pub fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST_NAME)
}

/// 目录名 → 安全的单层名字（挡 `..` / 分隔符 / 盘符）。
pub fn safe_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.contains('\0');
    if ok {
        Some(name)
    } else {
        None
    }
}

/// 从集目录名前导数字取集号（`EP01` / `01` / `第03话` 都认；认不出按顺序补）。
fn parse_index(name: &str, fallback: f64) -> f64 {
    let digits: String = name.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    digits.parse::<f64>().unwrap_or(fallback)
}

/// 读一份清单；缺失或坏 JSON 时按目录合成（并记进 `skipped`，让上层如实报）。
pub fn load(dir: &Path, skipped: &mut Vec<Value>) -> Manifest {
    let name = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let path = manifest_path(dir);
    if let Ok(raw) = fs::read_to_string(&path) {
        match serde_json::from_str::<Manifest>(&raw) {
            Ok(m) => return m,
            Err(e) => skipped.push(json!({ "path": path.to_string_lossy(), "reason": format!("manifest 解析失败：{e}") })),
        }
    }
    synth(dir, &name)
}

/// 合成一份最小清单：标题=目录名，集=直接子目录（按名字排序、集号取前导数字）。
pub fn synth(dir: &Path, name: &str) -> Manifest {
    let mut eps: Vec<Episode> = Vec::new();
    let mut dirs: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    for (i, (ep_name, ep_dir)) in dirs.iter().enumerate() {
        let index = parse_index(ep_name, (i + 1) as f64);
        let bytes = dir_size(ep_dir);
        eps.push(Episode {
            id: format!("{name}#{index}"),
            subject_id: name.to_string(),
            index,
            title: ep_name.clone(),
            // 目录里没有时长信息：0 表示"未知"，界面显示「—」而不是编一个数字
            duration_ms: 0,
            op: None,
            ed: None,
            watched: false,
            position_ms: 0,
            updated_at: now_ms(),
            // 文件体积不塞进清单：它是盘上事实，随扫描实时算（清单只记用户数据）
        });
        let _ = bytes;
    }
    Manifest {
        version: MANIFEST_VERSION,
        subject: Subject {
            id: name.to_string(),
            title: name.to_string(),
            title_original: None,
            cover: None,
            year: None,
            season: None,
            episodes_total: if eps.is_empty() { None } else { Some(eps.len() as u32) },
            summary: None,
            tags: Vec::new(),
            rating: None,
            collection: None,
            progress: 0,
            updated_at: now_ms(),
            airing: None,
        },
        episodes: eps,
        danmaku: Value::Null,
    }
}

/// 单目录递归体积（列表里的「占多少」用它，不进清单）。
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_file() {
            total += p.metadata().map(|m| m.len()).unwrap_or(0);
        } else if p.is_dir() {
            total += dir_size(&p);
        }
    }
    total
}

/// 原子写：先写 `.tmp` 再 rename（半截文件比没有文件更糟）。
pub fn save(dir: &Path, m: &Manifest) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("建目录失败 {}：{e}", dir.display()))?;
    let path = manifest_path(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(m).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&tmp, text).map_err(|e| format!("写临时文件失败 {}：{e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("改名失败 {}：{e}", path.display()))
}

/// 扫描整个番剧库 → `{ root, count, subjects, episodes, scannedAt, skipped }`。
pub fn scan(root: &Path) -> Result<Value, String> {
    let mut subjects: Vec<Value> = Vec::new();
    let mut episodes: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let rd = fs::read_dir(root).map_err(|e| format!("{}：{e}", root.display()))?;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let m = load(&p, &mut skipped);
        let size = dir_size(&p);
        let mut s = serde_json::to_value(&m.subject).map_err(|e| format!("序列化失败：{e}"))?;
        if let Some(obj) = s.as_object_mut() {
            obj.insert("episodesCached".into(), json!(m.episodes.iter().filter(|e| e.watched).count()));
            obj.insert("sizeBytes".into(), json!(size));
            obj.insert("dir".into(), json!(p.to_string_lossy()));
        }
        subjects.push(s);
        for ep in &m.episodes {
            if let Ok(v) = serde_json::to_value(ep) {
                episodes.push(v);
            }
        }
    }
    subjects.sort_by(|a, b| {
        a["title"].as_str().unwrap_or("").cmp(b["title"].as_str().unwrap_or(""))
    });
    Ok(json!({
        "root": root.to_string_lossy(),
        "count": subjects.len(),
        "subjects": subjects,
        "episodes": episodes,
        "scannedAt": now_ms(),
        "skipped": skipped,
    }))
}

/// 保存条目（新建 / 改元数据 / 改收藏态）。
///
/// `id` 既可能是目录名也可能是 Bangumi 数字 id：**目录名以 `dir` 为准**，
/// 没有 `dir` 时用 `id`。两者都缺 ⇒ 拒绝，避免凭空造一个无处安放的条目。
pub fn save_subject(root: &Path, body: &Value) -> Result<Value, String> {
    let subject: Subject = serde_json::from_value(body.clone()).map_err(|e| format!("条目字段不合法：{e}"))?;
    let dir_name = body
        .get("dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| subject.id.clone());
    let name = safe_name(&dir_name).ok_or_else(|| format!("非法的作品名：{dir_name}"))?;
    let dir = subject_dir(root, name);
    let mut skipped = Vec::new();
    let mut m = load(&dir, &mut skipped);
    m.subject = Subject { id: name.to_string(), updated_at: now_ms(), ..subject };
    save(&dir, &m)?;
    Ok(json!({ "ok": true, "dir": dir.to_string_lossy(), "subject": m.subject }))
}

/// 改收藏态（只动一个字段，不要求前端回传整份条目）。
pub fn set_collection(root: &Path, id: &str, collection: Option<&str>) -> Result<Value, String> {
    let name = safe_name(id).ok_or_else(|| format!("非法的作品名：{id}"))?;
    let dir = subject_dir(root, name);
    if !dir.is_dir() {
        return Err(format!("没有这个作品：{id}"));
    }
    let mut skipped = Vec::new();
    let mut m = load(&dir, &mut skipped);
    m.subject.collection = collection.map(|s| s.to_string());
    m.subject.updated_at = now_ms();
    save(&dir, &m)?;
    Ok(json!({ "ok": true, "subject": m.subject }))
}

/// 保存一集（进度 / 看完标记）。集不存在时补一条（先有进度后有清单的场景）。
pub fn save_episode(root: &Path, body: &Value) -> Result<Value, String> {
    let ep: Episode = serde_json::from_value(body.clone()).map_err(|e| format!("剧集字段不合法：{e}"))?;
    let name = safe_name(&ep.subject_id).ok_or_else(|| format!("非法的作品名：{}", ep.subject_id))?;
    let dir = subject_dir(root, name);
    if !dir.is_dir() {
        return Err(format!("没有这个作品：{name}"));
    }
    let mut skipped = Vec::new();
    let mut m = load(&dir, &mut skipped);
    let mut found = false;
    for e in m.episodes.iter_mut() {
        if e.id == ep.id {
            *e = Episode { updated_at: now_ms(), ..ep.clone() };
            found = true;
            break;
        }
    }
    if !found {
        m.episodes.push(Episode { updated_at: now_ms(), ..ep.clone() });
    }
    m.episodes.sort_by(|a, b| a.index.partial_cmp(&b.index).unwrap_or(std::cmp::Ordering::Equal));
    m.subject.progress = m.episodes.iter().filter(|e| e.watched && e.index.fract() == 0.0).count() as u32;
    m.subject.updated_at = now_ms();
    save(&dir, &m)?;
    Ok(json!({ "ok": true, "episode": ep, "progress": m.subject.progress }))
}

/// 载入示例数据：写 4 部带 `demo-` 前缀的番。
///
/// 🔴 必须**显式触发**且可整批删除：静默造假数据比空态更糟（用户分不清哪些是自己的）。
pub fn seed_demo(root: &Path) -> Result<Value, String> {
    let demos = demo_manifests();
    for (name, m) in demos {
        let dir = subject_dir(root, &name);
        save(&dir, &m)?;
    }
    scan(root)
}

/// 清空示例：只删 `demo-` 前缀目录，不碰用户自己的库。
pub fn clear_demo(root: &Path) -> Result<Value, String> {
    let rd = fs::read_dir(root).map_err(|e| format!("{}：{e}", root.display()))?;
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() && name.starts_with("demo-") {
            fs::remove_dir_all(&p).map_err(|e| format!("删除示例失败 {}：{e}", p.display()))?;
        }
    }
    scan(root)
}

fn demo_manifests() -> Vec<(String, Manifest)> {
    fn ep(subject: &str, index: f64, title: &str, minutes: u64) -> Episode {
        Episode {
            id: format!("{subject}#{index}"),
            subject_id: subject.to_string(),
            index,
            title: title.to_string(),
            duration_ms: minutes * 60_000,
            op: Some(Segment { start_ms: 0, end_ms: 90_000 }),
            ed: Some(Segment { start_ms: minutes * 60_000 - 95_000, end_ms: minutes * 60_000 }),
            watched: index <= 3.0,
            position_ms: if index == 4.0 { 9 * 60_000 + 12_000 } else if index <= 3.0 { minutes * 60_000 } else { 0 },
            updated_at: now_ms(),
        }
    }
    let mut out = Vec::new();
    let make = |name: &str,
                title: &str,
                year: u32,
                season: &str,
                tags: Vec<&str>,
                rating: f64,
                collection: &str,
                airing: Airing,
                total: u32| {
        let subject = name.to_string();
        let episodes: Vec<Episode> = (1..=total)
            .map(|i| ep(&subject, i as f64, &format!("第 {i} 话"), 24))
            .collect();
        let progress = episodes.iter().filter(|e| e.watched).count() as u32;
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            subject: Subject {
                id: subject.clone(),
                title: title.to_string(),
                title_original: None,
                cover: None,
                year: Some(year),
                season: Some(season.to_string()),
                episodes_total: Some(total),
                summary: Some(format!("{title} —— 示例条目。清空示例后不会留在你的库里。")),
                tags: tags.into_iter().map(|s| s.to_string()).collect(),
                rating: Some(rating),
                collection: Some(collection.to_string()),
                progress,
                updated_at: now_ms(),
                airing: Some(airing),
            },
            episodes,
            danmaku: Value::Null,
        };
        (name.to_string(), manifest)
    };
    out.push(make("demo-bocchi", "孤独摇滚！", 2022, "2022-10", vec!["音乐", "日常"], 8.7, "doing", Airing { state: "finished".into(), latest: Some(12), weekday: Some(5) }, 12));
    out.push(make("demo-frieren", "葬送的芙莉莲", 2023, "2023-09", vec!["奇幻", "冒险"], 9.1, "doing", Airing { state: "airing".into(), latest: Some(28), weekday: Some(4) }, 28));
    out.push(make("demo-uma", "赛马娘 Pretty Derby", 2021, "2021-01", vec!["运动", "热血"], 8.0, "onhold", Airing { state: "finished".into(), latest: Some(13), weekday: Some(1) }, 13));
    out.push(make("demo-hyouka", "冰菓", 2012, "2012-04", vec!["推理", "校园"], 8.6, "done", Airing { state: "finished".into(), latest: Some(22), weekday: Some(6) }, 22));
    out
}
