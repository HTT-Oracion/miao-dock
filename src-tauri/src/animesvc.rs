//! animesvc —— 动漫域的服务进程（D-242）。
//!
//! ## 与 `mangasvc` 的关系：同构、隔离、可同时运行
//! · **同构**：同样的端口探测区间（5180–5190）、同样的就绪行协议、同样的令牌校验与
//!   错误信封、同样的落盘根安全闸（共用 `platform::root_guard`）。
//! · **隔离**：自己的 state（含令牌）、自己的作品库根、自己的运行时根 —— 见
//!   `platform::paths::anime_*`。三个 `MIAO_ANIME_*` 环境变量可整体指到临时目录。
//! · **同时运行**：没有单实例锁；端口是"先探测再绑定"（漫画占 5180 时动漫自然落 5181）。
//!   两个进程互不等待、互不 kill —— 这条由 `check:anime` 的 A3 实证。
//!
//! ## 为什么是**独立进程**而不是 `mangasvc` 的子命令
//! 动漫域将来要自带引擎栈与数据源，依赖集与漫画翻译互不相干；一个进程里混两套依赖，
//! 任何一侧的崩溃 / 内存峰值都会拖垮另一侧。代价是壳层要多跟踪一个服务 —— 本轮
//! **不做**壳层集成（桌面端仍只拉起 `mangasvc`），只保证两个 exe 能同时正常跑。
//!
//! ## 端点（本轮的最小可用面）
//! · `GET /api/v1/health`                      无鉴权，给探活与落点自证
//! · `GET /api/v1/anime/library`               需要 `X-Box-Token`，扫 `<animeRootDir>` 顶层
//! · `GET /api/v1/anime/library/:name`         需要 `X-Box-Token`，单个作品的剧集明细
//!
//! 🔴 与漫画服务**共用同一个请求头** `X-Box-Token`：它是《03》契约里的头名，不是漫画
//!    专属。令牌值不同（各持 `<state>/token`），所以拿漫画令牌打动漫端点会 403。
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Path as AxPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

mod manifest;
pub mod datasource;
pub mod import;
pub mod metadata;
pub mod playback;
pub mod sources;
pub mod stream;

use crate::platform::paths;
use crate::platform::root_guard::validate_root;

pub const SERVICE_NAME: &str = "anime-service";
pub const SERVICE_VERSION: &str = "0.1.0";
pub const API_VERSION: &str = "v1";

/// 与 `mangasvc` **同一段**：两个进程各自"先探测再绑定"，先起的占 5180，后起的自然落 5181。
pub(crate) const PORT_RANGE_START: u16 = 5180;
pub(crate) const PORT_RANGE_END: u16 = 5190;

/// 共享状态：令牌 + 已规范化的库根 + 状态目录（源列表落点）+ 启动时刻。
#[derive(Clone)]
pub struct Shell {
    token: String,
    root_dir: String,
    state_dir: String,
    started: Instant,
}

impl Shell {
    /// 流端点要拿令牌算票（`stream::sign`），只读访问，不给外部改的机会。
    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    /// 流端点要用库根做路径白名单。
    pub(crate) fn root(&self) -> &str {
        &self.root_dir
    }

    /// 源列表等配置落点（**不放库根内**：那是用户成果目录，配置混进去会被扫描误读）。
    pub(crate) fn state_dir(&self) -> &str {
        &self.state_dir
    }
}

/// 启动参数（环境变量驱动）
pub struct Options {
    /// 显式端口（`MIAO_ANIME_PORT`）；`None` 时在 5180–5190 探测
    pub explicit_port: Option<u16>,
}

impl Options {
    pub fn from_env() -> Self {
        let explicit_port = std::env::var("MIAO_ANIME_PORT")
            .ok()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<u16>().ok());
        Options { explicit_port }
    }
}

/// 取动漫服务令牌：`MIAO_ANIME_TOKEN` 优先；否则 `<animeStateDir>/token`
/// （在盘的 64 位 hex 直接复用；没有或不合规就 32 字节 CSPRNG 生成后落盘）。
///
/// 🔴 与漫画**必须**是两份文件：共用一个令牌意味着"拿到漫画令牌即可调动漫全部端点"，
///    两域隔离就成了一句空话（`check:anime` 的 A3 断言两者不同）。
fn ensure_token() -> String {
    if let Ok(v) = std::env::var("MIAO_ANIME_TOKEN") {
        if !v.is_empty() {
            return v;
        }
    }
    let file = paths::anime_token_file();
    if let Ok(raw) = fs::read_to_string(&file) {
        let t = raw.trim();
        if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            chmod_private(&file);
            return t.to_string();
        }
    }
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let token = hex::encode(bytes);
    if let Err(e) = write_private(&file, &token) {
        eprintln!("[anime-service] ⚠ 令牌落盘失败（{e}）：本次运行改用内存令牌，重启后会变");
    }
    token
}

fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(file)?;
    f.write_all(text.as_bytes())
}

fn chmod_private(file: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = file;
    }
}

/// 以 **阻塞** 方式跑起来（供独立 `animesvc` bin）。
pub fn run_blocking(opts: Options) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("无法创建 tokio 运行时：{e}"))?;

    let token = ensure_token();
    // 与漫画同一道安全闸：拒绝系统 / 共享位置；顺带"启动即建目录"。
    let root_dir = validate_root(&paths::anime_root_dir().to_string_lossy())?
        .to_string_lossy()
        .into_owned();

    let shell = Arc::new(Shell {
        token,
        root_dir,
        state_dir: paths::anime_state_dir().to_string_lossy().into_owned(),
        started: Instant::now(),
    });

    let (port, listener) = bind_with_probe(opts.explicit_port)?;
    println!(
        "[anime-service] ANIME_READY {}",
        serde_json::json!({
            "port": port,
            "token": shell.token,
            "rootDir": shell.root_dir,
        })
    );
    println!("[anime-service] animesvc 监听 127.0.0.1:{port}（库：{}）", shell.root_dir);

    let app = router(shell);
    rt.block_on(async move {
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking 失败：{e}"))?;
        let l = tokio::net::TcpListener::from_std(listener)
            .map_err(|e| format!("转 tokio listener 失败：{e}"))?;
        axum::serve(l, app)
            .with_graceful_shutdown(shutdown_signal())
            .await
            .map_err(|e| format!("axum 服务退出异常：{e}"))
    })?;
    Ok(())
}

fn router(shell: Arc<Shell>) -> Router {
    Router::new()
        .route(&format!("/api/{API_VERSION}/health"), get(health))
        .route(&format!("/api/{API_VERSION}/anime/library"), get(library))
        .route(&format!("/api/{API_VERSION}/anime/library/:name"), get(entry))
        // 写入面：条目 / 收藏态 / 剧集进度 / 示例数据（全部要求令牌）
        .route(&format!("/api/{API_VERSION}/anime/subject"), post(save_subject))
        .route(&format!("/api/{API_VERSION}/anime/collection"), post(set_collection))
        .route(&format!("/api/{API_VERSION}/anime/progress"), post(save_episode))
        .route(&format!("/api/{API_VERSION}/anime/demo"), post(seed_demo))
        .route(&format!("/api/{API_VERSION}/anime/demo/clear"), post(clear_demo))
        // 播放：媒体探测（这一集盘上有没有片、走哪条轨）+ 带签名的 Range 流
        .route(&format!("/api/{API_VERSION}/anime/episode/:name/:index/media"), get(episode_media))
        .route(&format!("/api/{API_VERSION}/anime/stream"), get(stream::handle))
        // 元数据：Bangumi 检索 + 按 id 补进 manifest（走服务侧，前端不直连第三方）
        .route(&format!("/api/{API_VERSION}/anime/metadata/search"), get(metadata_search))
        .route(&format!("/api/{API_VERSION}/anime/metadata/apply"), post(metadata_apply))
        // 数据源（M3 契约）：列表 / 增改 / 删除
        .route(
            &format!("/api/{API_VERSION}/anime/sources"),
            get(sources_list).post(source_save),
        )
        .route(&format!("/api/{API_VERSION}/anime/sources/delete"), post(source_delete))
        // 本机导入：把用户选的文件夹复制进库根
        .route(&format!("/api/{API_VERSION}/anime/import"), post(import_folder))
        // 数据源测试（M3 第一个适配器：RSS）
        .route(&format!("/api/{API_VERSION}/anime/sources/test"), post(source_test))
        // 媒体服务器远程播放：带票中继上游视频（api_key 只走请求头，不出现在 URL 里）
        .route(&format!("/api/{API_VERSION}/anime/mediaserver/stream"), get(datasource::mediaserver::relay))
        // 兜底：打错端口的人（例如把 /library 打到动漫服务上）要看到"这里是谁"，
        // 而不是一个裸 404 —— 两个服务同时在跑时这是最常见的误接。
        .fallback(fallback)
        .with_state(shell)
}

async fn health(State(shell): State<Arc<Shell>>) -> Response {
    json(
        StatusCode::OK,
        serde_json::json!({
            "status": "ok",
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "apiVersion": API_VERSION,
            "rootDir": shell.root_dir,
            "uptimeSec": shell.started.elapsed().as_secs(),
        }),
    )
}

async fn library(State(shell): State<Arc<Shell>>, headers: HeaderMap) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match manifest::scan(Path::new(&shell.root_dir)) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("扫描动漫库失败：{e}")),
    }
}

/// 保存条目（新建 / 改元数据 / 改收藏态）。
async fn save_subject(State(shell): State<Arc<Shell>>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match manifest::save_subject(Path::new(&shell.root_dir), &body) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

/// 只改收藏态的窄口：列表里的五状态按钮不必回传整份条目。
async fn set_collection(State(shell): State<Arc<Shell>>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let collection = body.get("collection").and_then(|v| v.as_str());
    match manifest::set_collection(Path::new(&shell.root_dir), &id, collection) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

/// 保存一集进度（续看位置 / 看完标记）。
async fn save_episode(State(shell): State<Arc<Shell>>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match manifest::save_episode(Path::new(&shell.root_dir), &body) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

/// 载入示例数据（显式动作）。
async fn seed_demo(State(shell): State<Arc<Shell>>, headers: HeaderMap) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match manifest::seed_demo(Path::new(&shell.root_dir)) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("写入示例失败：{e}")),
    }
}

/// 清空示例（只删 `demo-` 前缀，不碰用户数据）。
async fn clear_demo(State(shell): State<Arc<Shell>>, headers: HeaderMap) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match manifest::clear_demo(Path::new(&shell.root_dir)) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("清空示例失败：{e}")),
    }
}

/// 媒体探测：这一集的目录里有没有可播的片、该走哪条轨、有没有外挂字幕。
///
/// 只报告**盘上事实**：没有片就是 `{ found: false }`，不编造来源 ——
/// 选源（在线源 / BT）是 M3 的事，这里只回答「本地这一集能不能放」。
async fn episode_media(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    AxPath((name, index)): AxPath<(String, String)>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    let idx: f64 = match index.parse() {
        Ok(v) => v,
        Err(_) => return envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", format!("非法的集号：{index}")),
    };
    match manifest::episode_media(Path::new(&shell.root_dir), &name, idx) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

#[derive(Deserialize)]
struct MetadataQuery {
    q: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataApplyBody {
    dir: String,
    bgm_id: u64,
}

/// 按关键词检索 Bangumi 候选（只搜动画）。
async fn metadata_search(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Query(q): Query<MetadataQuery>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    let keyword = q.q.trim();
    if keyword.is_empty() {
        return envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", "缺少检索关键词");
    }
    match metadata::search_default(keyword, 8).await {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_GATEWAY, "UPSTREAM", format!("Bangumi 检索失败：{e}")),
    }
}

/// 拉详情并写进该作品的清单。身份仍是目录名（`dir`），Bangumi id 只用于来源记录。
async fn metadata_apply(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Json(body): Json<MetadataApplyBody>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match metadata::apply_default(Path::new(&shell.root_dir), &body.dir, body.bgm_id).await {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) if e.starts_with("没有这个作品") || e.starts_with("非法的作品名") => {
            envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e)
        }
        Err(e) => envelope(StatusCode::BAD_GATEWAY, "UPSTREAM", format!("Bangumi 元数据写入失败：{e}")),
    }
}

#[derive(Deserialize)]
struct SourceDeleteBody {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportBody {
    path: String,
    #[serde(default)]
    subject: Option<String>,
}

/// 媒体源列表：内置本地库恒在第一位。
async fn sources_list(State(shell): State<Arc<Shell>>, headers: HeaderMap) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match sources::list(Path::new(shell.state_dir()), Path::new(&shell.root_dir)) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", e),
    }
}

/// 新增 / 更新一个源（内置源不可改）。
async fn source_save(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match sources::save(Path::new(shell.state_dir()), &body) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

async fn source_delete(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Json(body): Json<SourceDeleteBody>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match sources::remove(Path::new(shell.state_dir()), &body.id) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

/// 本机导入：复制进库根后由前端重新扫描（导入本身不触发扫描，保持接口单一职责）。
async fn import_folder(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Json(body): Json<ImportBody>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match import::import_folder(Path::new(&shell.root_dir), Path::new(&body.path), body.subject.as_deref()) {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    }
}

#[derive(Deserialize)]
struct SourceTestBody {
    url: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// 测试一个源：拉前几条看看是什么（RSS 已接；其余明确回未接入）。
async fn source_test(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Json(body): Json<SourceTestBody>,
) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    match datasource::test(body.kind.as_deref().unwrap_or("rss"), &body.url, body.limit.unwrap_or(8)).await {
        Ok(v) => json(StatusCode::OK, v),
        Err(e) => envelope(StatusCode::BAD_GATEWAY, "UPSTREAM", format!("源测试失败：{e}")),
    }
}

async fn entry(State(shell): State<Arc<Shell>>, headers: HeaderMap, AxPath(name): AxPath<String>) -> Response {
    if !authorized(&shell, &headers) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    if !is_safe_name(&name) {
        return envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", format!("非法的作品名：{name}"));
    }
    let dir = Path::new(&shell.root_dir).join(&name);
    if !dir.is_dir() {
        return envelope(StatusCode::NOT_FOUND, "NOT_FOUND", format!("没有这个作品：{name}"));
    }
    json(
        StatusCode::OK,
        serde_json::json!({
            "name": name,
            "dir": dir.to_string_lossy(),
            "episodes": list_episodes(&dir),
        }),
    )
}

async fn fallback() -> Response {
    envelope(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        format!("{SERVICE_NAME} 没有这个端点（这是动漫服务，不是 mangasvc）"),
    )
}

/// 鉴权：共用契约头 `X-Box-Token`，值是**本服务自己的**令牌。
fn authorized(shell: &Shell, headers: &HeaderMap) -> bool {
    headers
        .get("x-box-token")
        .and_then(|v| v.to_str().ok())
        .map(|t| t == shell.token)
        .unwrap_or(false)
}

pub(crate) fn json(status: StatusCode, body: serde_json::Value) -> Response {
    (
        status,
        [("content-type", "application/json; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

pub(crate) fn envelope(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    json(
        status,
        serde_json::json!({ "error": { "code": code, "message": message.into() } }),
    )
}

/// 作品名只能是**单层目录名**：挡住 `..` / 分隔符 / 盘符，避免把 API 变成任意的目录读取口。
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
}

/// 顶层目录统计：`episodes` = 直接子目录数（一集一个目录），`files`/`bytes` = 递归一层合计。
fn stat_entry(dir: &Path) -> (usize, usize, u64) {
    let mut episodes = 0usize;
    let mut files = 0usize;
    let mut bytes = 0u64;
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            episodes += 1;
            for f in fs::read_dir(&p).into_iter().flatten().flatten() {
                let fp = f.path();
                if fp.is_file() {
                    files += 1;
                    bytes += fp.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        } else if p.is_file() {
            files += 1;
            bytes += p.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (episodes, files, bytes)
}

fn list_episodes(dir: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let (_, files, bytes) = stat_entry(&p);
        out.push(serde_json::json!({
            "name": e.file_name().to_string_lossy(),
            "dir": p.to_string_lossy(),
            "files": files,
            "bytes": bytes,
        }));
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    out
}

// 顶层的库扫描已迁到 `manifest::scan`（同一份读写模型），这里不再保留第二份实现。

/// 显式端口优先；否则在 5180–5190 内「先探测再绑定」。
/// 🔴 段内全被占 ⇒ **明确失败**，不静默换到段外（与 mangasvc 同语义）：
///    换到段外会让防火墙规则、运维文档、e2e 的端口预算全部失真。
fn bind_with_probe(explicit: Option<u16>) -> Result<(u16, TcpListener), String> {
    let candidates: Vec<u16> = match explicit {
        Some(p) => vec![p],
        None => (PORT_RANGE_START..=PORT_RANGE_END).collect(),
    };
    let mut last = String::new();
    for port in candidates {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok((port, l)),
            Err(e) => {
                last = format!("{port}: {e}");
                continue;
            }
        }
    }
    let range = match explicit {
        Some(p) => format!("{p}（MIAO_ANIME_PORT 指定）"),
        None => format!("{PORT_RANGE_START}–{PORT_RANGE_END}"),
    };
    Err(format!("端口 {range} 全部被占用，animesvc 启动失败（不静默换到段外）。最后错误：{last}"))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    println!("[anime-service] 收到退出信号，正在关闭");
}
