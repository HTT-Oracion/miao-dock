// 上游流解析 —— 把有道 llm 的 `text/event-stream` 切成 JSON 对象流
// =============================================================================
// 依据：在线翻译服务设计方案 §5.2 / §6.1；真机取证见 docs/spec-notes.md D-130。
//
// 🔴 有道的流式响应是**标准 SSE 帧**（真上游实测，非推测）：
//      event:message
//      data:{"code":"0","successful":true,"data":{"transIncre":"…"}}
//
//    负载在 `data:` 行里，**不是**"每行一个裸 JSON"。旧注释曾断言"逐行 JSON、
//    不是标准 SSE"——那是**错的**（假上游照着错的假设发裸 JSON，于是测试全绿却
//    线上空手；典型假绿，见 D-130）。
//
// 为了不把上游可能的任一形态打死，本解析器**同时**接受两种：
//   · SSE 帧      —— 取 `data:` 行的负载（一个事件可含多行 data，规范以 \n 拼成负载）；
//   · 裸 JSON 行  —— 整行就是一个 JSON（兼容逐行 JSON 的上游 / 测试替身）。
// `event:` / `id:` / `retry:` 与 `:` 注释行是元数据，跳过。
// 半包（一行被拆在两个 TCP 块里）与尾包（最后一块没有换行符）都必须能吃下。

import { REFUTE } from './refute.mjs';

/**
 * 逐帧解析 JSON 流（SSE `data:` 帧 或 裸 JSON 行，两种都吃）。
 *
 * @param {import('node:stream').Readable} readable 上游响应流（可已被解压）
 * @param {(obj:object)=>void|Promise<void>} onObj 每收到一个完整 JSON 对象调一次；
 *        **允许返回 Promise**（门面的 onDelta 可能是 async —— 路由层背压要在 onDelta 里
 *        等 'drain'）：这里 `await` 它，"上游读取节奏跟随下游"这条链在本环不断。
 *        同步 onObj 完全向后兼容（`await undefined` 即同步执行完）。
 *        同步抛错会中断解析并把错误带给调用方（适配器据此在首块前抛归一错误）
 * @returns {Promise<void>} 流正常结束（或 onObj 抛错）时 resolve / reject
 */
export async function parseLineJsonStream(readable, onObj) {
  // Buffer 累积：`indexOf(0x0a)` 找换行；剩下的半行留到下一块
  let pending = Buffer.alloc(0);
  // 一个 SSE 事件可含多行 `data:`（规范：以 \n 拼成一个负载）。累积到事件边界（空行）再解析。
  let dataLines = [];

  const emitJson = async (payload) => {
    const p = payload.trim();
    if (p === '' || p === '[DONE]') return; // 心跳 / 结束哨兵
    let obj;
    try {
      obj = JSON.parse(p);
    } catch {
      return; // 非 JSON 负载（注释 / 上游调试输出）—— 不解释，直接跳过
    }
    if (obj !== null && typeof obj === 'object') await onObj(obj);
  };

  // 事件边界（空行）或流结束时，把累积的 data 行拼起来解析
  const flushEvent = async () => {
    if (dataLines.length === 0) return;
    const joined = dataLines.join('\n');
    dataLines = [];
    await emitJson(joined);
  };

  const handleLine = async (raw) => {
    const trimmed = raw.toString('utf8').trim();
    if (trimmed === '') { await flushEvent(); return; }  // 空行 = SSE 事件边界
    if (trimmed.startsWith(':')) return;                 // SSE 注释行（心跳）
    if (trimmed.startsWith('data:')) {
      // 反证开关：退回"只认裸 JSON 行、不认 SSE 帧"⇒ 真上游的帧被整片丢弃，llm 全组空译文（D-130）
      if (REFUTE.legacyLineJsonOnly) return;
      let payload = trimmed.slice(5);
      if (payload.startsWith(' ')) payload = payload.slice(1); // 规范：`data:` 后可有一个空格
      dataLines.push(payload);
      return;
    }
    if (trimmed.startsWith('event:') || trimmed.startsWith('id:') || trimmed.startsWith('retry:')) return;
    // 无 SSE 前缀 ⇒ 按「裸 JSON 行」解析（兼容逐行 JSON 的上游 / 测试替身）
    await emitJson(trimmed);
  };

  for await (const chunk of readable) {
    // http 响应块恒为 Buffer；兼容字符串块（测试替身常用 `Readable.from(['…'])`），
    // 否则 Buffer.concat 会以 TypeError 把"半包处理"这条路径整个废掉
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
    let idx = pending.indexOf(0x0a);
    while (idx !== -1) {
      await handleLine(pending.subarray(0, idx));
      pending = pending.subarray(idx + 1);
      idx = pending.indexOf(0x0a);
    }
  }

  // 尾包：结束后仍有无换行的残余，按最后一行处理
  if (pending.length > 0) await handleLine(pending);
  // 流结束时未闭合的事件（最后一帧没有以空行收尾）
  await flushEvent();
}
