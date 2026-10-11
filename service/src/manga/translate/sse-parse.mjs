// 上游流解析 —— 把有道 llm 的 `text/event-stream` 切成 JSON 对象流
// =============================================================================
// 🔴 有道的流式响应是**逐行 JSON**，**不是**标准 SSE 的 `data:` 分帧：
//    每一行本身就是一个完整 JSON（`{"code":"0","data":{"transIncre":"…"}}`）。
//    所以这里不解析 `event:`/`data:`/`id:` 字段，只按 `\n` 切行、逐行 `JSON.parse`。
//    半包（一行被拆在两个 TCP 块里）与尾包（最后一块没有换行符）都必须能吃下。

/**
 * 逐行解析 JSON 流。
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

  const handleLine = async (raw) => {
    // 去掉可能的 \r（CRLF）与首尾空白后：空行跳过、非 JSON 行跳过
    const line = raw.toString('utf8').trim();
    if (line === '') return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（注释行 / 心跳 / 上游调试输出）—— 不解释，直接跳过
    }
    if (obj !== null && typeof obj === 'object') await onObj(obj);
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
}
