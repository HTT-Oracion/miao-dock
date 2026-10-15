// 在线翻译**反证开关**（Rust 侧）—— 与 `service/src/manga/translate/refute.mjs` 同名同义
// =============================================================================
// 依据：在线翻译服务设计方案 §10（反证必须成对：破坏什么 → 哪条断言变红）。
//
// 🔴 与 Node 侧同一条纪律：模块顶层读 env ⇒ **进程内不可回滚** ⇒ 反证轮必须
//    「一个开关一个子进程」。Rust 靶子本来就是独立进程，重起靶子换 env 即可。
//    本组开关**只被 `check:translate` 的 R 组反证轮设置**，产品路径永不设置。
use std::sync::OnceLock;

/// 没设 / 空串 = false；`0/false/no/off`（不分大小写）= false；其余 = true。
fn env_bool(name: &str) -> bool {
    match std::env::var(name) {
        Ok(raw) => {
            let t = raw.trim();
            if t.is_empty() {
                return false;
            }
            !matches!(t.to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off")
        }
        Err(_) => false,
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Refute {
    /// 签名去掉 `input` 截断（长文本直连）⇒ 假上游回算 sign 不一致、回 202（§10 第 1 行）
    pub no_truncate: bool,
    /// 重试复用旧 `salt` + `curtime` + `sign` ⇒ 第二次必撞上游防重放 207（第 2 行）
    pub reuse_salt: bool,
    /// `idleMs` 并进 `totalMs`（少一档超时）⇒「卡住」与「慢慢吐」不再可分（第 3 行）
    pub idle_as_total: bool,
    /// 密钥视图回显 `appSecret` ⇒「secret 永不回显」被破坏（第 4 行）
    pub echo_secret: bool,
    /// 流式首块之后仍重试 ⇒ 已吐给用户的增量被重复/覆盖（第 5 行）
    pub stream_retry_after_first: bool,
    /// 两个接口判成功逻辑互换 ⇒ text 的 `errorCode:"0"` 被判失败、llm 的双判被废（第 6 行）
    pub swap_judge: bool,
    /// 流式解析只认裸 JSON 行、丢弃 SSE `data:` 帧 ⇒ llm 全组空译文（第 7 行；D-130）
    pub legacy_line_json_only: bool,
    /// 流式不做「200 但零帧即报错」兜底 ⇒ 退回「成功 + 空译文」假象（第 8 行；D-130）
    pub no_frame_guard: bool,
}

static INSTANCE: OnceLock<Refute> = OnceLock::new();

/// 读一次，进程内恒定（复刻 Node 模块顶层求值语义）。
pub fn get() -> Refute {
    *INSTANCE.get_or_init(|| Refute {
        no_truncate: env_bool("MIAO_TRANSLATE_REFUTE_NO_TRUNCATE"),
        reuse_salt: env_bool("MIAO_TRANSLATE_REFUTE_REUSE_SALT"),
        idle_as_total: env_bool("MIAO_TRANSLATE_REFUTE_IDLE_AS_TOTAL"),
        echo_secret: env_bool("MIAO_TRANSLATE_REFUTE_ECHO_SECRET"),
        stream_retry_after_first: env_bool("MIAO_TRANSLATE_REFUTE_STREAM_RETRY_AFTER_FIRST"),
        swap_judge: env_bool("MIAO_TRANSLATE_REFUTE_SWAP_JUDGE"),
        legacy_line_json_only: env_bool("MIAO_TRANSLATE_REFUTE_LEGACY_LINE_JSON"),
        no_frame_guard: env_bool("MIAO_TRANSLATE_REFUTE_NO_FRAME_GUARD"),
    })
}
