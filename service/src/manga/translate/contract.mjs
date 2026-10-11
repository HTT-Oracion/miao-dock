// 平台适配器契约 —— 门面（index.mjs）只认本契约，**不认任何平台**
// =============================================================================
// 依据：在线翻译服务设计方案 §4.1（契约）/ §4.2（能力协商）/ §4.4（注册表）。
// 本文件只做两件事：用 JSDoc typedef 写清形状；用 `assertAdapter()` 在**启动自检**时
// 校验形状（缺方法当场炸，不留到运行期）。它**不做业务**。
//
// 🔴 为什么「text 与 llm 是两个方法」而不是「一个方法 + stream 布尔」（§4.1）：
//    两类翻译的**失败语义不同** —— 流式吐了一半不能静默重来。合成一个方法，
//    调用方就没法表达"我接受流式语义"。契约层分开，让差异在类型上可见。

/**
 * 一次翻译请求（门面 → 适配器）。
 * @typedef {Object} TranslateRequest
 * @property {string}      text        待翻译文本（UTF-8）
 * @property {string}      from        源语言短码（'ja' | 'en' | 'zh' | 'auto'）
 * @property {string}      to          目标语言短码
 * @property {boolean}     [splitLines] 按行对齐：仅 text 能力有意义（见方案 §6.2）
 * @property {string}      [prompt]     仅 llm：提示词（有道限 1200 字符 / 400 词）
 * @property {string}      [model]      仅 llm：'pro' | 'lite'（有道 handleOption 0 / 3）
 * @property {string}      [domain]     仅 text：领域（general / computers / …）
 * @property {string}      [vocabId]    仅 text：术语表 ID（空串 = 不使用）
 * @property {number}      [timeoutMs]  覆盖默认总超时（适配器一般读 ctx.timeoutMs）
 * @property {AbortSignal} [signal]     外部取消（客户端断开时由门面传入）
 */

/**
 * 一次翻译的结果。
 * @typedef {Object} TranslateResult
 * @property {string}   text       译文（整体模式 = 全文；流式模式 = 累计全文）
 * @property {string}   [langType] 上游回报的目标语种（如 'zh-CHS'）
 * @property {string[]} [lines]    splitLines=true 且上游逐行对齐时，逐行译文
 * @property {object}   [raw]      上游原始响应（诊断用，默认不回流给前端）
 */

/**
 * 适配器运行期上下文。由门面在每次调用时**现攒现传**（含密钥，见方案 §8.4：
 * 适配器不缓存密钥，否则"改了密钥不生效"）。
 * @typedef {Object} AdapterCtx
 * @property {{postForm: Function, postStream: Function}} http   出网原语（http.mjs）
 * @property {{acquire: Function}}                        limiter 令牌桶（limiter.mjs）
 * @property {{appKey: string, appSecret: string}}         credentials 平台密钥（每次现读）
 * @property {number}    timeoutMs  本次调用的总超时预算（来自 settings）
 * @property {AbortSignal} [signal]  外部取消信号
 */

/**
 * 平台适配器契约。门面只依赖本契约 —— 这是"新增平台不改门面"的**唯一保证**。
 * @typedef {Object} PlatformAdapter
 * @property {string}   id                  平台标识（'youdao' …）
 * @property {string}   label               展示名（'有道智云'）
 * @property {Set<'llm'|'text'>} capabilities  支持的能力集合（门面据此协商，§4.2）
 * @property {string[]} [langs]             支持的短码清单（给 /translate/options 用）
 * @property {(short:string, api:'llm'|'text')=>string|null} langCode
 *           短码 → 平台语言码；**认不出返回 null，不猜**（方案 §4.3）
 * @property {(req:TranslateRequest, ctx:AdapterCtx)=>Promise<TranslateResult>} translateText
 *           普通文本翻译：**整体**返回。
 * @property {(req:TranslateRequest, onDelta:(d:string)=>void, ctx:AdapterCtx)=>Promise<TranslateResult>} [translateStream]
 *           大模型翻译：**流式**；每收到增量调一次 onDelta；返回时给累计全文。
 *           能力集不含 'llm' 的平台可以不实现（门面按 capabilities 拒绝，不调用）。
 * @property {(ctx:AdapterCtx)=>Promise<{ok:boolean, detail?:object}>} [probe]  可选：连通性探测
 */

/** 能力集合的合法取值（多一个token都没有意义 —— 拼错的能力等于静默阉割一个功能） */
const KNOWN_CAPABILITIES = new Set(['llm', 'text']);

/**
 * 运行期形状校验：缺 id / label / capabilities / translateText 当场抛 Error。
 * 由注册表在实例化每个适配器后调用（方案 §4.4 第 3 步）。
 * @param {any} a
 * @returns {asserts a is PlatformAdapter}
 */
export function assertAdapter(a) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) {
    throw new Error(`适配器必须是一个对象，收到 ${Array.isArray(a) ? 'array' : typeof a}`);
  }
  if (typeof a.id !== 'string' || a.id.trim() === '') {
    throw new Error('适配器缺少非空字符串 id');
  }
  if (typeof a.label !== 'string' || a.label.trim() === '') {
    throw new Error(`适配器 ${a.id} 缺少非空字符串 label`);
  }
  if (!(a.capabilities instanceof Set) || a.capabilities.size === 0) {
    throw new Error(`适配器 ${a.id} 的 capabilities 必须是非空 Set（'llm' | 'text'）`);
  }
  for (const cap of a.capabilities) {
    if (!KNOWN_CAPABILITIES.has(cap)) {
      throw new Error(`适配器 ${a.id} 的 capabilities 含未知能力 ${JSON.stringify(cap)}（合法：${[...KNOWN_CAPABILITIES].join(' | ')}）`);
    }
  }
  if (typeof a.translateText !== 'function') {
    throw new Error(`适配器 ${a.id} 缺少 translateText 方法（text 能力是必填基线）`);
  }
  if (a.capabilities.has('llm') && typeof a.translateStream !== 'function') {
    throw new Error(`适配器 ${a.id} 声明了 'llm' 能力但未实现 translateStream 方法`);
  }
  if (typeof a.langCode !== 'function') {
    throw new Error(`适配器 ${a.id} 缺少 langCode 方法（短码 → 平台语言码的归一入口）`);
  }
}
