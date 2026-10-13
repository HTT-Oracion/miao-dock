// 显式路由表（F5）—— 把「未迁移端点透传」从**隐式 catch-all** 收敛成**显式白名单**。
//
// ## 为什么必须有它（对应计划文档 R3）
// F1 的反代是一条 `Router::fallback(...)`：任何路径都转发给 Node。于是「迁没迁完」这件事
// **没有可观测的事实** —— e2e 全绿、功能照常，但 node 永远删不掉，包里永久躺一份没人调的
// Node 服务。F5 的验收标准①就是「**转发分支数 = 0**（显式白名单计数）」。
// 因此每条端点都必须在这张表里有名字、有 tier（`Migrated` / `Forwarded`）：
//   · `--list-routes` 把表吐给 e2e；
//   · `check:routes` 做**双向覆盖**（Node 的端点集 ⟷ 本表）+ **计数断言** + **行为断言**
//     （legacy 关掉后，`Migrated` 端点不得 502 —— 这一条让「声明已迁移但其实在转发」无处藏身）。
//
// ## 表是唯一事实源
// 路由匹配（`match_route`）与本表**同源**：匹配不到的名字 = 表里没有 = 404。
// 这样「表漏了一条」不会静默走 catch-all，而是当场 404（可被 e2e 抓到）。
//
// ## 迁移顺序（计划文档 F5）
// `tasks → queue → library → translate → engine`。每迁一组，把对应行的 tier 改成 `Migrated`。
// 全部改完 ⇒ `forwarded_ids().is_empty()` ⇒ 可删 `backend.rs` 与随包的 `node.zip`。
use serde::Serialize;

/// 端点的迁移层级。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// 已在 Rust 实现（`MIAO_LEGACY_BACKEND=0` 时仍能应答）。
    Migrated,
    /// 仍转发给遗留 Node 后端（F5 完成前允许存在；计数被 `check:routes` 盯着）。
    Forwarded,
}

/// 一条端点的定义。`id` = `METHOD pattern`（供反证轮按名字变异）。
#[derive(Clone, Copy, Debug)]
pub struct RouteDef {
    pub id: &'static str,
    pub group: &'static str,
    pub method: &'static str,
    /// 路径模式：字面段 + `{name}` 通配段（各占一段）。**不含** `/api/v1` 之外的写法差异。
    pub pattern: &'static str,
    pub tier: Tier,
}

macro_rules! route {
    ($group:literal, $method:literal, $pattern:literal, $tier:ident) => {
        RouteDef {
            id: concat!($method, " ", $pattern),
            group: $group,
            method: $method,
            pattern: $pattern,
            tier: Tier::$tier,
        }
    };
}

/// 全量端点表。**`/health` 两条属 `health` 组**（9 字段 sidecar 视图仍未迁）。
pub const ROUTES: &[RouteDef] = &[
    // ---- health ----
    route!("health", "GET", "/health", Forwarded),
    route!("health", "GET", "/api/v1/health", Forwarded),
    // ---- tasks ----（F5.2 已迁：handlers.rs `tasks` 段）
    route!("tasks", "POST", "/api/v1/tasks", Migrated),
    route!("tasks", "GET", "/api/v1/tasks", Migrated),
    route!("tasks", "POST", "/api/v1/tasks/delete", Migrated),
    route!("tasks", "GET", "/api/v1/tasks/{taskId}", Migrated),
    route!("tasks", "POST", "/api/v1/tasks/{taskId}/batches", Migrated),
    route!("tasks", "GET", "/api/v1/tasks/{taskId}/events", Migrated),
    route!("tasks", "POST", "/api/v1/tasks/{taskId}/cancel", Migrated),
    route!("tasks", "POST", "/api/v1/tasks/{taskId}/retry", Migrated),
    // ---- queue ----（F5.2 已迁：handlers.rs `queue`）
    route!("queue", "GET", "/api/v1/queue", Migrated),
    // ---- engine ----
    route!("engine", "GET", "/api/v1/engine/status", Forwarded),
    route!("engine", "GET", "/api/v1/engine/options", Forwarded),
    route!("engine", "POST", "/api/v1/engine/settings", Forwarded),
    route!("engine", "POST", "/api/v1/engine/unload", Forwarded),
    route!("engine", "POST", "/api/v1/engine/models/verify", Forwarded),
    route!("engine", "POST", "/api/v1/engine/models/download", Forwarded),
    // ---- translate ----
    route!("translate", "POST", "/api/v1/translate/text", Forwarded),
    route!("translate", "POST", "/api/v1/translate/stream", Forwarded),
    route!("translate", "GET", "/api/v1/translate/options", Forwarded),
    route!("translate", "POST", "/api/v1/translate/settings", Forwarded),
    route!("translate", "POST", "/api/v1/translate/credentials", Forwarded),
    // ---- library ----（F5.3/F5.4 已迁：handlers.rs `library` 段）
    route!("library", "GET", "/api/v1/library", Migrated),
    route!("library", "POST", "/api/v1/library/create", Migrated),
    route!("library", "GET", "/api/v1/library/{name}/files/{seq}", Migrated),
    route!("library", "GET", "/api/v1/library/{book}/chapters/{no}/files/{seq}", Migrated),
    route!("library", "GET", "/api/v1/library/{book}/chapters/{no}/resume", Migrated),
    route!("library", "POST", "/api/v1/library/{book}/chapters/{no}/resume", Migrated),
    route!("library", "GET", "/api/v1/library/{book}/chapters/{no}/retranslate", Migrated),
    route!("library", "POST", "/api/v1/library/{book}/chapters/{no}/retranslate", Migrated),
    route!("library", "POST", "/api/v1/library/{book}/chapters/{no}/renumber", Migrated),
    route!("library", "GET", "/api/v1/library/{name}/meta", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/meta", Migrated),
    route!("library", "GET", "/api/v1/library/{name}/cover", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/cover", Migrated),
    route!("library", "DELETE", "/api/v1/library/{name}/cover", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/merge", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/reveal", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/delete", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/unhide", Migrated),
    route!("library", "GET", "/api/v1/library/{name}/retranslate", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/retranslate", Migrated),
    route!("library", "GET", "/api/v1/library/{name}/resume", Migrated),
    route!("library", "POST", "/api/v1/library/{name}/resume", Migrated),
];

/// 路径切段（复刻 Node `splitPath`：去掉空段 + 逐段 `decodeURIComponent`）。
pub fn split_path(pathname: &str) -> Vec<String> {
    pathname
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| percent_decode(s))
        .collect()
}

/// `decodeURIComponent` 的等价物：**失败时原样返回**（Node 的 try/catch 语义）。
fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // 非 UTF-8 的百分号序列在 JS 里会让 decodeURIComponent 抛错 ⇒ 原样返回。
    match String::from_utf8(out) {
        Ok(s) => s,
        Err(_) => s.to_string(),
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 一次匹配的结果：命中的定义 + 各通配段的值（按出现顺序）。
pub struct Match {
    pub def: &'static RouteDef,
    pub params: Vec<String>,
}

/// 按 (method, 路径段) 在表里找第一条命中的端点。
///
/// ⚠️ 匹配用的是**段**（不是字符串前缀）：`/api/v1/library/create` 与
/// `/api/v1/library/{name}/...` 靠段数与字面段区分 —— 与 Node `route()` 里 `p.length`
/// 的那套判据同口径。
pub fn match_route(method: &str, segs: &[String]) -> Option<Match> {
    for def in ROUTES {
        if def.method != method {
            continue;
        }
        let pat: Vec<&str> = def
            .pattern
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        if pat.len() != segs.len() {
            continue;
        }
        let mut params = Vec::new();
        let mut ok = true;
        for (p, s) in pat.iter().zip(segs.iter()) {
            if p.starts_with('{') && p.ends_with('}') {
                params.push(s.clone());
            } else if *p != s.as_str() {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(Match { def, params });
        }
    }
    None
}

/// 已迁移端点的条数。
pub fn migrated_count() -> usize {
    ROUTES.iter().filter(|r| r.tier == Tier::Migrated).count()
}

/// **转发端点**的条数 —— F5 验收标准① 的那个数（必须归零）。
pub fn forwarded_count() -> usize {
    ROUTES.iter().filter(|r| r.tier == Tier::Forwarded).count()
}

/// 未迁移端点的 id 列表（供断言报出「仍有 N 条转发：…」）。
pub fn forwarded_ids() -> Vec<&'static str> {
    ROUTES.iter().filter(|r| r.tier == Tier::Forwarded).map(|r| r.id).collect()
}

/// `--list-routes` 的输出：全表 + 两个计数。
///
/// 供 e2e 做「转发分支计数」断言；`--refute` 轮通过 `MIAO_ROUTE_REFUTE` 注入一条假转发行，
/// 证明这个计数**咬得住**（漏摘一条 ⇒ 计数变红）。
pub fn report() -> String {
    let routes: Vec<serde_json::Value> = ROUTES
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "group": r.group,
                "method": r.method,
                "pattern": r.pattern,
                "tier": r.tier,
            })
        })
        .collect();
    let extra: Vec<String> = refute_extra_forwarded();
    let mut forwarded: Vec<String> = forwarded_ids().into_iter().map(|s| s.to_string()).collect();
    for id in &extra {
        forwarded.push(id.clone());
    }
    let out = serde_json::json!({
        "routes": routes,
        "migratedCount": migrated_count(),
        "forwardedCount": forwarded_count() + extra.len(),
        "forwarded": forwarded,
    });
    serde_json::to_string_pretty(&out).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

/// 🔴 反证钩子：`MIAO_ROUTE_REFUTE` 注入额外的「未迁移」条目（逗号分隔的 id）。
/// 只用于 `check:routes --refute` 证明计数断言可被反证打红；产品路径绝不设置它。
fn refute_extra_forwarded() -> Vec<String> {
    match std::env::var("MIAO_ROUTE_REFUTE") {
        Ok(v) if !v.trim().is_empty() => {
            v.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string).collect()
        }
        _ => Vec::new(),
    }
}

/// 运行时判定某端点此刻是否「应转发」—— 反证钩子可把任意端点拉回转发态。
pub fn should_forward(def: &RouteDef) -> bool {
    if def.tier == Tier::Forwarded {
        return true;
    }
    refute_extra_forwarded().iter().any(|s| s == def.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(p: &str) -> Vec<String> {
        split_path(p)
    }

    #[test]
    fn matches_health_and_tasks() {
        let m = match_route("GET", &segs("/health")).unwrap();
        assert_eq!(m.def.id, "GET /health");
        let m = match_route("GET", &segs("/api/v1/health")).unwrap();
        assert_eq!(m.def.id, "GET /api/v1/health");
        let m = match_route("POST", &segs("/api/v1/tasks")).unwrap();
        assert_eq!(m.def.id, "POST /api/v1/tasks");
    }

    #[test]
    fn task_id_is_a_wildcard() {
        let m = match_route("GET", &segs("/api/v1/tasks/tsk_abc")).unwrap();
        assert_eq!(m.def.id, "GET /api/v1/tasks/{taskId}");
        assert_eq!(m.params, vec!["tsk_abc".to_string()]);
        let m = match_route("POST", &segs("/api/v1/tasks/tsk_abc/retry")).unwrap();
        assert_eq!(m.def.id, "POST /api/v1/tasks/{taskId}/retry");
    }

    #[test]
    fn library_create_is_not_swallowed_by_name_actions() {
        let m = match_route("POST", &segs("/api/v1/library/create")).unwrap();
        assert_eq!(m.def.id, "POST /api/v1/library/create");
        let m = match_route("GET", &segs("/api/v1/library/Foo/files/3")).unwrap();
        assert_eq!(m.def.id, "GET /api/v1/library/{name}/files/{seq}");
        let m = match_route("GET", &segs("/api/v1/library/Foo/chapters/2/files/3")).unwrap();
        assert_eq!(m.def.id, "GET /api/v1/library/{book}/chapters/{no}/files/{seq}");
    }

    #[test]
    fn method_mismatch_falls_through() {
        assert!(match_route("DELETE", &segs("/api/v1/tasks")).is_none());
        assert!(match_route("PUT", &segs("/api/v1/queue")).is_none());
    }

    #[test]
    fn unknown_path_is_none() {
        assert!(match_route("GET", &segs("/api/v1/nope")).is_none());
        assert!(match_route("GET", &segs("/nope")).is_none());
    }

    #[test]
    fn percent_decode_matches_decodeuri() {
        assert_eq!(split_path("/api/v1/library/%E4%B8%AD%E6%96%87/files/1")[3], "中文");
        // 坏序列 ⇒ 原样（Node decodeURIComponent 抛错被 catch）
        assert_eq!(split_path("/x/%zz")[1], "%zz");
    }

    #[test]
    fn table_has_no_duplicate_ids() {
        let mut seen = std::collections::HashSet::new();
        for r in ROUTES {
            assert!(seen.insert(r.id), "重复端点 id: {}", r.id);
        }
    }
}
