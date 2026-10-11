// 反证假平台 —— 证明「抽象层真的存在」的那件Mock
// =============================================================================
// 依据：在线翻译服务设计方案 §9 / §10（**仅测试注册**，不进产品 FACTORIES）。
//
// 它只有 `'text'` 能力、**不实现 translateStream**。验收脚本据此断言：
//   「请求 mode:'llm' 被能力协商挡下（TRANSLATE_CAPABILITY_UNSUPPORTED），
//     且**未发出任何网络请求**」。
// 若哪天门面绕过 capabilities 直接调 translateStream，这条断言立刻变红 ——
// 那就是抽象层漏了，而不是"假平台不配合"。

/**
 * 构建假平台适配器。
 * @returns {import('../contract.mjs').PlatformAdapter}
 */
export function create() {
  const supported = ['ja', 'en', 'zh', 'auto'];
  return {
    id: 'fake',
    label: '假平台',
    capabilities: new Set(['text']),
    langs: supported,

    langCode(short) {
      return supported.includes(short) ? short : null;
    },

    // 回显即可：验收要验的是"请求被能力协商挡下"，不是译文质量
    async translateText(req) {
      return { text: `[FAKE]${req.text}` };
    },

    // 刻意**不提供** translateStream —— 能力集没有 'llm'，门面不该、也不会调它
  };
}
