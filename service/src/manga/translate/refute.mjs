// 在线翻译**反证开关**（集中一处，可 grep）—— 与 `config.mjs` 的 `SETTINGS_REFUTE` / `contractRefute` 同族
// =============================================================================
// 依据：在线翻译服务设计方案 §10（反证必须成对：破坏什么 → 哪条断言变红）。
//
// 🔴 只被 `e2e/service/translate-check.mjs --refute` 的**子进程**设置；产品路径永不设置。
//    每个开关把一条硬约束退回成"没有这条约束"，用来证明断言咬的是**机制本身**，
//    而不是"碰巧绿"（AGENTS.md §2-1：只跑正向等于没验证）。
//
// 🔴 为什么集中在一处、而不是散在被它改写的代码旁：散着放的下场是
//    「反证跑绿了，但没人说得清它到底关掉了什么」。集中放，"本仓有哪些反证开关"
//    一次 grep 到手（同 `config.mjs:542-566` 的理由）。
//
// ⚠️ 模块顶层读 env ⇒ **进程内不可回滚** ⇒ 反证轮必须"一个开关一个子进程"
//    （见 check 脚本的 `runRefute`；`engine-settings-check.mjs` 的同款纪律）。

/** 读布尔开关：没设 / 空串 = false；`0/false/no/off` = false；其余 = true */
function envBool(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return false;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

export const REFUTE = {
  /** 签名去掉 `input` 截断（长文本直连）⇒ 假上游回算 sign 不一致、回 202（方案 §10 反证表第 1 行） */
  noTruncate: envBool('MIAO_TRANSLATE_REFUTE_NO_TRUNCATE'),
  /** 重试复用旧 `salt` + `curtime` + `sign` ⇒ 第二次必撞上游防重放 207（第 2 行） */
  reuseSalt: envBool('MIAO_TRANSLATE_REFUTE_REUSE_SALT'),
  /** `idleMs` 并进 `totalMs`（少一档超时）⇒「卡住」与「慢慢吐」不再可分（第 3 行） */
  idleAsTotal: envBool('MIAO_TRANSLATE_REFUTE_IDLE_AS_TOTAL'),
  /** 密钥视图回显 `appSecret` ⇒「secret 永不回显」被破坏（第 4 行） */
  echoSecret: envBool('MIAO_TRANSLATE_REFUTE_ECHO_SECRET'),
  /** 流式首块之后仍重试 ⇒ 已吐给用户的增量被重复/覆盖（第 5 行） */
  streamRetryAfterFirst: envBool('MIAO_TRANSLATE_REFUTE_STREAM_RETRY_AFTER_FIRST'),
  /** 两个接口判成功逻辑互换 ⇒ text 的 `errorCode:"0"` 被判失败、llm 的双判被废（第 6 行） */
  swapJudge: envBool('MIAO_TRANSLATE_REFUTE_SWAP_JUDGE'),
  /** 流式解析只认裸 JSON 行、丢弃 SSE `data:` 帧（退回"不认识真上游帧格式"）⇒ llm 全组空译文（第 7 行；D-130） */
  legacyLineJsonOnly: envBool('MIAO_TRANSLATE_REFUTE_LEGACY_LINE_JSON'),
  /** 流式不做"200 但零帧即报错"兜底 ⇒ 退回"成功 + 空译文"假象（第 8 行；D-130） */
  noFrameGuard: envBool('MIAO_TRANSLATE_REFUTE_NO_FRAME_GUARD'),
};
