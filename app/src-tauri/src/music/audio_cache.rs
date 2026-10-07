//! 音频缓存层（**只做整首落盘，不改代理**）
//!
//! # 边界：为什么这一层完全没碰 `audio_proxy.rs`
//!
//! 音频代理是本项目**最脆弱**的部分：`Range` / `206` 透传、Referer 注入、
//! 流式响应全在那里，且有断言盯着。往里加「边下边写」意味着要在
//! 「用户只听了前 30 秒」的场景里正确处理**不完整文件**—— 判断完整性
//! 需要代理自己维护已写字节数（不能靠 `Content-Length` 单次判断，
//! 因为 Range 请求的响应体本身就不是整首）。
//!
//! 本轮采用**命令侧查缓存**路线：新增 `music_audio_cached` 让前端在
//! `songUrl` 之前先问一次「本地有整首吗」，有就直接播本地文件；
//! 没有就走原有代理路径（可另行调 `music_cache_download` 预热）。
//! 于是代理零改动，脆弱面一点没碰。
//!
//! # ⚠️ 缓存 key 必须含 quality（功能性 bug 级别）
//!
//! key = `{provider}:{id}:{quality}`。若漏掉 quality：用户从「极高」切到「无损」，
//! 会命中上次的文件 —— 界面显示新档位、实际播旧码率，**用户完全无法察觉**
//! （播放器只管播，不会校验码率）。这属于「看起来一切正常但结果是错的」缺陷，
//! 比崩溃更难发现，因此单列一条。
//!
//! # ⚠️ quality 只能用「请求档位」，不能用 `SongUrlResult.quality` / `.level`
//!
//! 查缓存发生在 `songUrl()` **之前**（命中就不回源），那一刻只有
//! 「用户请求的档位」已知。而四个平台的返回值字段既不同名也不同值域：
//! 网易云的 `quality` 是中文 label、QQ 是英文 label、咪咕的 `level` 干脆是
//! `PQ/SQ/ZQ` 这种音质等级而非档位名。拿它们当 key 会导致同一首歌
//! 每次 key 都不同 ⇒ **缓存永不命中**，而且完全不报错。
//!
//! 代价（可接受）：源站降级时（「用户选 hires、实际拿到 exhigh」）
//! key 记的仍是 `hires`。这反而是对的 —— 下次仍是同一请求。
//! 只是「降级回来的那一档」会在磁盘上各占一份文件。

use std::time::Duration;

use futures_util::StreamExt;
use tauri::AppHandle;

use super::cache_store::{self, CacheKind};
use super::models::CacheStats;

/// 下载超时。给足 5 分钟：一张无损大碟的单首在慢网下可能十几 MB，
/// 超时太紧会得到「一半的歌」——虽然有 `.part` 保护不会污染缓存，
/// 但用户会看到「缓存失败」的重试提示。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// 与 `audio_proxy` 一致的 UA / Referer。
///
/// ⚠️ **不要改成「不写 Referer」**：四家 CDN 都对裸请求返回 403，
/// 而 403 的响应体也是一段 HTML —— 若不校验状态码，
/// 就会把一段 HTML 当音频落盘，用户听到的是噪声。
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 按域名给 Referer。逻辑与 `audio_proxy::referer_for` 一致，
/// 但**独立于**它 —— 代理是长期存在的热路径，缓存是一次性的冷路径，
/// 让冷路径去依赖热路径的实现，等于把两者绑死：以后改代理的 Referer 策略
/// 会连带改变缓存的下载行为，而这两者的容错要求完全不同。
fn referer_for(url: &str) -> &'static str {
    if url.contains("qq.com") || url.contains("qpic.cn") {
        "https://y.qq.com/"
    } else if url.contains("kugou.com") {
        "https://www.kugou.com/"
    } else if url.contains("migu.cn") || url.contains("miguvideo.com") {
        "https://music.migu.cn/"
    } else {
        "https://music.163.com/"
    }
}

/// 音频落盘的候选扩展名全集。
///
/// ⚠️ 这是**写入与查询之间的唯一契约**：`guess_ext` 从写入侧挑一个，
/// `cached_path` 从这里逐个探测。任何一侧新增格式而不同步改这里，
/// 症状都是「缓存文件存在但永远不命中」且无任何报错。
/// 加格式时两处一起改。
///
/// 顺序即优先级（`guess_ext` 的兜底值取最后一个 `mp3`）。
const AUDIO_EXTS: [&str; 7] = ["flac", "m4a", "mp4", "aac", "ogg", "wav", "mp3"];

/// 从 URL 猜音频扩展名，猜不出就用 `mp3`。
///
/// 为什么必须要扩展名：本地文件要交给浏览器的 `<audio>` 播，
/// 多数浏览器靠扩展名挑解码器，`.bin` 这类无扩展名文件会被拒。
/// 猜错的后果是「文件存在但播不了」，所以兜底选各平台最常见的 `mp3`。
/// 猜测只用于**写入**，查询侧走 `AUDIO_EXTS` 探测，两边不互相依赖。
fn guess_ext(url: &str) -> &'static str {
    // 先砍掉 query 与 hash —— 签名参数里常有 `format=mp3` 之类，
    // 不砍会把 query 误当成扩展名
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let lower = path.to_ascii_lowercase();
    for ext in AUDIO_EXTS {
        if lower.ends_with(&format!(".{ext}")) {
            return ext;
        }
    }
    AUDIO_EXTS[AUDIO_EXTS.len() - 1]
}

/// 拼缓存 key。⚠️ **quality 在这里，且必须是请求档位**（见模块头）。
fn cache_key(provider: &str, id: &str, quality: &str) -> String {
    format!("{provider}:{id}:{quality}")
}

/// Tauri 命令：查本地是否已有整首音频。
///
/// 命中返回**绝对路径**，未命中返回 `None`。
/// 返回 `Option` 而不是 `Result`：`None` 同时覆盖「没缓存」与「缓存不可用」，
/// 调用方（前端）的正确反应在两种情况下**完全相同** —— 走原来的代理路径。
/// 缓存故障不该让用户看到一个错误弹窗。
#[tauri::command]
pub async fn music_audio_cached(
    app: AppHandle,
    provider: String,
    id: String,
    quality: String,
) -> Option<String> {
    let path = cached_path(&app, &provider, &id, &quality)?;
    Some(path.to_string_lossy().to_string())
}

/// 内部：算出「命中时的绝对路径」，未命中 `None`。
pub fn cached_path(
    app: &AppHandle,
    provider: &str,
    id: &str,
    quality: &str,
) -> Option<std::path::PathBuf> {
    // 空 id / 空档位一律视为无法寻址。
    // ⚠️ 空档位**不能**默认成 `standard`：那会让「参数传漏」的调用
    // 静默命中标准音质文件，用户以为听到了自己选的高音质。
    // 这里宁可不缓存 —— 缓存是优化，猜错音质是错音。
    if id.trim().is_empty() || quality.trim().is_empty() {
        return None;
    }
    let key = cache_key(provider, id, quality);
    // 写入时扩展名是从 URL 猜的，查询时没有 URL ⇒ 必须按候选列表探测，
    // 否则「写入用 flac、查询按 mp3 找」会永远查不到（详见 lookup_entry）。
    // lookup_entry 内部已判过 TTL，这里只需补一次 mtime 刷新喂给 LRU
    let path = cache_store::lookup_entry(app, provider, CacheKind::Audio, &key, &AUDIO_EXTS)?;
    cache_store::touch(&path, CacheKind::Audio);
    Some(path)
}

/// Tauri 命令：整首下载落盘，成功返回绝对路径。
///
/// 流程：**单飞 → 双检 → 下载到 `.part` → 改名 → 清理**。
/// `.part` 未改名前不会被 `cached_path` 视作命中，所以「下载到一半」
/// 既不会被播放，也不会污染统计。
///
/// 任何一步失败都返回 `None`（静默降级）：下载失败对用户而言
/// 与「没缓存」等价 —— 前端继续走代理在线播，功能不受影响。
#[tauri::command]
pub async fn music_cache_download(
    app: AppHandle,
    provider: String,
    id: String,
    quality: String,
    url: String,
) -> Option<String> {
    // 参数校验放在最前面：非法 url 不值得发起一次网络请求
    if id.trim().is_empty() || quality.trim().is_empty() {
        return None;
    }
    if !url.starts_with("http") {
        return None;
    }
    let key = cache_key(&provider, &id, &quality);

    // 单飞：同一首歌的并发下载只发一次网络请求。
    // 没有它，快速切歌 + 前端重试会同时打同一个 URL 多次，
    // 既浪费带宽又会在磁盘上写出多份竞争的文件。
    let flight = cache_store::single_flight(&format!("{provider}:audio:{key}")).await;
    let _held = flight.wait().await;

    // 双检：等锁期间可能已有人下完
    if let Some(existing) = cached_path(&app, &provider, &id, &quality) {
        return Some(existing.to_string_lossy().to_string());
    }

    let final_path = cache_store::entry_file(
        &app,
        &provider,
        CacheKind::Audio,
        &key,
        guess_ext(&url),
    )?;
    let part_path = cache_store::part_file(&final_path);
    if let Some(parent) = final_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let downloaded = download_to_part(&url, &part_path).await;

    if !downloaded {
        // 半截文件绝不能留在正式位置（本来也不在），顺手清掉以免占磁盘
        let _ = tokio::fs::remove_file(&part_path).await;
        return None;
    }
    if !cache_store::commit_part(&part_path, &final_path) {
        let _ = tokio::fs::remove_file(&part_path).await;
        return None;
    }

    // 清理放在写成功之后（原因同歌词层：清理是遍历操作，不该挂在读路径上）
    cache_store::prune(&app, CacheKind::Audio);
    Some(final_path.to_string_lossy().to_string())
}

/// 下载到临时文件。返回是否成功。
///
/// ⚠️ 三个必要条件，缺一个就会落盘一份坏音频：
/// 1. HTTP 状态码必须是 2xx —— 403/404 的响应体是 HTML 错误页；
/// 2. 必须读到至少 1 字节 —— 空文件会被 `<audio>` 当成加载失败；
/// 3. 必须读完整个响应体 —— 中途断流要把 `.part` 删掉（由调用方做）。
async fn download_to_part(url: &str, part_path: &std::path::Path) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[AudioCache] 创建下载 client 失败: {e}");
            return false;
        }
    };

    let resp = match client
        .get(url)
        .header("User-Agent", UA)
        .header("Referer", referer_for(url))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[AudioCache] 请求失败: {e}");
            return false;
        }
    };

    // 状态码校验必须在读 body 之前：否则 403 的 HTML 页会被写进音频文件
    let status = resp.status();
    if !status.is_success() {
        log::warn!("[AudioCache] 下载返回非 2xx: {status}");
        return false;
    }

    let mut file = match tokio::fs::File::create(part_path).await {
        Ok(f) => f,
        Err(e) => {
            // 磁盘满 / 权限不足：典型的静默降级场景
            log::warn!("[AudioCache] 创建临时文件失败 {}: {e}", part_path.display());
            return false;
        }
    };

    let mut stream = resp.bytes_stream();
    let mut written: u64 = 0;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[AudioCache] 传输中断: {e}");
                return false;
            }
        };
        if let Err(e) = file.write_all(&chunk).await {
            log::warn!("[AudioCache] 写入失败: {e}");
            return false;
        }
        written += chunk.len() as u64;
    }
    if let Err(e) = file.flush().await {
        log::warn!("[AudioCache] flush 失败: {e}");
        return false;
    }
    drop(file);

    if written == 0 {
        log::warn!("[AudioCache] 响应体为空，判为下载失败");
        return false;
    }
    true
}

/// Tauri 命令：缓存统计。只读，不触发清理。
#[tauri::command]
pub async fn music_cache_stats(app: AppHandle) -> CacheStats {
    cache_store::stats(&app)
}

/// Tauri 命令：清缓存。`provider` 为空 ⇒ 全平台。
///
/// ⚠️ 返回 `()` 而不是 `Result`：清缓存失败对用户没有可执行的下一步
/// （重试也未必成功），弹错误框只会让人困惑。清完目录仍保留
/// （见 `cache_store::clear` 的说明），所以设置页的「打开目录」按钮
/// 在清空之后依然可用。
#[tauri::command]
pub async fn music_cache_clear(app: AppHandle, provider: Option<String>) {
    cache_store::clear(&app, provider.as_deref());
}