//! 账号与同步（R4）：**中继契约 + 本地桩 + 客户端 + 待同步队列**。
//!
//! ## 契约（桩与真中继同一套路径 / 字段 / 状态码）
//!
//! | 方法 | 路径 | 说明 |
//! |---|---|---|
//! | POST | `/v1/auth/login` | `{email,password}` → `{token,user}`；401 `INVALID_CREDENTIALS` |
//! | POST | `/v1/auth/refresh` | `{token}` → `{token}`；401 `TOKEN_INVALID` |
//! | POST | `/v1/device/start` | `{kind}` → `{deviceCode,userCode,verifyUrl,interval,expiresIn}` |
//! | POST | `/v1/device/poll` | `{deviceCode}` → `{status}`（`pending` / `ok` + token + user / `expired`） |
//! | POST | `/v1/device/approve` | `{deviceCode}` → `{ok}`（桩专用：模拟另一端确认） |
//! | GET | `/v1/sync/pull` | Bearer → `{items}` |
//! | POST | `/v1/sync/push` | Bearer `{items}` → `{accepted,conflicts}`；**按 id 幂等** |
//!
//! 桩跑在回环随机端口上，客户端走真 HTTP —— 换真中继只改 base URL，不改客户端代码。
//!
//! ## 队列与冲突
//! 本地改动先入队（`<state>/sync-queue.json`，原子写）；推送按入队顺序、按 id 幂等。
//! 服务端已有**更新**的同 id 条目 ⇒ 冲突，按 `conflictPolicy` 处理：
//! `remote` 采纳云端、`local` 强制本地、`newest` 比 `updatedAt`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::State as AxState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SESSION_FILE: &str = "account.json";
const QUEUE_FILE: &str = "sync-queue.json";
const TOKEN_TTL_SECS: u64 = 7 * 24 * 3600;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 中继桩
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    email: String,
    name: String,
}

#[derive(Default)]
struct RelayState {
    /// email → (user, password)。桩不存哈希：这是本地替身，不假装是安全实现。
    users: Mutex<HashMap<String, (User, String)>>,
    /// token → email
    tokens: Mutex<HashMap<String, String>>,
    /// deviceCode → (kind, approved, expiresAtMs)
    devices: Mutex<HashMap<String, (String, bool, u64)>>,
    /// id → 条目（服务端唯一事实源）
    items: Mutex<HashMap<String, SyncItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub updated_at: u64,
    pub payload: Value,
}

fn err(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "code": code, "message": message }))).into_response()
}

fn ok(v: Value) -> Response {
    (StatusCode::OK, Json(v)).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

async fn relay_login(AxState(s): AxState<Arc<RelayState>>, Json(body): Json<Value>) -> Response {
    let email = body["email"].as_str().unwrap_or("").trim().to_lowercase();
    let password = body["password"].as_str().unwrap_or("");
    if email.is_empty() || password.is_empty() {
        return err(StatusCode::BAD_REQUEST, "BAD_REQUEST", "邮箱与密码都要填");
    }
    let mut users = s.users.lock().unwrap();
    // 桩：首次登录即注册（真中继是注册/登录两条路由，这里合并只为少一个界面）
    let (user, pw) = users.entry(email.clone()).or_insert_with(|| {
        let name = email.split('@').next().unwrap_or("用户").to_string();
        let user = User { id: format!("u-{email}"), email: email.clone(), name };
        (user, password.to_string())
    });
    if *pw != password {
        return err(StatusCode::UNAUTHORIZED, "INVALID_CREDENTIALS", "邮箱或密码不对");
    }
    let token = format!("t-{}-{}", user.id, now_ms());
    s.tokens.lock().unwrap().insert(token.clone(), email);
    ok(json!({ "token": token, "user": user }))
}

async fn relay_refresh(AxState(s): AxState<Arc<RelayState>>, Json(body): Json<Value>) -> Response {
    let token = body["token"].as_str().unwrap_or("");
    let email = s.tokens.lock().unwrap().get(token).cloned();
    let Some(email) = email else {
        return err(StatusCode::UNAUTHORIZED, "TOKEN_INVALID", "令牌无效或已过期");
    };
    let fresh = format!("t-{}-{}", email, now_ms());
    s.tokens.lock().unwrap().insert(fresh.clone(), email);
    ok(json!({ "token": fresh }))
}

async fn relay_device_start(AxState(s): AxState<Arc<RelayState>>, Json(body): Json<Value>) -> Response {
    let kind = body["kind"].as_str().unwrap_or("oauth");
    if !matches!(kind, "oauth" | "qr") {
        return err(StatusCode::BAD_REQUEST, "BAD_REQUEST", "kind 只认 oauth / qr");
    }
    let code = format!("d-{}-{}", now_ms(), (now_ms() % 997));
    let user_code = format!("{:04}-{:04}", now_ms() % 10000, (now_ms() / 7) % 10000);
    s.devices
        .lock()
        .unwrap()
        .insert(code.clone(), (kind.to_string(), false, now_ms() + 120_000));
    ok(json!({
        "deviceCode": code,
        "userCode": user_code,
        "verifyUrl": format!("http://127.0.0.1/device?code={user_code}"),
        "interval": 2,
        "expiresIn": 120,
    }))
}

async fn relay_device_poll(AxState(s): AxState<Arc<RelayState>>, Json(body): Json<Value>) -> Response {
    let code = body["deviceCode"].as_str().unwrap_or("");
    let mut devices = s.devices.lock().unwrap();
    let Some((kind, approved, expires)) = devices.get(code).cloned() else {
        return err(StatusCode::NOT_FOUND, "DEVICE_UNKNOWN", "设备码不存在");
    };
    if now_ms() > expires {
        devices.remove(code);
        return ok(json!({ "status": "expired" }));
    }
    if !approved {
        return ok(json!({ "status": "pending" }));
    }
    devices.remove(code);
    drop(devices);
    let email = format!("{kind}@local");
    let user = User { id: format!("u-{email}"), email: email.clone(), name: format!("{kind} 用户") };
    s.users
        .lock()
        .unwrap()
        .entry(email.clone())
        .or_insert_with(|| (user.clone(), String::new()));
    let token = format!("t-{}-{}", user.id, now_ms());
    s.tokens.lock().unwrap().insert(token.clone(), email);
    ok(json!({ "status": "ok", "token": token, "user": user }))
}

async fn relay_device_approve(AxState(s): AxState<Arc<RelayState>>, Json(body): Json<Value>) -> Response {
    let code = body["deviceCode"].as_str().unwrap_or("");
    let mut devices = s.devices.lock().unwrap();
    let Some(entry) = devices.get_mut(code) else {
        return err(StatusCode::NOT_FOUND, "DEVICE_UNKNOWN", "设备码不存在");
    };
    entry.1 = true;
    ok(json!({ "ok": true }))
}

async fn relay_pull(AxState(s): AxState<Arc<RelayState>>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "TOKEN_INVALID", "缺少 Bearer 令牌");
    };
    if !s.tokens.lock().unwrap().contains_key(&token) {
        return err(StatusCode::UNAUTHORIZED, "TOKEN_INVALID", "令牌无效");
    }
    let mut items: Vec<SyncItem> = s.items.lock().unwrap().values().cloned().collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    ok(json!({ "items": items }))
}

async fn relay_push(AxState(s): AxState<Arc<RelayState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let Some(token) = bearer(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "TOKEN_INVALID", "缺少 Bearer 令牌");
    };
    if !s.tokens.lock().unwrap().contains_key(&token) {
        return err(StatusCode::UNAUTHORIZED, "TOKEN_INVALID", "令牌无效");
    }
    let incoming: Vec<SyncItem> = match serde_json::from_value(body["items"].clone()) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, "BAD_REQUEST", &format!("items 结构不对：{e}")),
    };
    let mut items = s.items.lock().unwrap();
    let mut accepted: Vec<String> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    for it in incoming {
        match items.get(&it.id) {
            // 幂等：同 id 同 updatedAt 再推一次不算冲突、不重复写
            Some(server) if server.updated_at == it.updated_at => accepted.push(it.id),
            Some(server) if server.updated_at > it.updated_at => {
                conflicts.push(json!({ "id": it.id, "server": server }));
            }
            _ => {
                accepted.push(it.id.clone());
                items.insert(it.id.clone(), it);
            }
        }
    }
    ok(json!({ "accepted": accepted, "conflicts": conflicts }))
}

fn relay_router(s: Arc<RelayState>) -> Router {
    Router::new()
        .route("/v1/auth/login", post(relay_login))
        .route("/v1/auth/refresh", post(relay_refresh))
        .route("/v1/device/start", post(relay_device_start))
        .route("/v1/device/poll", post(relay_device_poll))
        .route("/v1/device/approve", post(relay_device_approve))
        .route("/v1/sync/pull", get(relay_pull))
        .route("/v1/sync/push", post(relay_push))
        .with_state(s)
}

/// 中继桩的 base URL（首次调用时起一个回环随机端口；进程内只起一个）。
pub async fn relay_base() -> Result<String, String> {
    static BASE: OnceLock<String> = OnceLock::new();
    if let Some(v) = BASE.get() {
        return Ok(v.clone());
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("中继桩起不来：{e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("中继桩地址读不到：{e}"))?;
    let state = Arc::new(RelayState::default());
    tokio::spawn(async move {
        let _ = axum::serve(listener, relay_router(state)).await;
    });
    let base = format!("http://{addr}");
    let _ = BASE.set(base.clone());
    Ok(base)
}

// ---------------------------------------------------------------------------
// 客户端（走真 HTTP 打中继；换真中继只改 base）
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::animesvc::metadata::user_agent())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

async fn post_json(url: &str, body: Value, token: Option<&str>) -> Result<(StatusCode, Value), String> {
    let mut req = client()?.post(url).json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.map_err(|e| format!("请求中继失败：{e}"))?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or_else(|_| json!({}));
    Ok((status, v))
}

pub async fn login_password(email: &str, password: &str) -> Result<Value, String> {
    let base = relay_base().await?;
    let (status, v) = post_json(&format!("{base}/v1/auth/login"), json!({ "email": email, "password": password }), None).await?;
    if status != StatusCode::OK {
        return Err(v["message"].as_str().unwrap_or("登录失败").to_string());
    }
    Ok(v)
}

pub async fn device_start(kind: &str) -> Result<Value, String> {
    let base = relay_base().await?;
    let (status, v) = post_json(&format!("{base}/v1/device/start"), json!({ "kind": kind }), None).await?;
    if status != StatusCode::OK {
        return Err(v["message"].as_str().unwrap_or("设备码获取失败").to_string());
    }
    Ok(v)
}

pub async fn device_poll(code: &str) -> Result<Value, String> {
    let base = relay_base().await?;
    let (status, v) = post_json(&format!("{base}/v1/device/poll"), json!({ "deviceCode": code }), None).await?;
    if status != StatusCode::OK {
        return Err(v["message"].as_str().unwrap_or("轮询失败").to_string());
    }
    Ok(v)
}

/// 桩专用：模拟「另一端已确认」（真中继由手机 / 浏览器完成）。
pub async fn device_approve(code: &str) -> Result<Value, String> {
    let base = relay_base().await?;
    let (status, v) = post_json(&format!("{base}/v1/device/approve"), json!({ "deviceCode": code }), None).await?;
    if status != StatusCode::OK {
        return Err(v["message"].as_str().unwrap_or("确认失败").to_string());
    }
    Ok(v)
}

pub async fn push(token: &str, items: &[SyncItem]) -> Result<Value, String> {
    let base = relay_base().await?;
    let (status, v) = post_json(&format!("{base}/v1/sync/push"), json!({ "items": items }), Some(token)).await?;
    if status != StatusCode::OK {
        return Err(v["message"].as_str().unwrap_or("推送失败").to_string());
    }
    Ok(v)
}

pub async fn pull(token: &str) -> Result<Vec<SyncItem>, String> {
    let base = relay_base().await?;
    let res = client()?
        .get(format!("{base}/v1/sync/pull"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("拉取失败：{e}"))?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if status != StatusCode::OK {
        return Err(v["message"].as_str().unwrap_or("拉取失败").to_string());
    }
    serde_json::from_value(v["items"].clone()).map_err(|e| format!("items 解析失败：{e}"))
}

// ---------------------------------------------------------------------------
// 会话与队列（原子写）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: Value,
    #[serde(default)]
    pub last_sync_at: Option<u64>,
    #[serde(default)]
    pub cloud_count: usize,
}

fn state_dir() -> PathBuf {
    crate::platform::paths::anime_state_dir()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换文件失败：{e}"))
}

pub fn load_session() -> Session {
    std::fs::read_to_string(state_dir().join(SESSION_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_session(s: &Session) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| format!("序列化会话失败：{e}"))?;
    write_atomic(&state_dir().join(SESSION_FILE), &text)
}

pub fn load_queue() -> Vec<SyncItem> {
    std::fs::read_to_string(state_dir().join(QUEUE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_queue(items: &[SyncItem]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(items).map_err(|e| format!("序列化队列失败：{e}"))?;
    write_atomic(&state_dir().join(QUEUE_FILE), &text)
}

/// 入队（同 id 覆盖：本地对同一条目的多次改动只留最新一次）。
pub fn enqueue(item: SyncItem) -> Result<(), String> {
    let mut q = load_queue();
    q.retain(|x| x.id != item.id);
    q.push(item);
    save_queue(&q)
}

/// 冲突策略。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ConflictPolicy {
    Remote,
    Local,
    Newest,
}

impl ConflictPolicy {
    pub fn parse(s: &str) -> ConflictPolicy {
        match s {
            "local" => ConflictPolicy::Local,
            "newest" => ConflictPolicy::Newest,
            _ => ConflictPolicy::Remote,
        }
    }
}

/// 纯合并决策：`keep_local = true` 表示把本地值推上去，否则采纳云端。
///
/// `remote`：采纳云端（keep_local=false）；`local`：保留本地（true）；
/// `newest`：`updatedAt` 更新的一侧胜出，**相同时采纳云端**（云端的"已有"更权威）。
pub fn keep_local(policy: ConflictPolicy, local_at: u64, cloud_at: u64) -> bool {
    match policy {
        ConflictPolicy::Remote => false,
        ConflictPolicy::Local => true,
        ConflictPolicy::Newest => local_at > cloud_at,
    }
}

/// 同步一次：按入队顺序推 → 冲突按策略处理 → 拉取云端 → 返回摘要。
pub async fn sync(policy: ConflictPolicy) -> Result<Value, String> {
    let mut session = load_session();
    if session.token.is_empty() {
        return Err("还没登录，先登录再同步".into());
    }
    let mut queue = load_queue();
    let mut pushed = 0usize;
    let mut conflict_rows: Vec<Value> = Vec::new();
    let mut kept: Vec<SyncItem> = Vec::new();

    // 一批推完（真中继也按批）：冲突的按策略决定重推或丢弃
    let res = push(&session.token, &queue).await?;
    let accepted: Vec<String> = serde_json::from_value(res["accepted"].clone()).unwrap_or_default();
    pushed += accepted.len();
    for c in res["conflicts"].as_array().cloned().unwrap_or_default() {
        let id = c["id"].as_str().unwrap_or("");
        let server: SyncItem = serde_json::from_value(c["server"].clone()).map_err(|e| format!("冲突条目解析失败：{e}"))?;
        let local = queue.iter().find(|x| x.id == id).cloned();
        let local_at = local.as_ref().map(|x| x.updated_at).unwrap_or(0);
        if keep_local(policy, local_at, server.updated_at) {
            if let Some(mut it) = local {
                // 本地胜：把 updatedAt 拨到比云端新，再推一次（服务端按"更新"接受）
                it.updated_at = server.updated_at + 1;
                kept.push(it);
            }
        } else {
            conflict_rows.push(json!({
                "id": id,
                "kind": server.kind,
                "key": server.key,
                "local": local,
                "cloud": server,
            }));
        }
    }
    if !kept.is_empty() {
        let res2 = push(&session.token, &kept).await?;
        pushed += res2["accepted"].as_array().map(|a| a.len()).unwrap_or(0);
    }

    let cloud = pull(&session.token).await?;
    session.last_sync_at = Some(now_ms());
    session.cloud_count = cloud.len();
    save_session(&session)?;
    // 队列里剩下的：云端胜的（已采纳）与没冲突但已推的，都清掉；本地胜的重推后也清
    let remaining: Vec<SyncItem> = queue
        .drain(..)
        .filter(|x| !accepted.iter().any(|a| a == &x.id) && !kept.iter().any(|k| k.id == x.id))
        .collect();
    save_queue(&remaining)?;

    Ok(json!({
        "ok": true,
        "pushed": pushed,
        "conflicts": conflict_rows,
        "cloudCount": cloud.len(),
        "lastSyncAt": session.last_sync_at,
    }))
}

/// 手动挑边（R4-4）：`local` 把本地值推上去（`updatedAt` 拨到云端之后），`remote` 采纳云端并丢弃本地队列条目。
///
/// 为什么 `local` 要先拉一次云端：本地时间可能**早于**云端（两端时钟不一致或云端后来改过），
/// 直接推会被服务端判成"更旧"再报一次冲突 —— 那不是解决，是循环。拨到 `云端+1` 才是一次性收口。
pub async fn resolve_conflict(id: &str, side: &str) -> Result<Value, String> {
    let session = load_session();
    if session.token.is_empty() {
        return Err("还没登录，先登录再处理冲突".into());
    }
    let mut queue = load_queue();
    let Some(pos) = queue.iter().position(|x| x.id == id) else {
        return Err(format!("队列里没有这条：{id}"));
    };
    match side {
        "remote" => {
            queue.remove(pos);
            save_queue(&queue)?;
            Ok(json!({ "ok": true, "side": "remote", "dropped": 1 }))
        }
        "local" => {
            let cloud = pull(&session.token).await?;
            let cloud_at = cloud.iter().find(|x| x.id == id).map(|x| x.updated_at).unwrap_or(0);
            let mut item = queue.remove(pos);
            item.updated_at = now_ms().max(cloud_at + 1);
            let res = push(&session.token, std::slice::from_ref(&item)).await?;
            let accepted = res["accepted"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
            if !accepted {
                // 没被接受就把它放回队列，别把用户的值弄丢
                queue.push(item);
                save_queue(&queue)?;
                return Err("云端没有接受这次覆盖（可能刚又被改过），再点一次".into());
            }
            save_queue(&queue)?;
            Ok(json!({ "ok": true, "side": "local", "pushed": 1 }))
        }
        _ => Err("side 只认 local / remote".into()),
    }
}

/// 登录成功后落会话。
pub fn save_login(v: &Value) -> Result<Session, String> {
    let session = Session {
        token: v["token"].as_str().unwrap_or("").to_string(),
        user: v["user"].clone(),
        last_sync_at: None,
        cloud_count: 0,
    };
    save_session(&session)?;
    Ok(session)
}

pub fn logout() -> Result<(), String> {
    save_session(&Session::default())
}

/// 账号状态（给前端）：登录态 + 队列 + 中继地址。
pub async fn state() -> Result<Value, String> {
    let s = load_session();
    let base = relay_base().await?;
    let queue = load_queue();
    Ok(json!({
        "loggedIn": !s.token.is_empty(),
        "user": s.user,
        "lastSyncAt": s.last_sync_at,
        "cloudCount": s.cloud_count,
        "relayBase": base,
        "queue": queue,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_decision_table() {
        assert!(!keep_local(ConflictPolicy::Remote, 100, 50));
        assert!(keep_local(ConflictPolicy::Local, 100, 999));
        assert!(keep_local(ConflictPolicy::Newest, 200, 100));
        assert!(!keep_local(ConflictPolicy::Newest, 100, 200));
        // 同一时刻：云端更权威
        assert!(!keep_local(ConflictPolicy::Newest, 100, 100));
        assert_eq!(ConflictPolicy::parse("local"), ConflictPolicy::Local);
        assert_eq!(ConflictPolicy::parse("newest"), ConflictPolicy::Newest);
        assert_eq!(ConflictPolicy::parse("whatever"), ConflictPolicy::Remote);
    }

    #[tokio::test]
    async fn contract_login_refresh_and_sync_idempotency() {
        let base = relay_base().await.unwrap();
        let c = client().unwrap();

        // 登录（桩首次登录即注册）
        let (status, v) = post_json(
            &format!("{base}/v1/auth/login"),
            json!({ "email": "a@b.c", "password": "pw" }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::OK);
        let token = v["token"].as_str().unwrap().to_string();
        assert_eq!(v["user"]["email"], "a@b.c");

        // 错密码：401 + 明确码
        let (status, v) = post_json(
            &format!("{base}/v1/auth/login"),
            json!({ "email": "a@b.c", "password": "wrong" }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(v["code"], "INVALID_CREDENTIALS");

        // 刷新
        let (status, v) = post_json(&format!("{base}/v1/auth/refresh"), json!({ "token": token }), None).await.unwrap();
        assert_eq!(status, StatusCode::OK);
        let token = v["token"].as_str().unwrap().to_string();

        // 推送：同 id 同 updatedAt 幂等（第二次仍是 accepted，不产生冲突、不重复写）
        let item = SyncItem {
            id: "progress:s1#1".into(),
            kind: "progress".into(),
            key: "s1#1".into(),
            updated_at: 10,
            payload: json!({ "positionMs": 1000 }),
        };
        let (status, v) = post_json(&format!("{base}/v1/sync/push"), json!({ "items": [item.clone()] }), Some(&token))
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["accepted"].as_array().unwrap().len(), 1);
        let (_, v) = post_json(&format!("{base}/v1/sync/push"), json!({ "items": [item.clone()] }), Some(&token))
            .await
            .unwrap();
        assert_eq!(v["accepted"].as_array().unwrap().len(), 1, "同 id 同时间再推应幂等接受");
        assert_eq!(v["conflicts"].as_array().unwrap().len(), 0);

        // 推一条更旧的 ⇒ 冲突，server 回传
        let mut older = item.clone();
        older.updated_at = 5;
        older.payload = json!({ "positionMs": 1 });
        let (_, v) = post_json(&format!("{base}/v1/sync/push"), json!({ "items": [older] }), Some(&token))
            .await
            .unwrap();
        let conflicts = v["conflicts"].as_array().unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["server"]["updatedAt"], 10);

        // 拉取
        let (status, v) = {
            let res = c
                .get(format!("{base}/v1/sync/pull"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap();
            let st = res.status();
            (st, res.json::<Value>().await.unwrap())
        };
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn contract_device_flow_pending_then_ok() {
        let base = relay_base().await.unwrap();
        let (status, v) = post_json(&format!("{base}/v1/device/start"), json!({ "kind": "qr" }), None)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        let code = v["deviceCode"].as_str().unwrap().to_string();
        assert!(v["userCode"].as_str().unwrap().contains('-'));

        // 未确认：pending
        let (_, v) = post_json(&format!("{base}/v1/device/poll"), json!({ "deviceCode": code }), None)
            .await
            .unwrap();
        assert_eq!(v["status"], "pending");

        // 模拟另一端确认 ⇒ ok + token + user
        let (status, _) = post_json(&format!("{base}/v1/device/approve"), json!({ "deviceCode": code }), None)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        let (_, v) = post_json(&format!("{base}/v1/device/poll"), json!({ "deviceCode": code }), None)
            .await
            .unwrap();
        assert_eq!(v["status"], "ok");
        assert!(v["token"].as_str().unwrap().starts_with("t-"));
        assert_eq!(v["user"]["email"], "qr@local");

        // 未知设备码：404 且说清楚
        let (status, v) = post_json(&format!("{base}/v1/device/poll"), json!({ "deviceCode": "nope" }), None)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(v["code"], "DEVICE_UNKNOWN");
    }
}
