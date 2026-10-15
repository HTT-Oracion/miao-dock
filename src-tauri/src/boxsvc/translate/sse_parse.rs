// 上游流解析 —— 把有道 llm 的 `text/event-stream` 切成可解析的负载串（Rust 侧）
// =============================================================================
// 依据：在线翻译服务设计方案 §5.2 / §6.1；真机取证见 docs/spec-notes.md D-130。
// 移植自 `service/src/manga/translate/sse-parse.mjs`。
//
// 🔴 有道的流式响应是**标准 SSE 帧**（真上游实测，非推测）：
//      event:message
//      data:{"code":"0","successful":true,"data":{"transIncre":"…"}}
//    负载在 `data:` 行里，**不是**「每行一个裸 JSON」。
//
// 本解析器**同时**接受两种（不把上游任一形态打死）：
//   · SSE 帧      —— 取 `data:` 行的负载（一个事件可含多行 data，规范以 \n 拼成负载）；
//   · 裸 JSON 行  —— 整行就是一个 JSON（兼容逐行 JSON 的上游 / 测试替身）。
// `event:` / `id:` / `retry:` 与 `:` 注释行是元数据，跳过。
// 半包（一行被拆在两个 TCP 块里）与尾包（最后一块没有换行符）都必须能吃下。
//
// ⚠️ 与 Node 的形态差异（**登记 D-153**）：Node 版是 async 生成器 + async 回调（`onObj`
//    可以 await 下游背压）；Rust 版拆成「**同步**增量行解析器 + 调用方 async 消费循环」——
//    feed() 只吐负载串，`await onDelta` 在调用方，背压链同样不断（不许用回调是因为
//    Rust 1.77 没有 async 闭包，FnMut 返回借用捕获状态的 Future 表达不了）。
use crate::boxsvc::translate::refute;

/// 增量行解析器：喂字节块、吐「待解析的负载串」。
#[derive(Default)]
pub struct LineParser {
    /// 尚未凑齐一行的残余字节（半包）
    pending: Vec<u8>,
    /// 当前事件已累积的 `data:` 负载行（SSE 规范：以 \n 拼成一个负载）
    data_lines: Vec<String>,
}

impl LineParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 事件边界（空行）或流结束时，把累积的 data 行拼起来交出去。
    fn flush(&mut self, out: &mut Vec<String>) {
        if self.data_lines.is_empty() {
            return;
        }
        out.push(self.data_lines.join("\n"));
        self.data_lines.clear();
    }

    fn handle_line(&mut self, raw: &[u8], out: &mut Vec<String>) {
        let owned = String::from_utf8_lossy(raw);
        let line = owned.trim();
        if line.is_empty() {
            // 空行 = SSE 事件边界
            self.flush(out);
            return;
        }
        if line.starts_with(':') {
            // SSE 注释行（心跳）
            return;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            // 反证开关：退回「只认裸 JSON 行、不认 SSE 帧」⇒ 真上游的帧被整片丢弃（D-130）
            if refute::get().legacy_line_json_only {
                return;
            }
            // 规范：`data:` 后可有一个空格
            let payload = rest.strip_prefix(' ').unwrap_or(rest);
            self.data_lines.push(payload.to_string());
            return;
        }
        if line.starts_with("event:") || line.starts_with("id:") || line.starts_with("retry:") {
            return;
        }
        // 无 SSE 前缀 ⇒ 按「裸 JSON 行」处理（兼容逐行 JSON 的上游 / 测试替身）
        out.push(line.to_string());
    }

    /// 喂一块字节，返回本块解析出的负载串（可能多条）。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        self.pending.extend_from_slice(chunk);
        loop {
            let Some(idx) = self.pending.iter().position(|b| *b == 0x0a) else { break };
            let line: Vec<u8> = self.pending[..idx].to_vec();
            self.pending.drain(..=idx);
            self.handle_line(&line, &mut out);
        }
        out
    }

    /// 流结束：尾包（最后一块没有换行符）+ 未闭合事件（最后一帧没有以空行收尾）。
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.pending.is_empty() {
            let tail = std::mem::take(&mut self.pending);
            self.handle_line(&tail, &mut out);
        }
        self.flush(&mut out);
        out
    }
}

/// 把一条负载串解释成 JSON 对象（非 JSON / 空 / `[DONE]` / 非对象 ⇒ `None`，不解释不报错）。
pub fn as_object(payload: &str) -> Option<serde_json::Value> {
    let p = payload.trim();
    if p.is_empty() || p == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(p).ok()?;
    if v.is_object() {
        Some(v)
    } else {
        None
    }
}
