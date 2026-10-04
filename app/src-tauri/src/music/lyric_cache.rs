//! 歌词缓存层
//!
//! # 为什么单独一层、而不是直接写进四个聚合命令
//!
//! 四平台的歌词命令（`music_lyric` / `kugou_lyric` / `qq_lyric` / `migu_lyric`）
//! 各自的取词参数都不一样（id / hash+album_audio_id+duration / mid+id / content_id+copyright_id），
//! 但**缓存流程完全相同**：查 → 未命中则回源 → 成功后落盘。
//! 把流程收进本模块的泛型函数后，四个命令各只需一行调用，
//! 且改缓存策略时不会漏改某一平台（漏改的后果是「某平台永远不命中缓存」）。
//!
//! # 前端零改动
//!
//! 本层对前端完全透明：命令的**返回值类型与语义都没变**（仍是
//! `Result<Lyrics, String>`），`loadLyrics` / `platform.lyric()` 一行都不用动。
//! 唯一的变化是四个命令的 Rust 签名多了 `app: AppHandle` —— 它由 Tauri 框架
//! 从 invoke 消息里解析，不读 payload，前端不传也不会报错。

use std::future::Future;

use tauri::AppHandle;

use super::cache_store::{self, CacheKind};
use super::models::Lyrics;

/// 缓存文件名后缀。歌词落盘为整份 `Lyrics` 的 JSON（含 yrc / translation / roma），
/// 不是纯文本 lrc —— 源站返回的结构本身有四个字段，存文本会丢字段。
const LYRIC_EXT: &str = "json";

/// 读缓存命中时返回；`None` 表示未命中 / 已过期 / IO 失败。
pub fn lookup(app: &AppHandle, provider: &str, stable_id: &str) -> Option<Lyrics> {
    let path = cache_store::entry_file(app, provider, CacheKind::Lyric, stable_id, LYRIC_EXT)?;
    // touch_hit 同时做了两件事：判 TTL + 刷新 mtime 喂给 LRU
    if !cache_store::touch_hit(&path, CacheKind::Lyric) {
        return None;
    }
    let raw = std::fs::read(&path).ok()?;
    // ⚠️ 解析失败要**删掉坏文件**，否则每次播放都会走「读文件 → 解析失败 → 回源」
    // 这条永远失败的路径，且永远命中同一个坏文件。
    // 这属于「静默降级」而非「冒泡」：解析失败时当成未命中，回源即可。
    match serde_json::from_slice::<Lyrics>(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("[LyricCache] 缓存解析失败，按未命中处理 {}: {e}", path.display());
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// 落盘。空歌词**不写**（见 `fetch_and_cache` 的说明）。
fn store(app: &AppHandle, provider: &str, stable_id: &str, value: &Lyrics) {
    let Some(path) = cache_store::entry_file(app, provider, CacheKind::Lyric, stable_id, LYRIC_EXT)
    else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec(value) {
        let _ = cache_store::write_entry(&path, &bytes);
        // 只在「刚写过」之后触发清理：清理要遍历目录读 mtime，
        // 挂在读路径上会让每次播放都付一次全盘 stat 的钱。
        // 代价是「长时间不再产生新缓存」时不会主动清理，但那些数据也还在 TTL 内。
        cache_store::prune(app, CacheKind::Lyric);
    }
}

/// 判定「这份歌词没有任何可用文本」。
///
/// **空结果不写缓存**：源站对无歌词的歌曲会返回 200 + 空内容，
/// 而「空」也可能是这一次的网络/解析故障。若把空结果缓存 30 天，
/// 用户刚修好的网络也换不回歌词，且**没有任何补救入口**。
/// 不缓存的代价只是每首歌多回源一次请求 —— 相比「永久空歌词」小得多。
fn is_empty_lyrics(v: &Lyrics) -> bool {
    let own_empty = v.lyric.trim().is_empty();
    let yrc_empty = v.yrc.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true);
    let trans_empty = v.translation.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true);
    own_empty && yrc_empty && trans_empty
}

/// 「查缓存 → 未命中回源 → 成功后落盘」的完整流程。
///
/// `fetch` 是零参闭包 —— 由调用方决定去哪个平台、用什么参数回源，
/// 这样本模块不需要知道四平台的参数差异。
///
/// 流程说明：
/// 1. **稳定 id 为空 ⇒ 完全绕开缓存**（也不进单飞）。见下方「酷狗空 hash」说明。
/// 2. 取单飞锁并等待。
/// 3. **拿到锁后必须再查一次**（双检）：等锁期间前一个任务很可能已经写好了。
///    少了这一步，同一首歌的 N 个并发请求只是排了队，队排完仍然各回源一次。
/// 4. 仍未命中才回源；回源成功且非空才落盘。
///
/// # ⚠️ 酷狗空 hash 隐患（接入本层时必读）
///
/// 前端 `platform.ts` 里酷狗的实参是 `song.hash ?? song.id` —— 用的是 `??`，
/// 它只对 `null` / `undefined` 回落。而 Rust 侧 `kugou.rs` 反序列化 Song 时，
/// 空 hash 会被写成 `Some("")`（**不是 None**），于是 `song.hash` 是空串，
/// `??` **不会**回落到 `song.id`，空 hash 被原样传下来。
///
/// 若照抄那个写法做 key，所有「hash 为空的酷狗歌」会共用同一个 key
/// `kugou:` —— 表现为「A 歌的歌词出现在 B 歌上」，且因为内容看起来完全正常，
/// **用户几乎不可能察觉**。
///
/// 兜底有两道：
/// - 本层：`stable_id` 为空 ⇒ 不查也不写缓存，直接回源（正确，只是没缓存）。
/// - 本层：`stable_id` 为空时也**不能**回退到「另一个 id」—— 那个 id 在 Rust
///   侧拿不到（命令签名只收 `hash`），所以唯一的正确做法就是不缓存。
///
/// # 为什么不改前端把 `??` 换成 `||`
///
/// 本层交付时前端零改动是硬要求（且 `platform.ts` 在共享工作区里，
/// 有另一条改造线在动）。等该文件空闲后可以补一刀把 `??` 换成 `||`，
/// 但本层的兜底必须留着 —— 前端那一改只解决「参数」，不解决
/// 「别的调用方也可能传空串」。
pub async fn fetch_and_cache<F, Fut>(
    app: &AppHandle,
    provider: &str,
    stable_id: &str,
    fetch: F,
) -> Result<Lyrics, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Lyrics, String>>,
{
    // 空稳定 id：无法构造安全且唯一的 key，一律不缓存（详见上方「酷狗空 hash」）
    let usable = !stable_id.trim().is_empty();

    // ⚠️ 空 id 时**不能**进单飞：单飞表以 key 为键，所有空 id 会挤在同一把锁上，
    // 于是「本可并行的多个请求」被串行化。宁可不去重，也不能把无关请求排队。
    if usable {
        let flight = cache_store::single_flight(&format!("{provider}:lyric:{stable_id}")).await;
        let _held = flight.wait().await;
        // 双检：等锁期间可能已经有人填好了。
        // 少了这一步，单飞只是把并发请求排队，队排完每个请求仍各回源一次
        if let Some(hit) = lookup(app, provider, stable_id) {
            return Ok(hit);
        }
    }

    let result = fetch().await?;

    if usable && !is_empty_lyrics(&result) {
        store(app, provider, stable_id, &result);
    }
    Ok(result)
}