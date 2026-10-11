// 翻译错误归一 —— 统一码表 + 上游错误码 → 统一码映射（**纯函数**，可反证）
// =============================================================================
// 依据：在线翻译服务设计方案 §7.2。
// 本文件**不 import 根 `errors.mjs`**（那是跨模块底座：HTTP 信封 + 全局码表，改动面最大）——
// 翻译域的错误归在本域闭环，最终由门面翻译成 `ApiError` 出信封。
//
// 🔴 为什么每条都要独立码、不肯合并（沿用根 errors.mjs:24-32 的纪律）：
//    `429` 该让用户"等一会儿再点"，`503` 该让用户"去填密钥"。合并成"翻译失败"，
//    用户只能反复重试 —— 那是把一句假话讲给用户听。
// 本文件**不抛不接 HTTP**：只做「上游怎么说 → 我们怎么归类」的纯映射。

/** 统一码表 → HTTP 状态（方案 §7.2；由门面转成 ApiError 时取用） */
export const TRANSLATE_CODES = {
  /** 无 appKey / appSecret ⇒ 用户要做的是"去填密钥" */
  TRANSLATE_NOT_CONFIGURED: 503,
  /** 密钥或应用配置错（108/110/112/202/203/205/206/207） */
  TRANSLATE_AUTH_FAILED: 502,
  /** 本地校验失败（空文本 / 超长 / 未知方向 / 缺参 / 不支持的语言） */
  TRANSLATE_INVALID_INPUT: 400,
  /** 文本超过上游长度上限（103） */
  TRANSLATE_TEXT_TOO_LONG: 400,
  /** 频率受限（411/412） */
  TRANSLATE_RATE_LIMITED: 429,
  /** 欠费（401） */
  TRANSLATE_QUOTA_EXCEEDED: 402,
  /** 未开通领域（310）/ 能力协商失败 */
  TRANSLATE_UNSUPPORTED_FEATURE: 400,
  /** 上游业务错误（1/301/302/303/304/902000）或 5xx */
  TRANSLATE_UPSTREAM_ERROR: 502,
  /** 根本到不了上游（ENOTFOUND/ECONNREFUSED/ECONNRESET/EAI_AGAIN） */
  TRANSLATE_UPSTREAM_UNREACHABLE: 502,
  /** 任一层超时（details.stage 标明是哪一层） */
  TRANSLATE_TIMEOUT: 504,
  /** 请求的能力平台不支持（mode:'llm' 而平台只有 'text'） */
  TRANSLATE_CAPABILITY_UNSUPPORTED: 400,
};

/**
 * 翻译错误。`status` 由码表给出（同根 `ApiError` 的姿态），门面直接可用。
 */
export class TranslateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
    this.status = TRANSLATE_CODES[code] ?? 502;
    this.details = details || {};
  }
}

/** 把 `mapUpstreamError` 的归一结果包成可抛的错误（适配器里的唯一抛出口） */
export function translateErrorFrom(mapped) {
  return new TranslateError(mapped.code, mapped.message, mapped.details);
}

// ------------------------------------------------------------------ 有道两接口错误码表
// 🔴 **按「平台 × 接口」分列**（方案 §7.2）：有道 text 与 llm 两接口的码**不完全重合**
//    （text 有 401/411/412/103/309/310，llm 有 902000/110）。合并成一张表的代价是
//    把小语种/领域错误送到另一张表上查不到 → 全落兜底，归因全丢。
// 新平台接入时在这里**加一列**（方案 §9：错误码是唯一需要扩表的地方）。

/** 有道文本翻译（`/api`）错误码 → 统一码（方案 §5.3） */
const YOUDAO_TEXT_CODES = {
  '101': ['TRANSLATE_INVALID_INPUT', '上游报告缺少必填参数'],
  '102': ['TRANSLATE_INVALID_INPUT', '上游不支持该翻译方向'],
  '103': ['TRANSLATE_TEXT_TOO_LONG', '待翻译文本超过上游单次长度上限（5000 字符）'],
  '108': ['TRANSLATE_AUTH_FAILED', '应用 ID（appKey）无效'],
  '110': ['TRANSLATE_AUTH_FAILED', '应用不存在或未生效'],
  '112': ['TRANSLATE_AUTH_FAILED', '所请求的翻译服务不存在'],
  '116': ['TRANSLATE_INVALID_INPUT', '上游报告参数无效'],
  '202': ['TRANSLATE_AUTH_FAILED', '签名校验失败（appSecret 或签名算法有误）'],
  '203': ['TRANSLATE_AUTH_FAILED', '来源 IP 不在应用的白名单内'],
  '205': ['TRANSLATE_AUTH_FAILED', '应用平台类型与请求不一致'],
  '206': ['TRANSLATE_AUTH_FAILED', '时间戳无效（本地时钟偏差过大）'],
  // 重放：本仓的硬约束是「每次请求（含重试）重算 salt + curtime + sign」——
  // 撞 207 先怀疑我们自己复用了签名，而不是上游不稳（方案 §7.3）。
  '207': ['TRANSLATE_AUTH_FAILED', '重复请求被上游拒绝（salt/curtime 必须每次重新生成）'],
  '301': ['TRANSLATE_UPSTREAM_ERROR', '上游词典查询失败'],
  '302': ['TRANSLATE_UPSTREAM_ERROR', '上游翻译查询失败'],
  '303': ['TRANSLATE_UPSTREAM_ERROR', '上游服务端异常'],
  '304': ['TRANSLATE_UPSTREAM_ERROR', '上游翻译失败'],
  '308': ['TRANSLATE_INVALID_INPUT', '上游报告参数无效'],
  '309': ['TRANSLATE_INVALID_INPUT', '领域（domain）参数错误'],
  '310': ['TRANSLATE_UNSUPPORTED_FEATURE', '该翻译领域未开通'],
  '401': ['TRANSLATE_QUOTA_EXCEEDED', '账户欠费，请充值后重试'],
  '411': ['TRANSLATE_RATE_LIMITED', '请求频率超过上游限制，请稍后再试'],
  '412': ['TRANSLATE_RATE_LIMITED', '请求字符数超过上游限额，请稍后再试'],
};

/** 有道大模型翻译（`llm-trans`）错误码 → 统一码（方案 §5.2；表比 text 短） */
const YOUDAO_LLM_CODES = {
  '1': ['TRANSLATE_UPSTREAM_ERROR', '上游未知错误'],
  '101': ['TRANSLATE_INVALID_INPUT', '上游报告缺少必填参数'],
  '108': ['TRANSLATE_AUTH_FAILED', '应用 ID（appKey）无效'],
  '110': ['TRANSLATE_AUTH_FAILED', '应用没有该接口的权限'],
  '112': ['TRANSLATE_AUTH_FAILED', '所请求的翻译服务不存在'],
  '202': ['TRANSLATE_AUTH_FAILED', '签名校验失败（appSecret 或签名算法有误）'],
  '206': ['TRANSLATE_AUTH_FAILED', '时间戳无效（本地时钟偏差过大）'],
  '207': ['TRANSLATE_AUTH_FAILED', '重复请求被上游拒绝（salt/curtime 必须每次重新生成）'],
  '902000': ['TRANSLATE_UPSTREAM_ERROR', '上游大模型翻译调用失败'],
};

/** 网络错误族：到了这些码，问题在**链路**不在业务（方案 §7.2） */
const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN']);
/** message 兜底：有些底层错误只把名字写在 message 里（DNS / 连接被拒 / 套接挂断） */
const NETWORK_MESSAGE_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up/i;

/**
 * 把上游错误（业务码或 node 原生 Error）归一成 `{code, message, details}`。
 *
 * @param {string} platform    平台 id（'youdao' …）
 * @param {'llm'|'text'} api   平台内接口（决定查哪张码表）
 * @param {number|string|Error} codeOrErr 上游错误码，或出网原语抛出的原生 Error
 * @returns {{code:string, message:string, details:object}}
 */
export function mapUpstreamError(platform, api, codeOrErr) {
  // ① Error：超时 / 网络族 / 5xx / 兜底
  if (codeOrErr instanceof Error) {
    return mapNativeError(platform, api, codeOrErr);
  }

  // ② 业务码：查「平台 × 接口」表。码统一按字符串比（有道的 errorCode/code 都是**字符串**）
  const key = String(codeOrErr);
  const table = platform === 'youdao'
    ? (api === 'llm' ? YOUDAO_LLM_CODES : YOUDAO_TEXT_CODES)
    : null;
  const hit = table ? table[key] : null;
  if (hit) {
    return {
      code: hit[0],
      message: hit[1],
      details: { platform, api, upstreamCode: key },
    };
  }
  return {
    code: 'TRANSLATE_UPSTREAM_ERROR',
    message: table
      ? `上游返回未登记的错误码 ${key}（平台 ${platform} 接口 ${api}）`
      : `平台 ${platform} 尚未登记错误码表，收到 ${key}`,
    details: { platform, api, upstreamCode: key },
  };
}

/** Error 分支：先超时、再网络族、再 5xx、最后兜底（顺序即优先级） */
function mapNativeError(platform, api, err) {
  const base = { platform, api, native: err.code || null };

  // 超时：出网原语在 error 上带 `details.stage`（哪一层：connect/ttfb/idle/total）
  const stage = err.details && err.details.stage;
  if (stage) {
    return {
      code: 'TRANSLATE_TIMEOUT',
      message: `出网请求超时（${stage} 层）：${err.message}`,
      details: { ...base, stage },
    };
  }

  if (NETWORK_CODES.has(err.code) || NETWORK_MESSAGE_RE.test(String(err.message || ''))) {
    return {
      code: 'TRANSLATE_UPSTREAM_UNREACHABLE',
      message: `无法连接到翻译平台 ${platform}（${err.code || err.message}）`,
      details: base,
    };
  }

  // HTTP 5xx（出网原语把状态码原样交回来，由这里归类）
  if (Number.isInteger(err.status) && err.status >= 500) {
    return {
      code: 'TRANSLATE_UPSTREAM_ERROR',
      message: `翻译平台 ${platform} 服务端错误（HTTP ${err.status}）`,
      details: { ...base, httpStatus: err.status },
    };
  }

  // 取消（signal abort）不是上游错误 —— 门面自己判定客户端断开；这里只保证纯函数全定义。
  if (err.code === 'ABORT_ERR') {
    return {
      code: 'TRANSLATE_UPSTREAM_ERROR',
      message: '出网请求被取消',
      details: base,
    };
  }

  return {
    code: 'TRANSLATE_UPSTREAM_ERROR',
    message: `调用翻译平台 ${platform} 失败：${err.message}`,
    details: base,
  };
}
