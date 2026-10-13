// 已迁移端点的 HTTP 处理层（F5）—— 与 `routes.rs` 的显式表一一对应。
//
// 分工：`routes.rs` 只回答「这条端点是谁、迁没迁」；本模块回答「已迁移的它怎么答」。
// 逐组迁移时，把对应 handler 加到这里，并把 `routes.rs` 里那一行的 tier 改成 `Migrated`。
//
// `dispatch` 的入参已由外壳做过：Origin 白名单、CORS 预检、令牌校验。因此这里**不再**重复鉴权
// —— 鉴权只能有一处，多一处就会漂移出「某个端点忘了校验」。
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;

use super::routes::Match;
use super::Shell;

/// 已迁移端点的总入口。`routes::match_route` 命中且 `!should_forward` 时由外壳调用。
pub async fn dispatch(
    _shell: Arc<Shell>,
    m: Match,
    _uri: Uri,
    _headers: HeaderMap,
    _body: Body,
) -> Response {
    super::envelope(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL",
        &format!("端点 {} 在路由表里声明为已迁移，但尚无实现（F5 迁移进行中）", m.def.id),
        serde_json::json!({ "route": m.def.id }),
    )
}
