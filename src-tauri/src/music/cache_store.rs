//! 音乐缓存内核（歌词 / 音频共用）
//!
//! 目录结构：`app_cache_dir()/music-cache/{provider}/{audio|lyric}/{hash}.{ext}`
//!
//! # 为什么这个文件存在
//!
//! 歌词与音频两类缓存的**寻址方式、过期判定、淘汰策略、容错要求完全一致**，
//! 只有「扩展名」和「两个容量/时限常量」不同。若各写一份，会出现两份
//! LRU、两份 TTL、两份 `.part` 处理，日后改一处忘另一处 —— 这类
//! 「同构逻辑分叉」正是本仓反复出现缺陷的位置，故抽成内核 + 两层薄壳。
//!
//! # 铁律：缓存是优化，不是功能
//!
//! 本文件所有对外函数**都不返回 `Result`**（`clear` 除外，它只是尽力而为）。
//! 磁盘满、权限不足、只读文件系统、目录被清理软件删掉 —— 任何一种 IO 故障
//! 都必须**静默降级为「没有缓存」**，绝不 panic、绝不把错误冒泡去打断播放。
//! 唯一允许「看得见」的失败是日志：写 `log::warn!` 便于事后排查，但不改变控制流。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

use super::models::CacheProviderStat;

/// 缓存种类。决定子目录名、TTL 与容量上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheKind {
    /// 整首音频文件
    Audio,
    /// 单首歌的歌词（整份 `Lyrics` 结构的 JSON）
    Lyric,
}

impl CacheKind {
    /// 子目录名。目录名固定成这两个单词，是为了让「打开缓存目录」时人眼能看懂。
    fn dir_name(self) -> &'static str {
        match self {
            CacheKind::Audio => "audio",
            CacheKind::Lyric => "lyric",
        }
    }

    /// 存活时长，按文件**修改时间**（`metadata.modified()`）算。
    ///
    /// 为什么用修改时间而不是「写入时记一个 birth 时间」：修改时间免掉了一个
    /// 需要同步维护的元数据文件，也天然被 LRU 的「刷新修改时间」复用。
    /// 代价是用户手动 touch 文件会让缓存「变年轻」，但那属于用户主动行为，
    /// 不构成正确性问题。
    fn ttl(self) -> Duration {
        match self {
            // 歌词几乎不占空间（几 KB），过期代价只是多一次源站请求，so 给足 30 天
            CacheKind::Lyric => Duration::from_secs(30 * 24 * 3600),
            // 音频单首 3~150MB，7 天基本覆盖「一首歌反复听」的典型周期
            CacheKind::Audio => Duration::from_secs(7 * 24 * 3600),
        }
    }

    /// 容量上限（**全局兜底**，不分平台）。
    ///
    /// 为什么不做每平台独立上限：分平台会引入「哪个平台的配额先耗尽」的耦合，
    /// 且用户无法预期行为（明明只听咪咕却被网易云的缓存挤掉）。全局一个池子，
    /// LRU 自然会把最久没听的清掉 —— 这是用户唯一能理解的心智模型。
    fn max_bytes(self) -> u64 {
        match self {
            CacheKind::Lyric => 100 * 1024 * 1024,
            CacheKind::Audio => 1024 * 1024 * 1024,
        }
    }

    /// 扩展名缺失/非法时的兜底后缀
    pub fn default_ext(self) -> &'static str {
        match self {
            CacheKind::Audio => "mp3",
            CacheKind::Lyric => "json",
        }
    }
}

/// 平台目录名的合法字符集。**必须白名单**，不能只过滤 `/` 与 `..` ——
/// `provider` 来自前端 invoke 的字符串参数，是不可信输入；
/// 放开 `\0`、`:`（Windows 保留名）等会让路径语义在不同平台分裂，
/// 最坏情况是把文件写到缓存目录之外。
const PROVIDER_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789_-";

/// 扩展名同样白名单：它会被拼进文件名，来源是远端 URL 的后缀。
const EXT_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// 四个已知平台。统计里恒定出现这四个键（无缓存时值为 0），
/// 前端可以省掉「键是否存在」的判空。
pub const KNOWN_PROVIDERS: [&str; 4] = ["netease", "qqmusic", "kugou", "migu"];

/// 稳定的 FNV-1a 64 位哈希：保证同一输入在多次进程运行中得到相同结果。
///
/// ⚠️ **绝不能用 `std::collections::hash_map::DefaultHasher`**：
/// 它带随机种子（`RandomState`），同一输入在不同进程里得到不同哈希，
/// 于是重启后缓存路径全部失效 —— 表现为「缓存目录越用越大、
/// 但每次播放都重新下载」，而且**没有任何报错**，极难定位。
/// 先例见 `local.rs` 的同名函数（封面缓存用的是同一个算法），两处必须一致，
/// 否则同一首歌的封面与歌词会落到不同文件。
fn stable_hash(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 只放行「短、纯 ASCII 字母数字 + 下划线/连字符」的段名。
///
/// 长度上限同时防了超长文件名与「拿超长串当 key 探测磁盘」的滥用。
fn sanitize_segment(raw: &str, max_len: usize) -> Option<String> {
    if raw.is_empty() || raw.len() > max_len {
        return None;
    }
    if !raw.bytes().all(|b| PROVIDER_CHARS.contains(&b) || EXT_CHARS.contains(&b)) {
        return None;
    }
    Some(raw.to_string())
}

/// 清洗 provider；非法则返回 `None`（调用方按「无缓存」处理）。
fn sanitize_provider(provider: &str) -> Option<String> {
    sanitize_segment(provider, 24)
}

/// 清洗扩展名。
///
/// `fallback` 传空串表示「不要兜底」—— 候选探测时用得上：
/// 那条路径要求**候选表自己就是全集**，悄悄塞一个兜底后缀会造出
/// 一个谁也没写过的幽灵文件名，探测逻辑从此永远对不上。
fn sanitize_ext(ext: &str, fallback: &str) -> String {
    let lower = ext.trim_start_matches('.').to_ascii_lowercase();
    if lower.is_empty() || lower.len() > 8 || !lower.bytes().all(|b| EXT_CHARS.contains(&b)) {
        return fallback.to_string();
    }
    lower
}

/// 缓存根目录：`app_cache_dir()/music-cache`，顺带确保目录存在。
///
/// 拿不到 `app_cache_dir()`（理论上不会发生）时返回 `None`，调用方按无缓存处理。
pub fn cache_root(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().app_cache_dir().ok()?.join("music-cache");
    // 建不出来也不报错：后续每个操作自己再试一次，往往是「磁盘满」这类
    // 瞬时问题，恢复后下一首歌就能自愈
    let _ = std::fs::create_dir_all(&root);
    Some(root)
}

/// 某平台 + 某类别的目录，顺带确保存在。
pub fn kind_dir(app: &AppHandle, provider: &str, kind: CacheKind) -> Option<PathBuf> {
    let provider = sanitize_provider(provider)?;
    let dir = cache_root(app)?.join(provider).join(kind.dir_name());
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// 拼出最终落盘路径（不检查存在性）。
///
/// `key` 会带上 provider 前缀再哈希，即使目录已按 provider 分层，
/// 也让文件名自带平台信息 —— 目录被手工挪动/合并时依然不会撞名。
pub fn entry_file(
    app: &AppHandle,
    provider: &str,
    kind: CacheKind,
    key: &str,
    ext: &str,
) -> Option<PathBuf> {
    let dir = kind_dir(app, provider, kind)?;
    Some(dir.join(entry_file_name(&kind, &full_key(provider, key), ext)))
}

/// 把 provider 与业务 key 合成完整哈希输入。
///
/// ⚠️ **provider 必须参与哈希**：目录虽然已按 provider 分层，
/// 但合成后文件名自带平台信息 —— 用户手工把目录挪动/合并时依然不会撞名。
fn full_key(provider: &str, key: &str) -> String {
    format!("{provider}:{key}")
}

/// 在一组候选扩展名里挑**第一个未过期**的落盘文件。
///
/// # 为什么需要「候选」而不是单一扩展名
///
/// 写入时扩展名是从下载 URL 猜出来的，而查询时手里只有
/// `provider + id + quality` —— **没有 URL**。于是「写入用了 flac、
/// 查询按 mp3 找」会永远查不到，表现为「缓存文件躺在磁盘上，
/// 但每次播放都重新下载」，而且没有任何报错。
///
/// 两种解法：
/// - (a) 固定扩展名（一律 `.mp3`）—— ❌ 会把 flac 命名成 mp3，
///   浏览器按扩展名挑解码器，直接播不出来；
/// - (b) 查询时按候选列表逐个探测 —— ✅ 本函数。
///   代价是最多 N 次 `metadata` 系统调用（不遍历目录、不读文件内容），
///   N=7 在 SSD 上仍是微秒级。
///
/// ⚠️ 候选表必须**覆盖写入时可能用到的全部扩展名**，
/// 否则新加一种格式就会出现「写进去了但查不到」。
/// 往 `AUDIO_EXTS` 加一项即可，两个方向由它保持一致。
///
/// # ⚠️ 为什么逐个判过期，而不是「找到第一个存在的就返回」
///
/// 同一 key 可能同时留下多个扩展名的文件（先下载到一个无扩展名 URL 的
/// 地址存成 `.mp3`，后来又下载到真 flac 存成 `.flac`）。若只看「存在」，
/// 排在前面那个**已过期**的文件会挡住后面那个仍然新鲜的，
/// 于是缓存明明还在却一直回源。所以判据必须是「存在 **且** 未过期」。
pub fn lookup_entry(
    app: &AppHandle,
    provider: &str,
    kind: CacheKind,
    key: &str,
    exts: &[&str],
) -> Option<PathBuf> {
    let dir = kind_dir(app, provider, kind)?;
    let hashed = stable_hash(&full_key(provider, key));
    exts
        .iter()
        .map(|ext| dir.join(format!("{hashed:016x}.{}", sanitize_ext(ext, ""))))
        .find(|p| is_fresh(p, kind))
}

/// 文件名 = 完整键的 FNV-1a 哈希（定长 16 进制）+ 扩展名。
///
/// 用哈希而非原文做文件名，两个理由：原文可能超长或含路径分隔符
/// （平台 id 长度不受控），且原文拼接理论上可能 `ab`+`c` 与 `a`+`bc` 同名。
fn entry_file_name(kind: &CacheKind, full_key: &str, ext: &str) -> String {
    let fallback = kind.default_ext();
    format!(
        "{:016x}.{}",
        stable_hash(full_key),
        sanitize_ext(ext, fallback)
    )
}

/// 半截文件的固定后缀。**只有 `.part` 才允许被判定为「未完成」**，
/// 这是「半截文件绝不视为命中」这条铁律的物理载体。
const PART_SUFFIX: &str = ".part";

/// 与 `entry_file` 对应的临时文件路径。
pub fn part_file(final_path: &Path) -> PathBuf {
    let mut name = final_path.file_name().unwrap_or_default().to_os_string();
    name.push(PART_SUFFIX);
    final_path.with_file_name(name)
}

/// 把 `.part` 改名成最终文件。
///
/// 必须是 `rename` 而不是「写完再打开正式文件」：同目录 `rename` 在
/// POSIX 与 Windows 上都是原子的，读者要么看到完整文件、要么看不到文件，
/// 绝不会看到「写了一半的正式文件」。
pub fn commit_part(part: &Path, final_path: &Path) -> bool {
    // Windows 上 `rename` 不覆盖已存在的目标，且 `replace` 在部分文件系统不可用。
    // 这里先删后改（而不是先改）—— 删失败就当这文件被别的进程占着，直接放弃本次缓存
    if final_path.exists() {
        let _ = std::fs::remove_file(final_path);
    }
    match std::fs::rename(part, final_path) {
        Ok(()) => true,
        Err(e) => {
            // 写日志但绝不外抛：缓存写不进去，播放照常
            log::warn!("[Cache] 提交缓存失败 {}: {e}", final_path.display());
            false
        }
    }
}

/// 原子写小文件（歌词 JSON 走这里）：先写 `.part`，再改名。
///
/// 任何一步失败都会把 `.part` 清掉并返回 `false`，不留垃圾。
pub fn write_entry(final_path: &Path, data: &[u8]) -> bool {
    let part = part_file(final_path);
    if let Some(parent) = final_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&part, data) {
        log::warn!("[Cache] 写入缓存失败 {}: {e}", part.display());
        let _ = std::fs::remove_file(&part);
        return false;
    }
    if !commit_part(&part, final_path) {
        let _ = std::fs::remove_file(&part);
        return false;
    }
    true
}

/// 判断「最终文件」是否是一个**未过期**的完整缓存。
///
/// ⚠️ 这里只检查**最终文件**（`.part` 永远不参与命中判定）：
/// 半截文件被视为命中 = 用户听到断断续续的音频 / 空歌词，
/// 那比不缓存更糟，且难以察觉。
pub fn is_fresh(final_path: &Path, kind: CacheKind) -> bool {
    let meta = match std::fs::metadata(final_path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() {
        return false;
    }
    match age_of(&meta) {
        Some(age) => age < kind.ttl(),
        // 读不到修改时间（极端文件系统）时**当作命中**：宁可多留一个文件，
        // 也不要把用户的缓存反复清掉
        None => true,
    }
}

/// 命中后刷新修改时间，把 LRU 变成真正的「最近使用优先」。
///
/// ⚠️ **不要每次命中都写盘**：读一次歌词就把文件 mtime 刷新一次，
/// 在机械硬盘上是每秒上千次无意义写入。
/// 折中：只有当 mtime 已经「老到会被误淘汰」时才刷新 —— 具体阈值取
/// `TTL / 8`。这样既保证「正在热听的歌不会因 TTL 到期被删」
/// （最多损失 TTL/8 的保质期），又把写放大压到极低。
pub fn touch(final_path: &Path, kind: CacheKind) {
    let meta = match std::fs::metadata(final_path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let threshold = kind.ttl() / 8;
    match age_of(&meta) {
        Some(age) if age >= threshold => {}
        _ => return,
    }
    // set_times 需要可写句柄；打不开（只读/被占用）就算了，纯优化项
    let Ok(f) = std::fs::OpenOptions::new().write(true).open(final_path) else {
        return;
    };
    let now = SystemTime::now();
    let _ = f.set_times(std::fs::FileTimes::new().set_accessed(now).set_modified(now));
}

/// 「命中 + 刷新 LRU」的一步到位版本。
///
/// 歌词走它（单扩展名，不需要候选探测）；音频走 `lookup_entry` + `touch`
/// 两条，因为要先在候选扩展名里挑出命中的那一个。
pub fn touch_hit(final_path: &Path, kind: CacheKind) -> bool {
    if !is_fresh(final_path, kind) {
        return false;
    }
    touch(final_path, kind);
    true
}

/// 距今过了多久。系统时间被往回拨时 `duration_since` 会失败，返回 `None`。
fn age_of(meta: &std::fs::Metadata) -> Option<Duration> {
    meta.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok())
}

/// 递归求目录内文件总字节（跳过 `.part`）。
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else if !entry.file_name().to_string_lossy().ends_with(PART_SUFFIX) {
            total += meta.len();
        }
    }
    total
}

/// 清掉**整个缓存根**下的内容，但保留根目录本身。
///
/// ⚠️ 为什么保留目录：`open_path` 命令（`commands.rs`）会先判 `p.exists()`，
/// 不存在直接返回 `Err`。若连目录一起删，设置页的「打开缓存目录」按钮
/// 会在清空之后立刻报错 —— 一个「刚做完的操作导致自己的按钮坏了」的经典缺陷。
pub fn clear(app: &AppHandle, provider: Option<&str>) {
    let Some(root) = cache_root(app) else {
        return;
    };
    let targets: Vec<PathBuf> = match provider {
        // 指定平台：只删该平台目录的内容，目录本身留着
        Some(p) => match sanitize_provider(p) {
            Some(p) => {
                let dir = root.join(&p);
                let mut v = Vec::new();
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    v.extend(entries.flatten().map(|e| e.path()));
                }
                v
            }
            // 平台名非法 → 什么都不删，绝不因为一个脏字符串把整个缓存清空
            None => return,
        },
        // 全清：逐个平台目录的内容，根目录与平台目录都保留
        None => {
            let mut v = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&root) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        if let Ok(inner) = std::fs::read_dir(entry.path()) {
                            v.extend(inner.flatten().map(|e| e.path()));
                        }
                    } else {
                        v.push(entry.path());
                    }
                }
            }
            v
        }
    };
    for path in targets {
        remove_any(&path);
    }
    log::info!(
        "[Cache] 缓存已清理（{}）",
        provider.unwrap_or("全部平台")
    );
}

/// 删文件或目录树，静默失败（缓存清理是用户主动操作，失败只记日志）
fn remove_any(path: &Path) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let r = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    if let Err(e) = r {
        log::warn!("[Cache] 删除失败 {}: {e}", path.display());
    }
}

/// 一次清理/淘汰的产物（公开出来方便测试与上层日志）
#[derive(Debug, Default, Clone, Copy)]
pub struct PruneReport {
    /// 因过期或超容量被删的文件数
    pub removed: usize,
    /// 因写失败而丢弃的孤儿 `.part` 数
    pub orphan_parts: usize,
}

/// 全库清理：删过期文件 → 删僵尸 `.part` → 超容量则按 LRU 删到限额内。
///
/// 触发点是「写完一份缓存之后」，**不放在读路径上**：清理要遍历目录 + 读
/// 每个文件的 mtime，放在读路径会让每次播放都付一次全盘 stat 的钱。
/// 代价是长期不写缓存时不会清理 —— 但「不写缓存」本身说明没有新数据，
/// 旧数据又还在 TTL 内，暂不清理无害。
pub fn prune(app: &AppHandle, kind: CacheKind) -> PruneReport {
    let Some(root) = cache_root(app) else {
        return PruneReport::default();
    };
    let mut report = PruneReport::default();
    let mut alive: Vec<(PathBuf, u64, Option<SystemTime>)> = Vec::new();

    let Ok(platforms) = std::fs::read_dir(&root) else {
        return report;
    };
    for platform in platforms.flatten() {
        let dir = platform.path().join(kind.dir_name());
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let name = file.file_name().to_string_lossy().to_string();
            let Ok(meta) = file.metadata() else {
                continue;
            };
            if name.ends_with(PART_SUFFIX) {
                // 僵尸 `.part`：上一次进程被杀 / 下载中断留下的。
                // 用「1 小时」当门槛而不是「立刻删」—— 正在进行的下载
                // 也在写 `.part`，立刻删会把别人的下载打断。
                // 单飞锁（`single_flight`）保证同一 key 不会有两个下载者，
                // 但挡不住「不同 key 的两个下载都在跑」。
                let stale = meta
                    .modified()
                    .ok()
                    .and_then(|m| SystemTime::now().duration_since(m).ok())
                    .map(|age| age > Duration::from_secs(3600))
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_file(&path);
                    report.orphan_parts += 1;
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            // 过期即删：这里不再复用 `is_fresh`，因为它会顺带 touch，
            // 而我们要判断的正是「该不该还留着」
            let age = age_of(&meta);
            if age.map(|a| a >= kind.ttl()).unwrap_or(false) {
                let _ = std::fs::remove_file(&path);
                report.removed += 1;
                continue;
            }
            alive.push((path, meta.len(), meta.modified().ok()));
        }
    }

    // 超容量才淘汰；按修改时间升序（最久没用过的在前）逐个删到限额内
    let limit = kind.max_bytes();
    let mut used: u64 = alive.iter().map(|(_, len, _)| *len).sum();
    if used > limit {
        alive.sort_by(|a, b| a.2.cmp(&b.2));
        for (path, len, _) in alive.iter() {
            if used <= limit {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                used = used.saturating_sub(*len);
                report.removed += 1;
            }
        }
    }
    report
}

// ============================================================
//  单飞（single-flight）
// ============================================================

/// 全局单飞表：`key -> 锁的 Weak`。
///
/// 用 `Weak` 而不是 `Arc` 是有意的：`Arc` 需要显式 remove 才不会泄漏条目，
/// 而 remove 得放在守卫的 `Drop` 里做异步加锁（`Drop` 不能 await），
/// 于是要再 spawn 一个任务，徒增复杂度。`Weak` 让条目**随最后一个持有者
/// 自动失效**，下一次 `single_flight` 顺手 `retain` 掉死条目即可 —— 零泄漏。
static INFLIGHT: OnceLock<tokio::sync::Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn inflight_table() -> &'static tokio::sync::Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>> {
    INFLIGHT.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// 单飞守卫。**必须持有到本次缓存填充结束**，否则去重失效。
pub struct SingleFlight {
    _lock: Arc<tokio::sync::Mutex<()>>,
}

impl SingleFlight {
    /// 等前一个同 key 的任务做完。
    ///
    /// ⚠️ 拿到锁之后**必须再查一次缓存**：等锁期间前一个任务很可能已经
    /// 把数据写好了。这不是可选的双检 —— 少了它，单飞只是把并发请求排队，
    /// 排队结束后每个请求仍然各回源一次，去重等于没做。
    pub async fn wait(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self._lock.lock().await
    }
}

/// 取某个 key 的单飞锁。同 key 并发调用会拿到同一把锁。
pub async fn single_flight(key: &str) -> SingleFlight {
    let mut table = inflight_table().lock().await;
    // 顺手清掉已无人持有的条目，防止表无限增长
    table.retain(|_, weak| weak.strong_count() > 0);
    if let Some(arc) = table.get(key).and_then(|w| w.upgrade()) {
        return SingleFlight { _lock: arc };
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    table.insert(key.to_string(), Arc::downgrade(&lock));
    SingleFlight { _lock: lock }
}

// ============================================================
//  统计
// ============================================================

/// 逐平台统计缓存体积。**恒定返回四个平台键**（无缓存的为 0），
/// 前端可以省掉判空逻辑。统计只读，不触发清理、不 touch mtime。
pub fn stats(app: &AppHandle) -> super::models::CacheStats {
    let mut total: u64 = 0;
    let mut lyric_bytes: u64 = 0;
    let mut audio_bytes: u64 = 0;
    let mut providers: HashMap<String, CacheProviderStat> = HashMap::new();

    for name in KNOWN_PROVIDERS {
        providers.insert(name.to_string(), CacheProviderStat::default());
    }
    if let Some(root) = cache_root(app) {
        for name in KNOWN_PROVIDERS {
            let provider_dir = root.join(name);
            let lb = dir_size(&provider_dir.join(CacheKind::Lyric.dir_name()));
            let ab = dir_size(&provider_dir.join(CacheKind::Audio.dir_name()));
            lyric_bytes = lyric_bytes.saturating_add(lb);
            audio_bytes = audio_bytes.saturating_add(ab);
            total = total.saturating_add(lb).saturating_add(ab);
            providers.insert(
                name.to_string(),
                CacheProviderStat {
                    lyric_bytes: lb,
                    audio_bytes: ab,
                    ..Default::default()
                },
            );
        }
    }

    super::models::CacheStats {
        total,
        lyric_bytes,
        audio_bytes,
        root: root_string(app),
        limit_lyric: CacheKind::Lyric.max_bytes(),
        limit_audio: CacheKind::Audio.max_bytes(),
        providers,
    }
}

/// 缓存根目录的绝对路径字符串。
///
/// 单独提供而不是让前端自己拼：路径里有平台差异与 `bundle id`，
/// 前端拼出来的路径在 macOS/Windows 上大概率对不上「打开目录」。
/// 拿不到时返回空串，前端据此禁用「打开目录」按钮。
pub fn root_string(app: &AppHandle) -> String {
    app.path()
        .app_cache_dir()
        .map(|p| p.join("music-cache").to_string_lossy().to_string())
        .unwrap_or_default()
}