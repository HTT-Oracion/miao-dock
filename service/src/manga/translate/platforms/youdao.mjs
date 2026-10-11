// 有道智云平台适配器 —— 有道**全部细节**的唯一落点
// =============================================================================
// 契约依据：在线翻译服务设计方案 §5（签名 v3 / llm-trans / api 两接口）· §4.3（语言码）。
//
// 🔴 单一耦合点范式（同 `engine-client.mjs:1-9` 的姿态）：
//    本文件是**唯一**允许出现 `openapi.youdao.com`、`sign` 算法、`errorCode` 数字的地方。
//    换平台 = 新增 `platforms/<id>.mjs` + 注册表一行，**本文件之外不准泄漏任何平台细节**。
//    越过这条界泄漏字段名 / 签名 / 错误码 = 缺陷。
//
// 两个接口的判成功方式**不同**（这正是"契约统一、细节下沉"的意义）：
//   · llm-trans：`code === "0"`（字符串）**且** `successful === true`（布尔）双判；
//   · api（text）：`errorCode === "0"`（字符串）单判，**没有** `successful` 字段。

import crypto from 'node:crypto';

import { postForm, postStream } from '../http.mjs';
import { parseLineJsonStream } from '../sse-parse.mjs';
import { TranslateError, mapUpstreamError, translateErrorFrom } from '../errors.mjs';
import { REFUTE } from '../refute.mjs';

/**
 * 出网基址接缝（**验收专用**）：默认生产地址 `https://openapi.youdao.com`；
 * `MIAO_TRANSLATE_YOUDAO_BASE` 仅供 e2e 假上游覆盖（方案 §10：本地 http.Server 冒充上游）。
 *
 * 🔴 **每次调用现读**，不缓存成模块顶层 const：反证轮是"一个开关一个子进程"、
 *    而进程内还要在用例之间切址（如 T4 指向黑洞地址验 connect 层）—— 顶层常量
 *    会把这两种用法一起废掉。产品路径永不设这个变量 ⇒ 行为与接线前完全一致。
 */
function baseUrl() {
  const raw = process.env.MIAO_TRANSLATE_YOUDAO_BASE;
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v === '' ? 'https://openapi.youdao.com' : v.replace(/\/+$/, '');
}

/** 文本翻译（整体）端点路径（拼在基址之后） */
const TEXT_API_PATH = '/api';
/** 大模型翻译（流式）端点路径 */
const LLM_API_PATH = '/proxy/http/llm-trans';

/**
 * 超时层的 env 覆盖（**验收夹具专用**，方案 §7.1 五层在业务路径用前四层）。
 *
 * 🔴 非法值**当场抛**，不静默回退：静默回退会让夹具"以为设成了 400ms、实际等满
 *    15s"，而 15s 的等待长得像"脚本卡死"而不是"配置没生效"——正是本项目最反对的
 *    那类难查假象（同 `config.mjs` `envIntOrNull` 的纪律）。
 */
function envMs(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} 取值非法：${JSON.stringify(raw)}（应为正数，毫秒）`);
  }
  return n;
}

/**
 * 本次调用的四层超时（connect / ttfb / idle / total；`probeMs` 不用于业务路径）。
 * env 覆盖只服务验收夹具；**默认值即生产值**（§7.1）。
 * @param {'text'|'llm'} api 决定 ttfb 默认档（text 15s / llm 20s）
 */
function timeoutsOf(api, ctx) {
  const totalMs = totalMsOf(ctx);
  return {
    connectMs: envMs('MIAO_TRANSLATE_CONNECT_MS', 5000),
    ttfbMs: envMs('MIAO_TRANSLATE_TTFB_MS', TTFB_MS[api]),
    // 反证开关：idleMs 并入 totalMs ⇒「卡住」与「慢慢吐」不再可分（check 的 T2 应变红）
    idleMs: REFUTE.idleAsTotal ? totalMs : envMs('MIAO_TRANSLATE_IDLE_MS', 20000),
    totalMs,
  };
}

/** 兜底总超时：与 `settings.mjs` 的 `DEFAULT_SETTINGS.timeoutMs` 一致。
 *  ctx 由门面保证必带；这里兜底是防 `undefined` 把 http 层的默认档**覆盖成 undefined**
 *  （`setTimeout(fn, undefined)` = 1ms 后触发，表现为"必然超时"的灵异故障）。 */
const FALLBACK_TOTAL_MS = 30000;

/** ttfb 分档（方案 §7.1）：大模型首字慢是常态，与"整段慢"是两件事，单独一档 */
const TTFB_MS = { text: 15000, llm: 20000 };

// ------------------------------------------------------------------ 语言码
// 🔴 **按接口分表**（方案 §5.4，P-G4 已裁定）：llm 的语种表更短。不为"少写一个参数"
//    合并两表 —— 合并的结果是把小语种方向送到不支持的接口上，得到 102，
//    而 UI 上看着只是"翻译失败"。
const LLM_LANG = { ja: 'ja', en: 'en', zh: 'zh-CHS', auto: 'auto' };
/** text 表 = llm 表 + 一批小语种（值同键） */
const TEXT_LANG = {
  ...LLM_LANG,
  ko: 'ko', ru: 'ru', fr: 'fr', de: 'de', es: 'es', it: 'it', pt: 'pt', vi: 'vi', id: 'id', th: 'th',
};

/** 平台支持的短码清单（两接口并集，给 `/translate/options` 展示用） */
export const YOUDAO_LANGS = Object.keys(TEXT_LANG);

/**
 * 短码 → 有道语言码；**认不出返回 null，不猜**。
 * 🔴 为什么不猜（方案 §4.3）：猜错的代价是"把日文当英文送"，而"送错方向"的产物
 *    往往**又长又像样**，最难发现。宁可当场报 400，不要静默送错。
 */
function youdaoLangCode(short, api) {
  const table = api === 'llm' ? LLM_LANG : TEXT_LANG;
  const code = table[short];
  return code === undefined ? null : code;
}

// ------------------------------------------------------------------ 签名 v3

/**
 * `input` 截断（方案 §5.1）：
 *   len(q) <= 20 → q 原样；否则 q前10 + len(q) + q后10。
 * 🔴 **len 按 UTF-16 码元 `q.length`**（照抄官方 JS demo，与上游实现对齐优先于"更正确"）：
 *    中日文本（BMP 内）每字 1 码元，与"字符数"一致无分歧；只有代理对（emoji、
 *    罕见汉字扩展区）会让 q.length 比真实字符数大 1。若真联调发现不一致，再改并登记台账。
 */
function truncateInput(q) {
  // 反证开关：去掉截断 ⇒ 长文本（>20 字符）签名算错，假上游回 202（check 的 S1 应变红）
  if (REFUTE.noTruncate) return q;
  return q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(-10);
}

/**
 * 签名五件套。🔴 **每次请求（含重试）都必须重新生成 salt + curtime + sign**（方案 §7.3）：
 * 有道用 `salt + curtime` 防重放，同一签名第二次发出去**必然** 207。
 * 把 sign 缓存在请求作用域里当"重试复用"，表现为"第一次偶发失败、重试也必失败"——
 * 看起来像上游不稳，实际是我们自己撞了防重放。
 */
function signV3(appKey, appSecret, q) {
  // 反证开关：重试复用旧 salt（同一 q 恒定）⇒ 假上游按防重放回 207（check 的 S3/S4 应变红）
  const salt = REFUTE.reuseSalt
    ? crypto.createHash('sha256').update(`reused-salt:${q}`).digest('hex')
    : crypto.randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  const input = truncateInput(q);
  const sign = crypto.createHash('sha256')
    .update(appKey + input + salt + curtime + appSecret)
    .digest('hex');
  return { appKey, salt, curtime, signType: 'v3', sign };
}

// ------------------------------------------------------------------ 取用辅助

/** 密钥每次调用现取、不缓存（方案 §8.4：否则"改了密钥不生效"） */
function assertCredentials(ctx) {
  const creds = (ctx && ctx.credentials) || {};
  if (!creds.appKey || !creds.appSecret) {
    throw new TranslateError('TRANSLATE_NOT_CONFIGURED',
      '尚未配置有道翻译密钥（appKey / appSecret），请到「设置 → 翻译来源」填写',
      { platform: 'youdao' });
  }
}

/** 总超时预算（见 FALLBACK_TOTAL_MS 的注释） */
function totalMsOf(ctx) {
  return Number.isFinite(ctx && ctx.timeoutMs) ? ctx.timeoutMs : FALLBACK_TOTAL_MS;
}

/**
 * 方向归一：认不出当场 400（带上游/平台上下文，不猜）。
 * @param {'text'|'llm'} api 决定查哪张语言码表
 */
function langPairOrThrow(req, api) {
  const from = youdaoLangCode(req.from, api);
  const to = youdaoLangCode(req.to, api);
  if (!from || !to) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `不支持的翻译方向：${JSON.stringify(req.from)} → ${JSON.stringify(req.to)}`,
      { platform: 'youdao', api, from: req.from, to: req.to });
  }
  return { from, to };
}

/** `handleOption`：pro → 0（子曰 14B）· lite → 3（1.5B）。缺省 pro，非法值当场抛（不静默回落） */
function handleOptionOf(model) {
  if (model === undefined || model === null || model === '') return '0';
  if (model === 'pro') return '0';
  if (model === 'lite') return '3';
  throw new TranslateError('TRANSLATE_INVALID_INPUT',
    `model 只支持 pro | lite，收到 ${JSON.stringify(model)}`, { model });
}

/**
 * 从 text 接口的 `l`（如 `'EN2zh-CHS'`）解析目标语种：上游用 `'2'` 分隔源与目标。
 * 取**第一个** `2` 之后的部分（目标语种自身不含 `2`）。
 */
function parseLangType(l) {
  const s = typeof l === 'string' ? l.trim() : '';
  if (s === '') return undefined;
  const i = s.indexOf('2');
  return i === -1 ? s : s.slice(i + 1);
}

/** 业务错误 → TranslateError（适配器里唯一的归一抛出口） */
function upstreamError(api, code) {
  return translateErrorFrom(mapUpstreamError('youdao', api, code));
}

// ------------------------------------------------------------------ 适配器

/**
 * 构建有道适配器（`registry.mjs` 的工厂目标）。
 * @returns {import('../contract.mjs').PlatformAdapter}
 */
export function create() {
  return {
    id: 'youdao',
    label: '有道智云',
    capabilities: new Set(['llm', 'text']),
    langs: YOUDAO_LANGS,

    langCode(short, api) {
      return youdaoLangCode(short, api);
    },

    /**
     * 普通文本翻译（整体）。POST `https://openapi.youdao.com/api`。
     * 🔴 判成功：`errorCode` 是**字符串**，`"0"` 才是成功（没有 successful 字段）。
     * 参数裁剪：`prompt` / `model` 不属于本能力，**主动丢弃**（方案 §5.4）。
     */
    async translateText(req, ctx) {
      assertCredentials(ctx);
      const { appKey, appSecret } = ctx.credentials;
      const { from, to } = langPairOrThrow(req, 'text');

      const q = String(req.text ?? '');
      const fields = {
        q,
        from,
        to,
        // domain 缺省按上游默认领域 'general'（与 settings 默认一致）
        domain: String(req.domain || 'general'),
        // strict：术语库未开通/未配置时不强制（默认 false），避免把普通译文也按术语库拧一遍
        strict: 'false',
        ...(String(req.vocabId || '').trim() !== '' ? { vocabId: String(req.vocabId).trim() } : {}),
        ...signV3(appKey, appSecret, q),
      };

      const res = await ctx.http.postForm(`${baseUrl()}${TEXT_API_PATH}`, {
        fields,
        timeouts: timeoutsOf('text', ctx),
        signal: ctx.signal,
      });

      let json;
      try {
        json = JSON.parse(res.body.toString('utf8'));
      } catch {
        throw new TranslateError('TRANSLATE_UPSTREAM_ERROR',
          `有道文本翻译响应不是合法 JSON（HTTP ${res.status}）`, { httpStatus: res.status });
      }

      // 反证开关：两接口判成功互换 ⇒ text 改用 llm 的双判，`errorCode:"0"` 被判失败
      //（check 的 A6/A10 等 text 成功用例应变红；方案 §10 反证表第 6 行）
      const textFailed = REFUTE.swapJudge
        ? (String(json.code) !== '0' || json.successful !== true)
        : String(json.errorCode) !== '0';
      if (textFailed) {
        throw upstreamError('text', REFUTE.swapJudge ? json.code : json.errorCode);
      }

      const translation = Array.isArray(json.translation) ? json.translation.map((x) => String(x)) : [];
      const result = { text: translation.join('\n'), raw: json };

      // 行对齐（方案 §6.2）：**只在**上游逐行数与入参行数一致时给 lines；
      // 长度不符就放弃对齐只回整串 —— 错位的"逐行译文"比"没逐行"危害大得多
      // （会把 A 行的译文贴到 B 行）。门面可据 lines 缺失判 aligned=false。
      const langType = parseLangType(json.l);
      if (langType !== undefined) result.langType = langType;
      if (req.splitLines && translation.length === String(req.text ?? '').split('\n').length) {
        result.lines = translation;
      }
      return result;
    },

    /**
     * 大模型翻译（流式）。POST `https://openapi.youdao.com/proxy/http/llm-trans`。
     * 响应是 **SSE 帧**（`event:message` + `data:{...}`）的 text/event-stream，由 `sse-parse` 切
     * （真上游实测为 SSE 帧，非"逐行 JSON"；见 D-130。sse-parse 两种形态都吃，向后兼容）。
     * 🔴 判成功：`code === "0"`（字符串）**且** `successful === true`（布尔）双判。
     * 累计归门面（方案 §6.1-2）：本方法只负责"解析出 transIncre 交给 onDelta"，
     * 累计全文由返回值给出，终态由门面统一。
     * 参数裁剪：`domain` / `vocabId` 不属于本能力，**主动丢弃**。
     */
    async translateStream(req, onDelta, ctx) {
      assertCredentials(ctx);
      const { appKey, appSecret } = ctx.credentials;
      const { from, to } = langPairOrThrow(req, 'llm');

      const i = String(req.text ?? '');
      const fields = {
        i,
        prompt: String(req.prompt ?? ''),
        from,
        to,
        // increment：只回增量。不用 full —— 全量模式每条都带前文，带宽随长度**二次**增长（O(n²)）
        streamType: 'increment',
        handleOption: handleOptionOf(req.model),
        ...signV3(appKey, appSecret, i),
      };

      const res = await ctx.http.postStream(`${baseUrl()}${LLM_API_PATH}`, {
        fields,
        timeouts: timeoutsOf('llm', ctx),
        signal: ctx.signal,
      });

      // 🔴 非 2xx 必须先判死：流式路径的"成功"只由逐行 JSON 表达，一个 5xx 垃圾体
      //    会被 parseLineJsonStream 静默跳过 ⇒ 返回空译文 + translate.done ——
      //    用户看到的是"译了一整遍，结果是空的"。text 路径有 JSON.parse 兜底，
      //    流式没有，所以这一判只能在这里（且必须在解析第一行之前）。
      if (res.status < 200 || res.status >= 300) {
        throw new TranslateError('TRANSLATE_UPSTREAM_ERROR',
          `有道大模型翻译上游返回 HTTP ${res.status}`, { httpStatus: res.status });
      }

      let full = '';
      let langType;
      let frames = 0; // 解析出的帧数（零帧 ⇒ D-130 的"成功但空译文"兜底判据）
      // 首块之前的业务错误经 mapUpstreamError 抛 TranslateError（门面据此判定可重试）；
      // onObj 里抛错会中断 for-await，流随之销毁，不会继续拉上游（按量计费）。
      // onObj 声明为 async 并 `await onDelta`：门面传来的 onDelta 可能是 async
      //（路由层背压：下游 write 返回 false 时在 onDelta 里等 'drain'）。这里不 await 的话
      // 那个 Promise 被丢弃，背压链在适配器这一环断裂，上游读取节奏不再跟随下游（方案 §6.4）。
      // 业务逻辑不变：仍只负责"解析出 transIncre 交给 onDelta"，累计由返回值给出。
      await parseLineJsonStream(res.stream, async (obj) => {
        frames += 1;
        // 反证开关：两接口判成功互换 ⇒ llm 改用 text 的单判，双判被废
        //（check 的 A7/A10 等 llm 成功用例应变红；方案 §10 反证表第 6 行）
        const llmFailed = REFUTE.swapJudge
          ? String(obj.errorCode) !== '0'
          : (String(obj.code) !== '0' || obj.successful !== true);
        if (llmFailed) {
          // code:"0" 但 successful !== true：双判**第二关**没过。直接 mapUpstreamError('0') 只会
          // 说"上游返回未登记的错误码 0"（D-129 记录在案的误导文案）——这里显式给出真正的原因。
          if (!REFUTE.swapJudge && String(obj.code) === '0') {
            throw new TranslateError('TRANSLATE_UPSTREAM_ERROR',
              '有道大模型翻译回了成功码但未标记成功（successful≠true），通常意味着该应用未开通「大模型翻译」服务',
              { platform: 'youdao', api: 'llm', upstreamCode: '0', successful: obj.successful === true });
          }
          throw upstreamError('llm', REFUTE.swapJudge ? obj.errorCode : obj.code);
        }
        const data = obj.data || {};
        if (typeof data.transIncre === 'string' && data.transIncre !== '') {
          full += data.transIncre;
          await onDelta(data.transIncre);
        }
        if (typeof data.langType === 'string' && data.langType !== '') {
          langType = data.langType;
        }
      });

      // 🔴 200 但**零帧**：协议错配（如"拿裸 JSON 行去解 SSE 帧"）或空响应 ⇒ 绝不返回
      //    "成功 + 空译文"。这是与"非 2xx 先判死"配对的另一半（D-130）：前者挡已经挂掉的
      //    上游，这一判挡"回话了、我们却读不出"的上游。缺了它，用户看到的又是
      //    "译了一整遍，结果是空的"。零帧 ⇒ 首块锁定未触发 ⇒ 门面仍可重试（链路类错误）。
      if (frames === 0 && !REFUTE.noFrameGuard) {
        throw new TranslateError('TRANSLATE_UPSTREAM_ERROR',
          '有道大模型翻译上游返回 200 但没有任何可解析的事件帧（协议不匹配或空响应），已阻止「成功但空译文」的假象',
          { platform: 'youdao', api: 'llm', httpStatus: res.status, reason: 'no_frames' });
      }

      const result = { text: full };
      if (langType !== undefined) result.langType = langType;
      return result;
    },
  };
}
