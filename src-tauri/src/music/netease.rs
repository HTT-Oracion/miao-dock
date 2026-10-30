use std::time::Duration;

use reqwest::header::{COOKIE, REFERER, USER_AGENT};
use serde_json::{json, Value};

use super::crypto::{build_eapi_header, encrypt_eapi_payload, encrypt_weapi_payload};
use super::models::*;

const NETEASE_USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 9; PCT-AL10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.64 HuaweiBrowser/10.0.3.311 Mobile Safari/537.36";
const EAPI_BASE: &str = "https://interface3.music.163.com/eapi";

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("Failed to build HTTP client")
}

/// 发送普通 POST 请求 (带 Cookie, 不加密)
/// 参考 NeteaseCloudMusicApi / Mineradio 的请求方式
async fn post_api(
    client: &reqwest::Client,
    api_path: &str,
    params: &[(&str, &str)],
    cookie: &str,
) -> Result<Value, String> {
    let url = format!("https://music.163.com/api{}", &api_path[4..]); // /api/xxx -> https://music.163.com/api/xxx

    let resp = client
        .post(&url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .form(params)
        .send()
        .await
        .map_err(|e| format!("POST {api_path} failed: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read response: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse JSON from {api_path}: {e}"))
}

/// 发送普通 GET 请求 (带 Cookie, 不加密)
async fn get_api(
    client: &reqwest::Client,
    api_path: &str,
    params: &[(&str, &str)],
    cookie: &str,
) -> Result<Value, String> {
    let url = format!("https://music.163.com/api{}", &api_path[4..]);

    let resp = client
        .get(&url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .query(params)
        .send()
        .await
        .map_err(|e| format!("GET {api_path} failed: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read response: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse JSON from {api_path}: {e}"))
}

/// EAPI 请求结果 (包含 JSON 和 Set-Cookie)
struct EapiResult {
    json: Value,
    cookies: String, // 从 Set-Cookie 头提取的 cookie 字符串
}

/// 发送 EAPI 请求 (捕获 Set-Cookie)
async fn post_eapi_full(
    client: &reqwest::Client,
    api_path: &str,
    payload: serde_json::Map<String, Value>,
    user_cookie: &str,
) -> Result<EapiResult, String> {
    let url = format!("{EAPI_BASE}{}", &api_path[4..]); // 去掉 /api 前缀拼接

    let mut full_payload = payload;
    let header = build_eapi_header();
    full_payload.insert(
        "header".into(),
        Value::String(serde_json::to_string(&header).map_err(|e| e.to_string())?),
    );

    let payload_text = serde_json::to_string(&full_payload).map_err(|e| e.to_string())?;
    let encrypted = encrypt_eapi_payload(api_path, &payload_text)?;

    // 合并 header cookie 和用户 cookie。
    //
    // 🔴 **用户 cookie 必须放在前面**（2026-10-12 实测踩坑）：
    // `build_eapi_header()` 里有一项 `MUSIC_U: ""`，拼在用户 cookie 之前时，
    // 服务端读到的是**空**的 MUSIC_U → 所有需要登录的 eapi 接口一律回
    // `301 需要登录`（`playmode/intelligence/list` 就这么挂的）。
    // 而 eapi 的登录态接口恰恰是"必须带真 MUSIC_U"的那一类。
    // 排序反过来的代价：用户 cookie 缺的项才轮到 header 兜底，语义不变。
    //
    // 另外**跳过空值**：`__csrf=` / `channel=` / `MUSIC_U=` 这类空 cookie
    // 不携带任何信息，只会把同名真值"顶掉"，没有理由发出去。
    let header_cookie = header
        .iter()
        .filter(|(_, v)| !v.as_str().unwrap_or("").is_empty())
        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("; ");

    let full_cookie = if user_cookie.is_empty() {
        header_cookie
    } else if header_cookie.is_empty() {
        user_cookie.to_string()
    } else {
        format!("{user_cookie}; {header_cookie}")
    };

    let resp = client
        .post(&url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, &full_cookie)
        .form(&[("params", encrypted.as_str())])
        .send()
        .await
        .map_err(|e| format!("EAPI request failed: {e}"))?;

    // 提取 Set-Cookie 头中的所有 cookie
    let cookies: Vec<String> = resp
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|s| {
            // 取每条 Set-Cookie 的第一部分 (key=value)
            let part = s.split(';').next()?.trim();
            if part.is_empty() {
                None
            } else {
                Some(part.to_string())
            }
        })
        .collect();
    let cookie_str = cookies.join("; ");

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read EAPI response: {e}"))?;

    let json = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse EAPI response: {e}"))?;

    Ok(EapiResult { json, cookies: cookie_str })
}

/// 发送 EAPI 请求 (仅返回 JSON)
async fn post_eapi(
    client: &reqwest::Client,
    api_path: &str,
    payload: serde_json::Map<String, Value>,
    user_cookie: &str,
) -> Result<Value, String> {
    post_eapi_full(client, api_path, payload, user_cookie)
        .await
        .map(|r| r.json)
}

/// 网易云 weapi 桌面端 User-Agent (参考 NeteaseCloudMusicApi)
const NETEASE_WEAPI_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

/// 发送 weapi 加密请求 (每日推荐歌单等需要 weapi 的接口)
/// /api/v1/xxx -> https://music.163.com/weapi/v1/xxx
async fn post_weapi(
    client: &reqwest::Client,
    api_path: &str,
    payload: serde_json::Map<String, Value>,
    cookie: &str,
) -> Result<Value, String> {
    let url = format!("https://music.163.com/weapi{}", &api_path[4..]);

    let mut full = payload;
    // 从 cookie 提取 csrf_token（点赞/发评论等写操作必须与 cookie 中的 csrf 匹配）
    let cookie_map = super::cookie::parse_cookie_string(cookie);
    let csrf = cookie_map
        .get("__csrf")
        .or_else(|| cookie_map.get("csrf_token"))
        .cloned()
        .unwrap_or_default();
    full.insert("csrf_token".into(), json!(csrf));
    let payload_text = serde_json::to_string(&full)
        .map_err(|e| format!("Failed to serialize weapi payload: {e}"))?;
    let (params, enc_sec_key) = encrypt_weapi_payload(&payload_text);

    let resp = client
        .post(&url)
        .header(USER_AGENT, NETEASE_WEAPI_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .form(&[("params", params.as_str()), ("encSecKey", enc_sec_key.as_str())])
        .send()
        .await
        .map_err(|e| format!("POST {api_path} failed: {e}"))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read weapi response: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse JSON from {api_path}: {e}"))
}

fn map_artists(raw: &[Value]) -> Vec<Artist> {
    raw.iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                None
            } else {
                Some(Artist {
                    id: a
                        .get("id")
                        .and_then(|v| v.as_i64())
                        .map(|n| n.to_string()),
                    mid: a.get("mid").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    name: name.to_string(),
                    pic_url: a
                        .get("picUrl")
                        .or_else(|| a.get("img1v1Url"))
                        .or_else(|| a.get("cover"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    music_size: a.get("musicSize").and_then(|v| v.as_i64()),
                })
            }
        })
        .collect()
}

fn map_song_record(s: &Value) -> Song {
    let artists_raw = s
        .get("ar")
        .or_else(|| s.get("artists"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let artists = map_artists(&artists_raw);

    let album = s.get("al").or_else(|| s.get("album")).unwrap_or(&Value::Null);
    Song {
        provider: "netease".into(),
        id: s.get("id")
            .and_then(|v| v.as_i64())
            .map(|n| n.to_string())
            .or_else(|| s.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_default(),
        mid: None,
        media_mid: None,
        name: s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        artist: artists.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(" / "),
        artists,
        album: album
            .get("name")
            .or_else(|| album.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        cover: album
            .get("picUrl")
            .or_else(|| album.get("coverUrl"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        duration: s
            .get("dt")
            .or_else(|| s.get("duration"))
            .and_then(|v| v.as_i64())
            .map(|n| n as u64)
            .unwrap_or(0),
        fee: s.get("fee").and_then(|v| v.as_i64()).map(|n| n as i32).unwrap_or(0),
        playable: true,
        language: s.get("language").and_then(|v| v.as_i64()).map(|n| n as i32).unwrap_or(0),
        ..Default::default()
    }
}

/// 搜索歌曲
pub async fn search(keywords: &str, limit: u32, offset: u32, cookie: &str) -> Result<Vec<Song>, String> {
    let client = build_client();

    // 参考 NeteaseCloudMusicApi: 用普通 POST 请求 (带 Cookie), 不用 EAPI 加密
    let url = "https://music.163.com/api/cloudsearch/get/web";
    // offset 由调用方给（0 起）。网易云 /cloudsearch 原生支持 offset，
    // 上游实现把它写死为 0，等于放弃了翻页能力（详见 docs/internal/spec-notes.md D-33）。
    let body = format!(
        "s={}&type=1&limit={}&offset={}",
        urlencoding::encode(keywords),
        limit,
        offset
    );

    let resp = client
        .post(url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Search request failed: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read search response: {e}"))?;
    let result: Value = serde_json::from_str(&text).map_err(|e| format!("Failed to parse search JSON: {e}"))?;

    log::info!("[NetEase] search response code={}", result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1));

    let songs = result
        .get("result")
        .and_then(|r| r.get("songs"))
        .and_then(|s| s.as_array())
        .ok_or("No songs in search result")?;

    let mapped: Vec<Song> = songs.iter().map(map_song_record).collect();

    // 补齐缺失封面
    let missing: Vec<String> = mapped
        .iter()
        .filter(|s| s.cover.is_empty())
        .map(|s| s.id.clone())
        .collect();

    if !missing.is_empty() {
        if let Ok(details) = song_detail(&client, &missing, cookie).await {
            let id_to_pic: std::collections::HashMap<String, String> = details
                .iter()
                .map(|s| (s.id.clone(), s.cover.clone()))
                .collect();
            return Ok(mapped
                .iter()
                .map(|s| {
                    if s.cover.is_empty() {
                        Song {
                            cover: id_to_pic.get(&s.id).cloned().unwrap_or_default(),
                            ..s.clone()
                        }
                    } else {
                        s.clone()
                    }
                })
                .collect());
        }
    }

    Ok(mapped)
}

/// 歌曲详情 (批量)
pub async fn song_detail(
    client: &reqwest::Client,
    ids: &[String],
    cookie: &str,
) -> Result<Vec<Song>, String> {
    // 构建 c 参数: [{"id": 123}, {"id": 456}]
    let c_value: Value = Value::Array(
        ids.iter()
            .map(|id| json!({ "id": id.parse::<i64>().unwrap_or(0) }))
            .collect(),
    );
    let c_str = serde_json::to_string(&c_value).unwrap_or_default();

    let result = post_api(client, "/api/v3/song/detail", &[("c", &c_str), ("csrf_token", "")], cookie).await?;

    let songs = result
        .get("songs")
        .and_then(|s| s.as_array())
        .ok_or("No songs in detail result")?;

    Ok(songs.iter().map(map_song_record).collect())
}

/// 获取播放地址 (带音质降级)
pub async fn song_url(id: &str, preferred_quality: &str, cookie: &str) -> Result<SongUrlResult, String> {
    let client = build_client();
    let candidates = quality_candidates_from(preferred_quality);
    let mut trial_fallback: Option<SongUrlResult> = None;

    for q in &candidates {
        let level = q.level.as_str();
        // ids 参数需要 JSON 数组格式: ["12345"]
        let ids_json = format!("[\"{id}\"]");
        let params: [(&str, &str); 4] = [
            ("ids", &ids_json),
            ("level", level),
            ("encodeType", "flac"),
            ("csrf_token", ""),
        ];

        match post_api(&client, "/api/song/enhance/player/url/v1", &params, cookie).await {
            Ok(result) => {
                let data = result
                    .get("data")
                    .and_then(|d| d.as_array())
                    .and_then(|arr| arr.first())
                    .cloned()
                    .unwrap_or(Value::Null);

                let url = data.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let free_trial = data.get("freeTrialInfo").is_some();
                let br = data.get("br").and_then(|b| b.as_u64()).unwrap_or(0);
                let fee = data.get("fee").and_then(|f| f.as_i64()).map(|n| n as i32);

                if !url.is_empty() && !free_trial {
                    return Ok(SongUrlResult {
                        url: Some(url.to_string()),
                        playable: true,
                        trial: false,
                        level: q.level.clone(),
                        quality: q.label.clone(),
                        br,
                        fee,
                        ..Default::default()
                    });
                }

                if !url.is_empty() && free_trial && trial_fallback.is_none() {
                    trial_fallback = Some(SongUrlResult {
                        url: Some(url.to_string()),
                        playable: true,
                        trial: true,
                        level: q.level.clone(),
                        quality: q.label.clone(),
                        br,
                        fee,
                        message: Some("仅试听片段".into()),
                        ..Default::default()
                    });
                }
            }
            Err(_e) => {
                // 继续尝试下一个音质
            }
        }
    }

    if let Some(fallback) = trial_fallback {
        return Ok(fallback);
    }

    Ok(SongUrlResult {
        playable: false,
        reason: Some("url_unavailable".into()),
        message: Some("无法获取播放地址，可能需要登录或 VIP".into()),
        ..Default::default()
    })
}

/// 二维码登录 - 获取 key
pub async fn login_qr_key(cookie: &str) -> Result<String, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("type".into(), json!(1));
    payload.insert("csrf_token".into(), json!(""));

    let result = post_eapi(&client, "/api/login/qrcode/unikey", payload, cookie).await?;
    result
        .get("unikey")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or("Failed to get QR key".into())
}

/// 二维码登录 - 生成二维码 URL
/// 网易云 EAPI 不返回 qrimg，需要用 key 拼接 URL 在前端生成 QR 码
pub async fn login_qr_create(key: &str, _cookie: &str) -> Result<String, String> {
    // 返回扫码登录 URL，前端用 qrcode 库渲染
    Ok(format!("https://music.163.com/login?codekey={key}"))
}

/// 二维码登录 - 检查状态 (捕获 Set-Cookie)
pub async fn login_qr_check(key: &str, cookie: &str) -> Result<QrCheckResult, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("key".into(), json!(key));
    payload.insert("csrf_token".into(), json!(""));

    let eapi_result = post_eapi_full(&client, "/api/login/qrcode/client/login", payload, cookie).await?;
    let result = &eapi_result.json;

    let code = result
        .get("code")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .unwrap_or(0);
    let message = result
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let nickname = result
        .get("nickname")
        .or_else(|| result.get("profile").and_then(|p| p.get("nickname")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let avatar = result
        .get("avatarUrl")
        .or_else(|| result.get("profile").and_then(|p| p.get("avatarUrl")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // code 803 = 登录成功
    // Cookie 在 Set-Cookie 响应头中，不在 JSON body 中
    let extracted_cookie = if code == 803 {
        if !eapi_result.cookies.is_empty() {
            Some(eapi_result.cookies.clone())
        } else {
            // 尝试从 JSON body 提取 (有些版本会返回)
            result
                .get("cookie")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        }
    } else {
        None
    };

    Ok(QrCheckResult {
        code,
        message,
        cookie: extracted_cookie,
        nickname,
        avatar,
    })
}

/// 获取登录状态和用户信息
/// 参考 Mineradio: 用普通 GET 请求 (带 Cookie), 不用 EAPI 加密
pub async fn login_status(cookie: &str) -> Result<LoginInfo, String> {
    if cookie.is_empty() || !super::cookie::netease_cookie_has_login(cookie) {
        return Ok(LoginInfo {
            provider: "netease".into(),
            ..Default::default()
        });
    }

    let client = build_client();

    // 优先用 /api/w/nuser/account/get (GET, 带 Cookie)
    let url = "https://music.163.com/api/w/nuser/account/get";
    let resp = client
        .get(url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .send()
        .await
        .map_err(|e| format!("login_status request failed: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read response: {e}"))?;
    let result: Value = serde_json::from_str(&text).map_err(|e| format!("Failed to parse JSON: {e}"))?;

    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    log::info!("[NetEase] login_status GET response code={code}");

    // 参考 Mineradio: data.profile || body.profile, data.account || body.account
    let data = result.get("data").unwrap_or(&result);
    let profile = data
        .get("profile")
        .or_else(|| result.get("profile"))
        .or_else(|| data.get("account").and_then(|a| a.get("profile")))
        .or_else(|| result.get("account").and_then(|a| a.get("profile")))
        .cloned()
        .unwrap_or(Value::Null);

    if profile.is_null() {
        log::warn!("[NetEase] login_status: profile is null, response: {result}");
        return Ok(LoginInfo {
            provider: "netease".into(),
            logged_in: false,
            ..Default::default()
        });
    }

    // 参考 Mineradio normalizeLoginInfo: userId 必须存在才算登录
    let user_id = profile
        .get("userId")
        .or_else(|| profile.get("user_id"))
        .or_else(|| profile.get("id"))
        .and_then(|v| v.as_i64())
        .map(|n| n.to_string())
        .unwrap_or_default();

    if user_id.is_empty() {
        log::warn!("[NetEase] login_status: no userId in profile, profile: {profile}");
        return Ok(LoginInfo {
            provider: "netease".into(),
            logged_in: false,
            ..Default::default()
        });
    }

    let vip_type = profile
        .get("vipType")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .unwrap_or(0);
    let is_vip = vip_type >= 1;
    let is_svip = vip_type >= 10;

    let nickname = profile
        .get("nickname")
        .or_else(|| profile.get("userName"))
        .and_then(|v| v.as_str())
        .unwrap_or("网易云用户")
        .to_string();

    log::info!("[NetEase] login_status success: userId={user_id}, nickname={nickname}");

    Ok(LoginInfo {
        provider: "netease".into(),
        logged_in: true,
        user_id,
        nickname,
        avatar: profile
            .get("avatarUrl")
            .or_else(|| profile.get("avatar"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        vip_type,
        vip_level: if is_svip {
            "svip".into()
        } else if is_vip {
            "vip".into()
        } else {
            "none".into()
        },
        is_vip,
        is_svip,
    })
}

/// 获取用户歌单
pub async fn user_playlist(uid: &str, cookie: &str) -> Result<Vec<Playlist>, String> {
    let client = build_client();
    // 用 GET 请求, uid 作为 query 参数
    let limit_str = "100".to_string();
    let offset_str = "0".to_string();
    let result = get_api(&client, "/api/user/playlist", &[
        ("uid", uid),
        ("limit", &limit_str),
        ("offset", &offset_str),
        ("csrf_token", ""),
    ], cookie).await?;

    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let keys = result.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default();
    log::info!("[NetEase] user_playlist response code={code}, keys={keys}");

    // 普通 API 可能返回 playlist 数组, 也可能直接是数组
    let playlists = result
        .get("playlist")
        .and_then(|p| p.as_array())
        .or_else(|| result.as_array())
        .ok_or_else(|| format!("No playlist in result, code={code}, keys={keys}"))?;

    Ok(playlists
        .iter()
        .map(|pl| Playlist {
            provider: "netease".into(),
            id: pl.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
            name: pl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            cover: pl.get("coverImgUrl").or_else(|| pl.get("picUrl")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            track_count: pl.get("trackCount").and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(0),
            creator: pl
                .get("creator")
                .and_then(|c| c.get("nickname"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            subscribed: pl.get("subscribed").and_then(|v| v.as_bool()).unwrap_or(false),
        })
        .collect())
}

/// 获取歌单元信息（仅元数据，不加载曲目）
pub async fn playlist_detail(id: &str, cookie: &str) -> Result<Playlist, String> {
    let client = build_client();
    let n_str = "0".to_string();
    let s_str = "0".to_string();
    let detail = post_api(&client, "/api/v6/playlist/detail", &[
        ("id", id),
        ("n", &n_str),
        ("s", &s_str),
        ("csrf_token", ""),
    ], cookie).await?;

    let pl = detail.get("playlist").ok_or("No playlist in result")?;
    Ok(Playlist {
        provider: "netease".into(),
        id: pl.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
        name: pl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        cover: pl.get("coverImgUrl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        track_count: pl.get("trackCount").and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(0),
        creator: pl.get("creator").and_then(|c| c.get("nickname")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ..Default::default()
    })
}

/// 获取歌单元数据 + 全部 trackIds（不加载曲目详情，用于前端分页）
pub async fn playlist_info_with_track_ids(id: &str, cookie: &str) -> Result<(Playlist, Vec<String>), String> {
    let client = build_client();
    let n_str = "1000".to_string();
    let s_str = "0".to_string();
    let detail = post_api(&client, "/api/v6/playlist/detail", &[
        ("id", id),
        ("n", &n_str),
        ("s", &s_str),
        ("csrf_token", ""),
    ], cookie).await?;

    let pl = detail.get("playlist").ok_or("No playlist in result")?;
    let playlist = Playlist {
        provider: "netease".into(),
        id: pl.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
        name: pl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        cover: pl.get("coverImgUrl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        track_count: pl.get("trackCount").and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(0),
        creator: pl.get("creator").and_then(|c| c.get("nickname")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ..Default::default()
    };

    let track_ids: Vec<String> = pl
        .get("trackIds")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.get("id").and_then(|id| id.as_i64()).map(|n| n.to_string()))
        .collect();

    Ok((playlist, track_ids))
}

/// 获取歌单前 50 首曲目
pub async fn playlist_tracks(id: &str, cookie: &str) -> Result<(Playlist, Vec<Song>), String> {
    let (pl, track_ids) = playlist_info_with_track_ids(id, cookie).await?;
    if track_ids.is_empty() {
        return Ok((pl, vec![]));
    }
    let end = 50.min(track_ids.len());
    let client = build_client();
    let songs = song_detail(&client, &track_ids[..end], cookie).await.unwrap_or_default();
    Ok((pl, songs))
}

/// 加载歌单后继续加更多曲目（指定 range）
pub async fn playlist_tracks_range(id: &str, start: usize, count: usize, cookie: &str) -> Result<Vec<Song>, String> {
    let (_, track_ids) = playlist_info_with_track_ids(id, cookie).await?;
    if track_ids.is_empty() || start >= track_ids.len() {
        return Ok(vec![]);
    }
    let client = build_client();
    let end = (start + count).min(track_ids.len());
    let range_ids: Vec<String> = track_ids[start..end].to_vec();
    let songs = song_detail(&client, &range_ids, cookie).await.unwrap_or_default();
    Ok(songs)
}

/// 从用户歌单数组里找出「我喜欢的音乐」的歌单 id。
///
/// 判定顺序**不能改**：`specialType == 5` 是网易云对"喜欢歌单"的稳定约定；
/// 名称匹配只是兜底（用户可把歌单改名，而 specialType 不会跟着变）；
/// `id == uid` 是最后的兜底（喜欢歌单的 id 恰为 uid）。
fn find_liked_playlist_id(playlists: &[Value], uid: &str) -> String {
    playlists
        .iter()
        .find(|pl| {
            pl.get("specialType").and_then(|v| v.as_i64()).unwrap_or(0) == 5
        })
        .or_else(|| {
            playlists.iter().find(|pl| {
                let name = pl.get("name").and_then(|v| v.as_str()).unwrap_or("");
                name == "我喜欢的音乐" || name.contains("喜欢")
            })
        })
        .or_else(|| {
            // 兜底：用 uid 作为歌单 id
            playlists.iter().find(|pl| {
                pl.get("id")
                    .and_then(|v| v.as_i64())
                    .map(|n| n.to_string() == uid)
                    .unwrap_or(false)
            })
        })
        .and_then(|pl| pl.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()))
        .unwrap_or_else(|| uid.to_string())
}

/// 获取喜欢列表 — 优先从"我喜欢的音乐"歌单取 trackIds
pub async fn likelist(uid: &str, cookie: &str) -> Result<Vec<String>, String> {
    let client = build_client();

    // 1. 获取用户歌单，找到"我喜欢的音乐"（特殊歌单，id 格式为 uid）
    let limit_str = "200".to_string();
    let offset_str = "0".to_string();
    let pl_result = get_api(&client, "/api/user/playlist", &[
        ("uid", uid),
        ("limit", &limit_str),
        ("offset", &offset_str),
        ("csrf_token", ""),
    ], cookie).await?;

    let playlists = pl_result
        .get("playlist")
        .and_then(|p| p.as_array())
        .ok_or("No playlists in result")?;

    let liked_id = find_liked_playlist_id(playlists, uid);

    log::info!("[NetEase] liked playlist id: {liked_id}");

    // 2. 获取歌单详情取 trackIds（仅元数据，不加载曲目详情）
    let detail = post_api(&client, "/api/v6/playlist/detail", &[
        ("id", &liked_id),
        ("n", "0"),
        ("s", "0"),
        ("csrf_token", ""),
    ], cookie).await?;

    let pl = detail.get("playlist").ok_or("No playlist in detail")?;
    let ids: Vec<String> = pl
        .get("trackIds")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| {
            v.get("id").and_then(|id| id.as_i64()).map(|n| n.to_string())
        })
        .collect();

    log::info!("[NetEase] likelist loaded {} songs from playlist", ids.len());
    Ok(ids)
}

/// 红心/取消红心
pub async fn like(id: &str, like: bool, cookie: &str) -> Result<(), String> {
    let client = build_client();
    let like_str = if like { "true" } else { "false" };
    let result = post_api(&client, "/api/song/like", &[
        ("trackId", id),
        ("like", like_str),
        ("csrf_token", ""),
    ], cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    if code == 200 {
        Ok(())
    } else {
        Err(format!("Like failed with code: {code}"))
    }
}

/// 收藏/取消收藏歌单
pub async fn playlist_subscribe(id: &str, subscribe: bool, cookie: &str) -> Result<(), String> {
    let client = build_client();
    let csrf = super::cookie::parse_cookie_string(cookie)
        .get("__csrf")
        .cloned()
        .unwrap_or_default();
    let api = if subscribe { "/api/playlist/subscribe" } else { "/api/playlist/unsubscribe" };
    let result = post_api(&client, api, &[
        ("id", id),
        ("csrf_token", &csrf),
    ], cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    if code == 200 {
        Ok(())
    } else {
        Err(format!("Playlist subscribe failed with code: {code}"))
    }
}

/// 获取歌词
pub async fn lyric(id: &str, cookie: &str) -> Result<Lyrics, String> {
    let client = build_client();
    let result = post_api(&client, "/api/song/lyric/v1", &[
        ("id", id),
        ("cp", "false"),
        ("lv", "0"),
        ("kv", "0"),
        ("tv", "0"),
        ("rv", "0"),
        ("yv", "0"),
        ("ytv", "0"),
        ("yrv", "0"),
        ("csrf_token", ""),
    ], cookie).await?;

    let lyric = result
        .get("lrc")
        .and_then(|l| l.get("lyric"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let translation = result
        .get("tlyric")
        .and_then(|l| l.get("lyric"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let roma = result
        .get("romalrc")
        .and_then(|l| l.get("lyric"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let yrc = result
        .get("yrc")
        .and_then(|l| l.get("lyric"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    Ok(Lyrics {
        lyric,
        translation,
        roma,
        yrc,
    })
}

/// 推荐歌单
pub async fn personalized(cookie: &str) -> Result<Vec<Playlist>, String> {
    let client = build_client();
    let limit_str = "30".to_string();
    let result = post_api(&client, "/api/personalized/playlist", &[
        ("limit", &limit_str),
        ("csrf_token", ""),
    ], cookie).await?;

    let playlists = result.get("result").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(playlists
        .iter()
        .map(|pl| Playlist {
            provider: "netease".into(),
            id: pl.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
            name: pl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            cover: pl.get("picUrl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            track_count: pl.get("trackCount")
                .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)).or_else(|| v.as_f64().map(|n| n as u64)))
                .map(|n| n as u32)
                .unwrap_or(0),
            creator: pl.get("creator").and_then(|c| c.get("nickname")).and_then(|v| v.as_str())
                .or_else(|| pl.get("copywriter").and_then(|v| v.as_str()))
                .unwrap_or("").to_string(),
            ..Default::default()
        })
        .collect())
}

/// 推荐新歌（`/personalized/newsong`，**不需要登录**）
///
/// 与「每日推荐」的区别：每日推荐是**按账号口味**的（要 cookie、每天一份），
/// 这里是**平台级的新歌池**（匿名可取）—— 首页「今日精选」要的是后者：
/// 没登录的用户也该看到"今天有什么可听的"。
///
/// 响应形状与普通歌曲记录不同：每一项是 `{ id, name, picUrl, song }`，真正的歌曲对象在
/// `song` 里；`picUrl` 在外层（推荐位封面），内层 album 常常没有封面 —— 所以要把外层
/// `picUrl` 补进 `al.picUrl`，否则整列歌曲会没有封面。
pub async fn new_songs(cookie: &str, limit: u32) -> Result<Vec<Song>, String> {
    let client = build_client();
    let limit_s = limit.to_string();
    let result = get_api(
        &client,
        "/api/personalized/newsong",
        &[("limit", limit_s.as_str()), ("csrf_token", "")],
        cookie,
    )
    .await?;

    let items = result
        .get("result")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut songs: Vec<Song> = items
        .iter()
        .filter_map(|item| {
            let mut song = item.get("song").cloned().unwrap_or_else(|| item.clone());
            // 没有歌名的条目直接丢：那是"广告位"或残缺记录，渲染出来是一行空行
            song.get("name")?;
            if let Some(pic) = item.get("picUrl").and_then(|v| v.as_str()) {
                if !pic.is_empty() {
                    if let Some(obj) = song.as_object_mut() {
                        let al = obj.entry("al").or_insert_with(|| serde_json::json!({}));
                        if let Some(al_obj) = al.as_object_mut() {
                            al_obj
                                .entry("picUrl")
                                .or_insert_with(|| serde_json::Value::String(pic.to_string()));
                        }
                    }
                }
            }
            Some(map_song_record(&song))
        })
        .collect();

    /*
     * **补专辑名**：`/api/personalized/newsong` 的 `song` 对象里 `al` 往往只有
     * `id` / `picUrl`，没有 `name` —— 于是「今日精选」那一列专辑会全是「—」。
     * 这里对缺专辑名的那些 id 补一次 `song/detail`（批量，一次请求），
     * 用返回的 `al.name` 填回去。拿不到就保持空（前端显示「—」，不编造）。
     */
    let missing: Vec<String> = songs
        .iter()
        .filter(|s| s.album.is_empty() && !s.id.is_empty())
        .map(|s| s.id.clone())
        .collect();
    if !missing.is_empty() {
        let ids_json = format!(
            "[{}]",
            missing
                .iter()
                .map(|id| format!("{{\"id\":\"{id}\"}}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        if let Ok(detail) = post_api(
            &client,
            "/api/v3/song/detail",
            &[("c", ids_json.as_str()), ("csrf_token", "")],
            cookie,
        )
        .await
        {
            let by_id: std::collections::HashMap<String, String> = detail
                .get("songs")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| {
                            let id = s.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string())?;
                            let name = s
                                .get("al")
                                .and_then(|al| al.get("name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if name.is_empty() {
                                None
                            } else {
                                Some((id, name.to_string()))
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            for s in songs.iter_mut() {
                if s.album.is_empty() {
                    if let Some(name) = by_id.get(&s.id) {
                        s.album = name.clone();
                    }
                }
            }
        }
    }

    Ok(songs)
}

/// 每日推荐歌曲
pub async fn recommend_songs(cookie: &str) -> Result<Vec<Song>, String> {
    let client = build_client();
    let result = get_api(&client, "/api/v3/discovery/recommend/songs", &[
        ("csrf_token", ""),
    ], cookie).await?;

    let songs = result
        .get("data")
        .and_then(|d| d.get("dailySongs"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(songs.iter().map(map_song_record).collect())
}

/// 每日推荐歌单 (recommend/resource, weapi 加密)
/// 返回当天为用户推荐的歌单列表，需要登录态 cookie
pub async fn recommend_resource(cookie: &str) -> Result<Vec<Playlist>, String> {
    let client = build_client();
    let result = post_weapi(
        &client,
        "/api/v1/discovery/recommend/resource",
        serde_json::Map::new(),
        cookie,
    ).await?;

    let playlists = result.get("recommend").and_then(|v| v.as_array()).cloned()
        .or_else(|| result.get("data").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();

    Ok(playlists
        .iter()
        .filter_map(|pl| {
            let id = pl.get("id").and_then(|v| v.as_i64())
                .or_else(|| pl.get("resourceId").and_then(|v| v.as_i64()))
                .map(|n| n.to_string())
                .unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            // creator 可能是字符串，也可能是 { nickname } 对象
            let creator = pl.get("creator").map(|c| {
                if let Some(s) = c.as_str() {
                    s.to_string()
                } else if let Some(nick) = c.get("nickname").and_then(|v| v.as_str()) {
                    nick.to_string()
                } else if let Some(copy) = c.get("copywriter").and_then(|v| v.as_str()) {
                    copy.to_string()
                } else {
                    String::new()
                }
            }).unwrap_or_default();
            Some(Playlist {
                provider: "netease".into(),
                id,
                name: pl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                cover: pl.get("picUrl").and_then(|v| v.as_str())
                    .or_else(|| pl.get("coverImgUrl").and_then(|v| v.as_str()))
                    .unwrap_or("").to_string(),
                track_count: pl.get("trackCount")
                    .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)).or_else(|| v.as_f64().map(|n| n as u64)))
                    .map(|n| n as u32)
                    .unwrap_or(0),
                creator,
                ..Default::default()
            })
        })
        .collect())
}

/// 相似歌曲 (心动模式核心, 参考 NeteaseCloudMusicApi simi/song: /weapi/v1/discovery/simiSong)
/// 根据当前歌曲 id 返回口味相似的歌曲, 用于心跳模式动态续播
pub async fn simi_song(id: &str, limit: u32, cookie: &str) -> Result<Vec<Song>, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("songid".into(), json!(id));
    payload.insert("limit".into(), json!(limit));
    payload.insert("offset".into(), json!(0));

    let result = post_weapi(&client, "/api/v1/discovery/simiSong", payload, cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("simi_song failed: code={code}"));
    }

    let songs = result
        .get("songs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(songs.iter().map(map_song_record).collect())
}

// ============================================================
//  请求缓存（心动模式相关）
// ============================================================
//
// 为什么需要缓存，两个接口各有一个"不缓存就纯浪费"的理由：
//
// ① `intelligence_list`：实测同一个 (songId, pid) 重复请求返回**完全相同**的
//    149 条（overlap 149/149）。而心动模式的 `next()` 走到队尾会换一批种子
//    再请求、用户反复进/出心动模式也会重复请求同一个种子 —— 不缓存就是
//    每次都白打一次 ~500ms 的网络往返。
// ② `liked_playlist_id`：intelligence_list 的 `pid` 只能从
//    `login_status` + `user_playlist` 两个 HTTP 请求解出来。不缓存的话，
//    每进一次心动模式都要多打两发。
//
// 设计约束：
// - **只缓存成功结果**：失败的请求不进缓存，否则一次网络抖动会被"记住"一整段 TTL。
// - **key 带身份信息**：intelligence 的 key 含 pid（pid 由 MUSIC_U 推导），
//   liked_playlist_id 的 key 含 MUSIC_U —— 重新登录 / 登出后 key 自然变，
//   不会把上一个账号的歌单 id 复用给下一个账号。
// - **过期条目在 put 时顺带淘汰**：`retain` 一次 O(n)，n 是缓存条数（上限
//   由 TTL + 换种子频率决定，量级在几十条），不做后台定时清理任务。

/// 缓存条目：数据 + 写入时刻 + 该条目自己的 TTL
struct CacheEntry<T> {
    value: T,
    at: std::time::Instant,
    ttl: Duration,
}

/// 带 TTL 的进程内缓存（`Mutex<HashMap>`，临界区极短、绝不在持锁时 await）
type TtlCache<T> = std::sync::Mutex<std::collections::HashMap<String, CacheEntry<T>>>;

/// 取未过期条目；不存在或已过期都返回 `None`。
fn cache_get<T: Clone>(map: &TtlCache<T>, key: &str) -> Option<T> {
    // 锁中毒说明有线程在临界区内 panic 了 —— HashMap 本身仍是完好的，
    // 直接复用而不是把后续所有请求一起带崩（缓存不是关键路径）。
    let guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get(key)
        .filter(|e| e.at.elapsed() < e.ttl)
        .map(|e| e.value.clone())
}

/// 写入条目，并顺带淘汰所有已过期条目（防止切很多歌时缓存无限增长）。
fn cache_put<T: Clone>(map: &TtlCache<T>, key: String, value: T, ttl: Duration) {
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|_, e| e.at.elapsed() < e.ttl);
    guard.insert(
        key,
        CacheEntry {
            value,
            at: std::time::Instant::now(),
            ttl,
        },
    );
}

/// 智能播放结果缓存有效期。
/// 5 分钟：短于"用户切走再切回来"的间隔，又足够让一次心动队列播到换批。
const INTEL_CACHE_TTL: Duration = Duration::from_secs(300);

/// 「我喜欢的音乐」歌单 id 缓存有效期。
/// 30 分钟：这个 id 几乎不会变（用户改名/重建喜欢歌单是极低频操作），
/// 而它每进一次心动模式都要用，给长一些直接省掉两发 HTTP。
const LIKED_PID_CACHE_TTL: Duration = Duration::from_secs(1800);

static INTEL_CACHE: std::sync::OnceLock<TtlCache<Vec<Song>>> = std::sync::OnceLock::new();
static LIKED_PID_CACHE: std::sync::OnceLock<TtlCache<String>> = std::sync::OnceLock::new();

fn intel_cache() -> &'static TtlCache<Vec<Song>> {
    INTEL_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn liked_pid_cache() -> &'static TtlCache<String> {
    LIKED_PID_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 本模块覆盖**上面**的缓存三件套（cache_get / cache_put / TTL）与
/// **下面**的 `find_liked_playlist_id` / `intelligence_list` —— 故意放在这里
/// 而不是文件末尾：被测的纯函数就近可见，`intelligence_live` 也在本模块内。
#[cfg(test)]
mod intelligence_tests {
    use super::*;
    use serde_json::json;

    fn pl(id: i64, name: &str, special: i64) -> Value {
        json!({ "id": id, "name": name, "specialType": special })
    }

    /// `specialType == 5` 是稳定约定，必须优先于名称匹配。
    /// 反证点：若把 specialType 判定删掉，用户把喜欢歌单改名后就会取错。
    #[test]
    fn liked_pid_prefers_special_type_over_name() {
        let list = vec![pl(111, "我喜欢", 0), pl(222, "我喜欢的音乐", 5)];
        assert_eq!(find_liked_playlist_id(&list, "111"), "222");
    }

    /// 名称兜底：没有 specialType=5 时（极少数账号/旧数据），按名称匹配。
    #[test]
    fn liked_pid_falls_back_to_name() {
        let list = vec![pl(111, "随便建的", 0), pl(333, "我喜欢的音乐", 0)];
        assert_eq!(find_liked_playlist_id(&list, "111"), "333");
    }

    /// uid 兜底：名称也匹配不到时，用 uid 本身（喜欢歌单 id 恰为 uid）。
    #[test]
    fn liked_pid_falls_back_to_uid() {
        let list = vec![pl(111, "随便建的", 0)];
        assert_eq!(find_liked_playlist_id(&list, "999"), "999");
    }

    /// 缓存命中：同 key 第二次取到的是同一份数据。
    #[test]
    fn cache_roundtrip() {
        let map: TtlCache<String> = std::sync::Mutex::new(std::collections::HashMap::new());
        cache_put(&map, "k".into(), "v".into(), INTEL_CACHE_TTL);
        assert_eq!(cache_get(&map, "k"), Some("v".to_string()));
        // 没写过的 key 不能凭空命中
        assert_eq!(cache_get(&map, "nope"), None);
    }

    /// TTL 过期必须取不到 —— 否则换了一批种子还拿旧列表。
    /// ttl=0 表示"写入即过期"，无需 sleep。
    #[test]
    fn cache_expires() {
        let map: TtlCache<String> = std::sync::Mutex::new(std::collections::HashMap::new());
        cache_put(&map, "k".into(), "v".into(), Duration::ZERO);
        assert_eq!(cache_get(&map, "k"), None);
    }

    /// 过期条目要在 put 时被淘汰 —— 否则切很多歌时缓存无限增长。
    #[test]
    fn cache_evicts_stale_on_put() {
        let map: TtlCache<String> = std::sync::Mutex::new(std::collections::HashMap::new());
        cache_put(&map, "stale".into(), "x".into(), Duration::ZERO);
        cache_put(&map, "fresh".into(), "y".into(), INTEL_CACHE_TTL);
        assert_eq!(cache_get(&map, "fresh"), Some("y".to_string()));
        let guard = map.lock().unwrap();
        assert!(!guard.contains_key("stale"), "过期条目未被淘汰");
        assert_eq!(guard.len(), 1);
    }
}

/// 真联调：拿真实 cookie 打一次 `intelligence_list`，验证 eapi 加密路径 +
/// `data[].songInfo` 解析 + 缓存命中。
///
/// **默认 ignore**（打真实网络、依赖本机登录态）。跑法：
/// ```text
/// set MIAO_NETEASE_COOKIE=C:\Users\<你>\AppData\Roaming\com.miaodock.desktop\music-cookies.json
/// cargo test --bin miao-dock intelligence_live -- --ignored --nocapture
/// ```
/// cookie 文件就是 miao-dock 自己落盘的那份（`{ cookie_netease: "..." }`），
/// 不需要另找登录态。
#[tokio::test]
#[ignore = "打真实网络并依赖本机登录态，手工跑"]
async fn intelligence_live() {
    let cookie_file = match std::env::var("MIAO_NETEASE_COOKIE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("skip: 未设 MIAO_NETEASE_COOKIE");
            return;
        }
    };
    let raw = std::fs::read_to_string(&cookie_file).expect("cookie 文件应可读");
    let cookie: String = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("cookie_netease")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or(raw);
    let cookie = super::cookie::normalize_cookie_header(&cookie);

    // 种子用真实数据（我喜欢的音乐里的曲子）；换任意歌曲 id 都行
    let song_id = "2087669501";
    let first = intelligence_list(song_id, &cookie)
        .await
        .expect("intelligence_list 应成功（未登录会在这里失败）");
    assert!(!first.is_empty(), "应返回非空歌曲列表");
    assert!(
        first.iter().all(|s| !s.id.is_empty()),
        "不应出现 id 为空的脏条目（songInfo 判空失效）"
    );
    assert!(
        first.iter().any(|s| s.id != song_id),
        "返回里应有种子之外的歌"
    );
    println!("intelligence_list: {} songs", first.len());

    // 第二次必须走缓存：同 key 命中，条数一致
    let second = intelligence_list(song_id, &cookie).await.unwrap();
    assert_eq!(first.len(), second.len(), "缓存命中应返回同一批");

    // 🔴 直接验缓存**真的被写了**：只比"两次条数一样"是不够的 ——
    // 万一带缓存的代码没接上，两次都打网络也会拿到同样的 149 条，断言照绿。
    // 这里直接查缓存 map 里有没有这条 key（key = song_id|pid）。
    let pid = liked_playlist_id(&cookie).await.expect("应能定位喜欢歌单");
    assert!(
        cache_get(intel_cache(), &format!("{song_id}|{pid}")).is_some(),
        "intelligence_list 的结果应写入缓存"
    );
    assert!(
        cache_get(liked_pid_cache(), &format!(
            "likedPid:{}",
            super::cookie::parse_cookie_string(&cookie)
                .get("MUSIC_U")
                .cloned()
                .unwrap_or_default()
        ))
        .is_some(),
        "liked_playlist_id 应写入缓存"
    );
    println!("cache: hit (pid={pid})");

    // 顺带验公开 eapi 接口没被 cookie 排序改动打坏
    // （artist_songs 是 eapi，且不依赖登录态 —— 改坏了它说明回归）
    let songs = artist_songs("6452", 10, 0, &cookie)
        .await
        .expect("artist_songs 应仍然可用");
    assert!(!songs.is_empty(), "artist_songs 不应返回空");
    println!("artist_songs: {} songs (回归检查)", songs.len());
}

/// 「我喜欢的音乐」歌单 id（智能播放接口的 `pid` 唯一合法取值）。
///
/// 为什么不让前端传：`pid` 的约束（只能是喜欢歌单，见 `intelligence_list`）
/// 是上游的隐性规则，前端拿到的 `leftPlaylistMeta.id` 只是"当前打开的歌单"，
/// 心跳模式里它恰好是喜欢歌单，但把这个巧合固化成接口契约迟早出错。
/// 由 Rust 侧自己解析 + 缓存，前端零成本。
///
/// 需要两个 HTTP 请求（`login_status` 拿 uid → `user_playlist` 拿歌单数组），
/// 所以必须带缓存，见本文件「请求缓存」节的说明 ②。
async fn liked_playlist_id(cookie: &str) -> Result<String, String> {
    // key 用 cookie 里的 MUSIC_U：账号切换 / 重新登录后 key 自然变，
    // 不会把上一个号的喜欢歌单 id 复用给下一个号。
    let cache_key = format!(
        "likedPid:{}",
        super::cookie::parse_cookie_string(cookie)
            .get("MUSIC_U")
            .cloned()
            .unwrap_or_default()
    );
    if let Some(hit) = cache_get(liked_pid_cache(), &cache_key) {
        return Ok(hit);
    }

    let info = login_status(cookie).await?;
    if !info.logged_in || info.user_id.is_empty() {
        return Err("未登录，无法定位「我喜欢的音乐」歌单".into());
    }

    let client = build_client();
    let limit_str = "200".to_string();
    let offset_str = "0".to_string();
    let pl_result = get_api(
        &client,
        "/api/user/playlist",
        &[
            ("uid", info.user_id.as_str()),
            ("limit", &limit_str),
            ("offset", &offset_str),
            ("csrf_token", ""),
        ],
        cookie,
    )
    .await?;

    let playlists = pl_result
        .get("playlist")
        .and_then(|p| p.as_array())
        .ok_or("No playlists in result")?;

    let pid = find_liked_playlist_id(playlists, &info.user_id);
    log::info!("[NetEase] liked playlist id resolved: {pid}");
    cache_put(liked_pid_cache(), cache_key, pid.clone(), LIKED_PID_CACHE_TTL);
    Ok(pid)
}

/// 智能播放（心动模式）—— 网易云官方 `/api/playmode/intelligence/list`。
///
/// **与 `simi_song` 的分工**（实测于 2026-10-12，账号 uid 83700187）：
/// - `simi_song`（weapi `/api/v1/discovery/simiSong`）：单次**硬顶 5 条**，
///   `limit` / `offset` 传什么都不管用，但**不需要登录**；
/// - 本接口（eapi）：单次 **149 条**，是网易云客户端「心动模式」真正用的接口。
///
/// 本接口的四个上游约束（都是实测踩出来的，改代码前必读）：
/// 1. **必须登录** —— 不带 cookie 返回 `301 需要登录`；
/// 2. **`pid` 必传且只能是「我喜欢的音乐」** —— 自建歌单 / 年度歌单 /
///    官方榜单全部 `400 不支持该歌单类型`。这与前端 `canUseHeartbeat` 的
///    「网易云 + 队列来自喜欢歌单」语义天然对齐；
/// 3. **`count` 无效** —— 传 1 和传 10 都是 149，别指望调大它；
/// 4. **不可累积** —— 同一 (songId, pid) 重复请求返回完全相同的 149 条，
///    想换一批只能换种子。这正是上面要加缓存的原因：命中即省一次请求。
///
/// 返回结构是 `{ id, alg, recommended, songInfo }`，**`songInfo` 可能为 null**
/// （实测 149 条里有 5 条）—— 不判空会把空曲目塞进队列，播放时才发现播不了。
pub async fn intelligence_list(song_id: &str, cookie: &str) -> Result<Vec<Song>, String> {
    let pid = liked_playlist_id(cookie).await?;
    let cache_key = format!("{song_id}|{pid}");

    if let Some(hit) = cache_get(intel_cache(), &cache_key) {
        log::info!("[NetEase] intelligence_list cache hit: song={song_id} ({} songs)", hit.len());
        return Ok(hit);
    }

    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("songId".into(), json!(song_id));
    payload.insert("type".into(), json!("fromPlayOne"));
    payload.insert("playlistId".into(), json!(pid));
    payload.insert("startMusicId".into(), json!(song_id));
    // count 上游忽略（约束 3），传 1 只为占位
    payload.insert("count".into(), json!(1));

    let result = post_eapi(
        &client,
        "/api/playmode/intelligence/list",
        payload,
        cookie,
    )
    .await?;

    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("intelligence_list failed: code={code}"));
    }

    let data = result
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // songInfo 非 null 才算一条有效歌曲；id 为空的是脏数据，一并滤掉
    let songs: Vec<Song> = data
        .iter()
        .filter_map(|item| item.get("songInfo").filter(|v| !v.is_null()))
        .map(|info| map_song_record(info))
        .filter(|s| !s.id.is_empty())
        .collect();

    log::info!(
        "[NetEase] intelligence_list: song={song_id} pid={pid} raw={} usable={}",
        data.len(),
        songs.len()
    );

    cache_put(intel_cache(), cache_key, songs.clone(), INTEL_CACHE_TTL);
    Ok(songs)
}
/// 搜索歌单 (使用 cloudsearch type=1000)
pub async fn playlist_search(keywords: &str, limit: u32, cookie: &str) -> Result<Vec<Playlist>, String> {
    let client = build_client();
    let url = "https://music.163.com/api/cloudsearch/get/web";
    let body = format!(
        "s={}&type=1000&limit={}&offset=0",
        urlencoding::encode(keywords),
        limit
    );

    let resp = client
        .post(url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Playlist search request failed: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read playlist search response: {e}"))?;
    let result: Value = serde_json::from_str(&text).map_err(|e| format!("Failed to parse playlist search JSON: {e}"))?;

    log::info!("[NetEase] playlist_search response code={}", result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1));

    let playlists_raw = result
        .get("result")
        .and_then(|r| r.get("playlists"))
        .and_then(|a| a.as_array())
        .ok_or("No playlists in search result")?;

    let playlists: Vec<Playlist> = playlists_raw
        .iter()
        .map(|pl| Playlist {
            provider: "netease".into(),
            id: pl.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
            name: pl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            cover: pl.get("coverImgUrl").or_else(|| pl.get("picUrl")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            track_count: pl.get("trackCount")
                .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)).or_else(|| v.as_f64().map(|n| n as u64)))
                .map(|n| n as u32)
                .unwrap_or(0),
            creator: pl
                .get("creator")
                .and_then(|c| c.get("nickname"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            ..Default::default()
        })
        .collect();

    Ok(playlists)
}

/// 搜索歌手 (使用 cloudsearch type=100)
pub async fn artist_search(keywords: &str, limit: u32, cookie: &str) -> Result<Vec<Artist>, String> {
    let client = build_client();
    let url = "https://music.163.com/api/cloudsearch/get/web";
    let body = format!(
        "s={}&type=100&limit={}&offset=0",
        urlencoding::encode(keywords),
        limit
    );

    let resp = client
        .post(url)
        .header(USER_AGENT, NETEASE_USER_AGENT)
        .header(REFERER, "https://music.163.com/")
        .header(COOKIE, cookie)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Artist search request failed: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read artist search response: {e}"))?;
    let result: Value = serde_json::from_str(&text).map_err(|e| format!("Failed to parse artist search JSON: {e}"))?;

    log::info!("[NetEase] artist_search response code={}", result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1));

    let artists_raw = result
        .get("result")
        .and_then(|r| r.get("artists"))
        .and_then(|a| a.as_array())
        .ok_or("No artists in search result")?;

    let artists = map_artists(artists_raw);

    Ok(artists)
}

/// 获取歌手热门歌曲（参考 Mineradio：先用 EAPI artist/songs，失败回退 artist/top/song）
pub async fn artist_songs(
    artist_id: &str,
    limit: u32,
    offset: u32,
    cookie: &str,
) -> Result<Vec<Song>, String> {
    let client = build_client();

    // 主策略：EAPI POST /api/artist/songs
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!(artist_id));
    payload.insert("limit".into(), json!(limit));
    payload.insert("offset".into(), json!(offset));
    payload.insert("order".into(), json!("hot"));

    let result = post_eapi(&client, "/api/artist/songs", payload, cookie).await?;
    log::info!("[NetEase] artist_songs EAPI response code={}", result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1));

    let songs_raw = result
        .get("songs")
        .or_else(|| result.get("data").and_then(|d| d.get("songs")))
        .or_else(|| result.get("hotSongs"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    // 回退策略：如果 artist/songs 返回空，尝试 artist/top/song
    let songs_raw = if songs_raw.is_empty() {
        log::info!("[NetEase] artist_songs empty, trying artist/top/song fallback");
        let mut fallback_payload = serde_json::Map::new();
        fallback_payload.insert("id".into(), json!(artist_id));

        match post_eapi(&client, "/api/artist/top/song", fallback_payload, cookie).await {
            Ok(fb) => {
                log::info!("[NetEase] artist/top/song response code={}", fb.get("code").and_then(|v| v.as_i64()).unwrap_or(-1));
                fb.get("songs")
                    .or_else(|| fb.get("data").and_then(|d| d.get("songs")))
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default()
            }
            Err(e) => {
                log::warn!("[NetEase] artist/top/song fallback failed: {e}");
                vec![]
            }
        }
    } else {
        songs_raw
    };

    if songs_raw.is_empty() {
        return Err("No songs in artist result".into());
    }

    let mut mapped: Vec<Song> = songs_raw.iter().map(map_song_record).collect();

    // 歌手歌曲 API 返回的歌曲可能缺少封面，用 song_detail 补齐
    let missing: Vec<String> = mapped
        .iter()
        .filter(|s| s.cover.is_empty())
        .map(|s| s.id.clone())
        .collect();

    if !missing.is_empty() {
        if let Ok(details) = song_detail(&client, &missing, cookie).await {
            let id_to_pic: std::collections::HashMap<String, String> = details
                .iter()
                .map(|s| (s.id.clone(), s.cover.clone()))
                .collect();
            mapped = mapped
                .iter()
                .map(|s| {
                    if s.cover.is_empty() {
                        Song {
                            cover: id_to_pic.get(&s.id).cloned().unwrap_or_default(),
                            ..s.clone()
                        }
                    } else {
                        s.clone()
                    }
                })
                .collect();
        }
    }

    Ok(mapped)
}

// ═══════════════════════════════════════════════════════
//  评论系统 (参考 NeteaseCloudMusicApi)
// ═══════════════════════════════════════════════════════

/// 解析单条评论（含 beReplied 回复拼接）
fn map_comment(c: &Value) -> Comment {
    let user = c.get("user").unwrap_or(&Value::Null);
    let content = c.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let reply = c
        .get("beReplied")
        .and_then(|b| b.as_array())
        .and_then(|arr| arr.first())
        .and_then(|r| r.get("content"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let final_content = if reply.is_empty() { content } else { format!("{content} // 回复: {reply}") };

    Comment {
        comment_id: c.get("commentId").and_then(|v| v.as_i64()).unwrap_or(0),
        content: final_content,
        time: c.get("time").and_then(|v| v.as_i64()).unwrap_or(0),
        liked_count: c.get("likedCount").and_then(|v| v.as_i64()).unwrap_or(0),
        liked: c.get("liked").and_then(|v| v.as_bool()).unwrap_or(false),
        user_id: user.get("userId").and_then(|v| v.as_i64()).unwrap_or(0),
        nickname: user.get("nickname").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        avatar: user.get("avatarUrl").or_else(|| user.get("avatar")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
    }
}

/// 获取歌曲评论（分页，需登录获取完整列表）
pub async fn song_comments(id: &str, page: u32, page_size: u32, cookie: &str) -> Result<CommentPage, String> {
    let client = build_client();
    let offset = page.saturating_sub(1) * page_size;

    let mut payload = serde_json::Map::new();
    payload.insert("rid".into(), json!(id));
    payload.insert("limit".into(), json!(page_size));
    payload.insert("offset".into(), json!(offset));

    let api_path = format!("/api/v1/resource/comments/R_SO_4_{id}");
    let result = post_weapi(&client, &api_path, payload, cookie).await?;

    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    log::info!("[NetEase] song_comments id={id} code={code} total={}", result.get("total").and_then(|v| v.as_i64()).unwrap_or(-1));
    if code != 200 {
        return Err(format!("song_comments failed: code={code}, msg={}", result.get("message").and_then(|v| v.as_str()).unwrap_or("")));
    }

    let total = result.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let comments: Vec<Comment> = result
        .get("comments")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(map_comment)
        .collect();
    let hot_comments: Vec<Comment> = result
        .get("hotComments")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(map_comment)
        .collect();

    let loaded = comments.len() as i64 + hot_comments.len() as i64;
    let has_more = (offset as i64 + page_size as i64) < total && loaded >= page_size as i64;

    Ok(CommentPage {
        total,
        has_more,
        comments,
        hot_comments,
    })
}

/// 发表评论（需登录）
pub async fn send_comment(id: &str, content: &str, cookie: &str) -> Result<(), String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("threadId".into(), json!(format!("R_SO_4_{id}")));
    payload.insert("content".into(), json!(content));

    let result = post_weapi(&client, "/api/resource/comments/add", payload, cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code == 200 {
        Ok(())
    } else {
        let msg = result.get("message").and_then(|v| v.as_str()).unwrap_or("unknown error");
        Err(format!("send_comment failed: code={code}, msg={msg}"))
    }
}

// ═══════════════════════════════════════════════════════
//  歌手扩展: 简介 / 专辑 / MV / 专辑详情
// ═══════════════════════════════════════════════════════

/// 获取歌手简介 (参考 NeteaseCloudMusicApi artist_desc: /api/artist/introduction)
pub async fn artist_detail(id: &str, cookie: &str) -> Result<ArtistDetail, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!(id));

    let result = post_weapi(&client, "/api/artist/introduction", payload, cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("artist_detail failed: code={code}"));
    }

    let artist = result.get("artist").unwrap_or(&Value::Null);
    Ok(ArtistDetail {
        id: id.to_string(),
        name: artist.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        brief_desc: artist
            .get("briefDesc")
            .or_else(|| result.get("briefDesc"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// 获取歌手专辑列表 (参考 NeteaseCloudMusicApi artist_album: /api/artist/albums/{id})
pub async fn artist_albums(id: &str, limit: u32, offset: u32, cookie: &str) -> Result<Vec<Album>, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("limit".into(), json!(limit));
    payload.insert("offset".into(), json!(offset));
    payload.insert("total".into(), json!(true));

    let api_path = format!("/api/artist/albums/{id}");
    let result = post_weapi(&client, &api_path, payload, cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("artist_albums failed: code={code}"));
    }

    let albums_raw = result
        .get("hotAlbums")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(albums_raw
        .iter()
        .map(|a| Album {
            id: a.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
            name: a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            cover: a.get("picUrl").or_else(|| a.get("cover")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            publish_time: a.get("publishTime").and_then(|v| v.as_i64()).unwrap_or(0),
            song_count: a.get("size").and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(0),
            artist_name: a
                .get("artist")
                .and_then(|ar| ar.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

/// 获取歌手 MV 列表 (参考 NeteaseCloudMusicApi artist_mv: /api/artist/mvs)
pub async fn artist_mvs(id: &str, limit: u32, offset: u32, cookie: &str) -> Result<Vec<Mv>, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("artistId".into(), json!(id));
    payload.insert("limit".into(), json!(limit));
    payload.insert("offset".into(), json!(offset));
    payload.insert("total".into(), json!(true));

    let result = post_weapi(&client, "/api/artist/mvs", payload, cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("artist_mvs failed: code={code}"));
    }

    let mvs_raw = result
        .get("mvs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(mvs_raw
        .iter()
        .map(|m| Mv {
            id: m.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default(),
            name: m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            cover: m.get("coverUrl").or_else(|| m.get("imgurl")).or_else(|| m.get("imgUrl")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            duration: m.get("duration").and_then(|v| v.as_i64()).map(|n| n as u64).unwrap_or(0),
            play_count: m.get("playCount").and_then(|v| v.as_i64()).unwrap_or(0),
            artist_name: m
                .get("artist")
                .and_then(|ar| ar.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

/// 获取专辑详情 + 歌曲列表 (参考 NeteaseCloudMusicApi album: /api/v1/album/{id})
pub async fn album_detail(id: &str, cookie: &str) -> Result<(Album, Vec<Song>), String> {
    let client = build_client();
    let api_path = format!("/api/v1/album/{id}");
    let result = post_weapi(&client, &api_path, serde_json::Map::new(), cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("album_detail failed: code={code}"));
    }

    let album_raw = result.get("album").unwrap_or(&Value::Null);
    let album = Album {
        id: id.to_string(),
        name: album_raw.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        cover: album_raw.get("picUrl").or_else(|| album_raw.get("cover")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        publish_time: album_raw.get("publishTime").and_then(|v| v.as_i64()).unwrap_or(0),
        song_count: album_raw.get("size").and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(0),
        artist_name: album_raw
            .get("artist")
            .and_then(|ar| ar.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };

    let songs_raw = result
        .get("songs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let songs: Vec<Song> = songs_raw.iter().map(map_song_record).collect();

    Ok((album, songs))
}

/// 获取 MV 播放地址 (参考 NeteaseCloudMusicApi mv_url: /api/song/enhance/play/mv/url)
pub async fn mv_url(id: &str, resolution: u32, cookie: &str) -> Result<String, String> {
    let client = build_client();
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!(id));
    payload.insert("r".into(), json!(resolution));

    let result = post_weapi(&client, "/api/song/enhance/play/mv/url", payload, cookie).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 200 {
        return Err(format!("mv_url failed: code={code}"));
    }

    let url = result
        .get("data")
        .and_then(|d| d.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if url.is_empty() {
        Err("MV 播放地址为空，可能需要登录或该 MV 不可用".into())
    } else {
        Ok(url)
    }
}

