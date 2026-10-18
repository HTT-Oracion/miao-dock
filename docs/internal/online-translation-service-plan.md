# 在线翻译服务接入 · 设计方案（ver1 · 有道智云首发）

> **目的**：把「在线翻译服务」从需求变成可执行的实现方案 —— 本文只管**架构、接口与流程**；里程碑排期见 §11，待裁定项见 §12。
>
> **依据**：
> - 有道官方接口文档 · [大模型翻译](https://ai.youdao.com/DOCSIRMA/html/trans/api/dmxfy/index.html) · [文本翻译](https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/)
> - 本仓库既有事实（逐条带文件证据，见 §2）—— 2026-10-10 在 `miao-dock` 工作区回读核实
>
> **纪律**（沿用 `AGENTS.md`）：每条"现状"带文件证据；每个"待实测"写清测法；**未实测的数字给区间不给精确值**；
> 决策与坑最终要落 `docs/internal/spec-notes.md`（`D-xx`），本文编号 **P-xx** 只作本方案的内部引用。

---

## 0. 结论（先给判断）

| 问题 | 判定 | 依据 |
|---|---|---|
| 落点选哪一层？ | **`manga-service`（`service/src/`）新增 `translate/` 模块**，不经引擎。 | 流式要打到 UI ⇒ 必须有 SSE 出口，而 SSE 与鉴权、错误信封、设置持久化都在 `service/`（§2） |
| 现有代码能不能直接撑住？ | **能，且大半是现成的**：SSE 写出、错误信封、设置三层回退 + 原子写、单一耦合点范式都已存在。 | §2 逐条 |
| 平台扩展性够不够？ | **够**：平台 = 「一个文件 + 注册表一行」，门面/路由/配置骨架都不动。 | §4.4 / §9 |
| 最大的技术风险在哪？ | **不在架构，在两个协议细节**：① 签名 v3 的 `input` 截断规则（中文按**字符**算长度）；② 重试必须**重算 salt+curtime+sign**，否则撞有道防重放（`207`）。 | §5.1 / §7.3 |
| 现在能不能联调？ | **不能**（缺 appKey/appSecret，且出网需可达 `openapi.youdao.com`）⇒ 验收以**本地假上游**为主，真联调单列。 | §10 |

**一句话**：方案沿用本项目已经跑通的「单一耦合点 + 契约式适配器 + 三层设置」三件套，新增的只有"出网"这一件事；真正要小心的是签名与重放，而不是分层。

---

## 1. 目标与非目标

### 1.1 目标

1. **可扩展**：当前只接有道智云，未来新增平台（百度 / 腾讯 / 火山 / DeepL / 自建 LLM…）**不改门面与路由**。
2. **两类翻译分开**：
   - **大模型翻译（`llm`）** —— 输入文本，**流式（SSE）**逐字回吐；
   - **普通文本翻译（`text`）** —— 输入文本，**整体**返回。
3. **统一接口**：两类能力由一份**平台适配器契约**描述，门面只认契约、不认平台。
4. **错误与超时可归因**：网络不可达 / 超时 / 限流 / 鉴权失败 / 文本过长 / 防重放 —— 各自有独立错误码，**不许合并成一个"翻译失败"**。
5. **配置可加载、可管理、可持久**：密钥与普通设置分开，密钥**永不回显**。

### 1.2 非目标（本版明确不做）

- ❌ **不替代现有图像翻译链路**（`engine-client.mjs` ↔ 本地引擎）。二者是**并列的两条能力**，本版不打通。
- ❌ 不做插件的"按平台选翻译器"（那是 `miao-trans` 仓 + 引擎侧的事，另立项）。
- ❌ 不做批量文档翻译 / 术语表管理 UI / 计费对账面板。
- ❌ 不做流式**重放**（断线重连续传半个译文）—— 一次流一次生命周期，断了重发（§7.3 的"未吐出则重试"）。

---

## 2. 现状取证：为什么落在 `service/`，以及哪些件可以复用

| 能力 | 现状（证据） | 本方案怎么用 |
|---|---|---|
| **出网 HTTP 原语** | ❌ **没有**。`service/src/` 只出过到**本机**引擎的请求（`engine-client.mjs:95-132` 的 `requestOnce` 硬编码 `config.engineHost/enginePort`） | **新增 `translate/http.mjs`**（真出网：超时分层 / 代理 / 重定向 / gzip）——本方案唯一"从零"的件 |
| **SSE 写出** | ✅ `service/src/sse.mjs:4-36`（`SSE_HEADERS` / `formatSseEvent` / `writeSseEvent` / `writeComment`），已被任务事件流用（`server.mjs:1107-1124`） | **直接复用**流式出口，新增事件类型 `translate.delta` / `.done` / `.error` |
| **错误信封** | ✅ `service/src/errors.mjs:1-83` —— 统一 `{ error: { code, message, details } }` + `ApiError` + `CODES` 表 | **扩表不改造**：新增一组 `TRANSLATE_*` 码（§7.2） |
| **设置：三层回退 + 白名单 + 原子写** | ✅ `service/src/engine-settings.mjs`（`ENGINE_SETTINGS_KEYS` 白名单 `:40-42`；`mergeWithEnv` `:301-338`；`writeEngineSettings` 原子写 `:237-267`）+ `config.mjs:226-251` 的合并与来源 | **照抄范式**为 `translate/settings.mjs`（§8） |
| **路由与鉴权** | ✅ `server.mjs:1520-1630`（`splitPath` + if 链）· 鉴权在 `:1641-1660`（`X-Box-Token` + Origin 白名单） | 新增 5 条路由（§6.3），**自动继承鉴权** |
| **单一耦合点范式** | ✅ `engine-client.mjs:1-9` 明写"本文件是唯一耦合点，换引擎只改这里" | **平台适配器**沿用同一姿态：`platforms/<id>.mjs` 是各平台细节的**唯一落点** |
| **零第三方依赖** | ✅ `config.mjs:2`「仅使用 `node:*` 内置模块，零第三方依赖」 | 签名用 `node:crypto` 的 `createHash('sha256')`，UUID 用 `crypto.randomUUID()` —— **不需要新依赖** |
| **验收范式** | ✅ `check:engine-client` 用 OpenAPI 快照当"假引擎"，零网络秒级 | **新增本地假上游**（§10），零网络可反证 |

> 🔴 **一个必须写下来的判断**：把在线翻译放进**引擎**（Python）是错的 —— 引擎的产物是"整张译图"，**没有逐字回吐到 UI 的通路**；而"流式"是**产品需求**（用户要边译边看），不是实现偏好。⇒ 结论：落在 `service/`。

---

## 3. 总体架构与模块划分

```
┌───────────────────────────── 桌面壳 / 前端（app/） ─────────────────────────────┐
│  翻译面板：普通翻译（一次出全文） · 大模型翻译（边出边显示）                      │
└───────────▲─────────────────────────────────▲─────────────────────────────────┘
            │ POST /api/v1/translate/text       │ POST /api/v1/translate/stream（SSE）
            │ （JSON 整体）                      │ （逐条 translate.delta）
┌───────────┴─────────────────────────────────┴─────────────────────────────────┐
│                       manga-service（service/src/）· 鉴权 / 错误信封 / SSE           │
│  ┌──────────────── translate/index.mjs（门面 facade）─────────────────┐         │
│  │  translateText(req) → { text, langType }        ← 整体              │         │
│  │  translateStream(req, emit) → void（回调逐块）  ← 流式              │         │
│  │  职责：入参校验 · 语言码归一 · 限流 · 超时编排 · 错误归一 · 重试     │         │
│  └──────┬───────────────────────────────┬──────────────────────┬─────┘         │
│         │ registry.mjs                  │ settings.mjs         │ errors.mjs    │
│         │ （id → 适配器工厂 · 能力查询） │ credentials.mjs      │ （码映射表）  │
│         ▼                               ▼                      ▲              │
│  ┌──────────────── platforms/<id>.mjs（平台适配器 · 契约实现）──────┐│              │
│  │  youdao.mjs（有道智云）：llm↑流式 / text↑整体                      ││              │
│  └───────────────────────────┬──────────────────────────────────────┘│              │
│                              ▼                                        │              │
│                    http.mjs（出网原语）· sse-parse.mjs（上游流解析）──┘              │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼  HTTPS（form-encoded / text-event-stream）
                    openapi.youdao.com（llm-trans · api）
```

**模块职责表**（全部新增，除注明复用）：

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `translate/index.mjs` | **门面**：唯一的对外调用入口（`translateText` / `translateStream`）；入参校验、方向归一、限流、超时编排、错误归一、按需重试 | 不碰任何平台字段名；不知道 `llm-trans` 这个词 |
| `translate/registry.mjs` | 平台注册表：`id → 适配器工厂`；`capabilities(id)` 查询；`list()` 给 `/options` 用 | 不含任何平台逻辑 |
| `translate/contract.mjs` | **契约**：适配器必须实现哪些方法、返回什么形状（JSDoc typedef + 运行期 shape 断言）；`assertAdapter()` | 不做业务 |
| `translate/platforms/youdao.mjs` | 有道智云的**全部细节**：签名、字段名、语言码、流式解析、错误码 | 不写文件、不读 env、不打日志之外的副作用 |
| `translate/http.mjs` | 出网原语：`postForm` / `postStream`；**超时分层**、压缩、重定向、代理旁路 | 不认识有道；不解析业务 |
| `translate/sse-parse.mjs` | 把上游 **逐行 JSON 的 `text/event-stream`** 切成 JSON 对象流；处理半包 / 尾包 | 不解释字段 |
| `translate/limiter.mjs` | 每平台令牌桶（QPS + 并发上限），零依赖 | 不做队列持久化 |
| `translate/errors.mjs` | 统一码定义 + **有道 `errorCode` → 统一码** 的映射（纯函数，可反证） | 不抛不接 HTTP |
| `translate/settings.mjs` | 非密钥设置：白名单 + 校验 + 原子写 + env 合并 + 来源追踪 | **不存密钥** |
| `translate/credentials.mjs` | 密钥文件（`0600`）：读写 appSecret；**永不进 API 响应** | 不参与"来源追踪"回显 |
| `server.mjs`（改） | 5 条路由 + 事件类型 | 只做搬运与鉴权 |

---

## 4. 平台抽象层：统一接口设计

### 4.1 契约（适配器必须实现的东西）

```js
/**
 * @typedef {Object} TranslateRequest
 * @property {string}      text        待翻译文本（UTF-8）
 * @property {string}      from        短码（'ja' | 'en' | 'zh' | 'auto'）
 * @property {string}      to          短码
 * @property {boolean}     [splitLines] 按行对齐（默认 false，见 §6.2）
 * @property {string}      [prompt]     仅 llm：提示词（有道限 1200 字符 / 400 词）
 * @property {string}      [model]      仅 llm：'pro' | 'lite'（有道 handleOption 0 / 3）
 * @property {string}      [domain]     仅 text：领域（general/…）
 * @property {string}      [vocabId]    术语表 ID
 * @property {number}      [timeoutMs]  覆盖默认超时
 * @property {AbortSignal} [signal]     外部取消（客户端断开时由门面传入）
 */

/**
 * @typedef {Object} TranslateResult
 * @property {string}  text       译文（整体模式 = 全文；流式模式 = 累计全文）
 * @property {string}  [langType] 上游回报的目标语种
 * @property {string[]}[lines]    splitLines=true 时，逐行译文
 * @property {object}  [raw]      上游原始响应（诊断用，默认不回流给前端）
 */

/**
 * 平台适配器契约。门面只依赖本契约 —— 这是"新增平台不改门面"的**唯一保证**。
 * @typedef {Object} PlatformAdapter
 * @property {string}   id                  平台标识（'youdao' …）
 * @property {string}   label               展示名（'有道智云'）
 * @property {Set<'llm'|'text'>} capabilities  支持的能力集合
 * @property {(short:string)=>string} langCode  短码 → 平台语言码（认不出返回 null）
 * @property {(req:TranslateRequest, http:HttpPort, limiter) => Promise<TranslateResult>} translateText
 *           普通文本翻译：**整体**返回。
 * @property {(req:TranslateRequest, onDelta:(d:string)=>void, http:HttpPort, limiter) => Promise<TranslateResult>} translateStream
 *           大模型翻译：**流式**；每收到增量调一次 onDelta；返回时给累计全文。
 *           能力集不含 'llm' 的平台可以不实现（门面按 capabilities 拒绝，不调用）。
 * @property {() => Promise<{ok:boolean, detail?:object}>} [probe]  可选：连通性/额度探测
 */
```

**门面契约（唯一对外）**：

```js
// 整体
translateText({ platform, mode:'text', ...req }) -> Promise<TranslateResult>
// 流式
translateStream({ platform, mode:'llm', ...req }, { onDelta, onDone, signal }) -> Promise<void>
```

🔴 **为什么用「两个方法」而不是「一个方法 + stream 布尔」**：两类翻译的**失败语义不同**（流式吐了一半不能静默重来，§7.3），把它们合成一个方法，调用方就没法表达"我接受流式语义"。契约层就把它们分开，让差异**在类型上可见**。

### 4.2 能力协商

- 注册表登记每个平台的能力集（`Set`）。
- 门面入口先查 `capabilities`：请求 `mode:'llm'` 而平台不支持 ⇒ 立刻 `TRANSLATE_CAPABILITY_UNSUPPORTED`（**不落到适配器**）。
- `/translate/options` 把各平台能力回给前端，前端据此决定按钮是"可用/灰置"。

### 4.3 语言码映射

- miao-dock 内部一律用**短码**（与 `config.mjs:572-575` 的 `TRANSLATE_DIRECTIONS` 同源）。
- 映射由**平台适配器**负责（`langCode()`）：`{ ja:'ja', en:'en', zh:'zh-CHS', auto:'auto' }`。
- 🔴 **认不出必须返回 `null`、不猜**：沿用 `config.mjs:590-599` `engineLangCode` 的同一姿态 —— 猜错的代价是"把日文当英文送"，而"送错方向"的产物往往**又长又像样**，最难发现。

### 4.4 注册表与"新增一个平台"的步骤

```js
// registry.mjs（示意）
const FACTORIES = {
  youdao: () => import('./platforms/youdao.mjs').then((m) => m.create()),
  // 未来：baidu: () => import('./platforms/baidu.mjs').then((m) => m.create()),
};
```

**新增平台 = 4 步，全都不动门面 / 路由 / 事件类型**：
1. 新建 `platforms/<id>.mjs`，`create()` 返回满足 `PlatformAdapter` 的对象；
2. `registry.mjs` 的 `FACTORIES` 加一行；
3. `contract.mjs` 的 `assertAdapter()` 会在**启动自检**时校验新适配器形状（缺方法当场炸，不留到运行期）；
4. `settings.mjs` 的白名单加该平台的配置键（§8.2）。

---

## 5. 有道智云适配器（首发平台）

### 5.1 共有的鉴权与签名（v3）

两个接口**同一套签名**：

```
sign = sha256_hex( appKey + input + salt + curtime + appSecret )
input = q                      当 len(q) <= 20
      = q前10字符 + len(q) + q后10字符   当 len(q) > 20
```

| 参数 | 值 / 规则 | 备注 |
|---|---|---|
| `appKey` | 应用 ID | 非密钥（可回显） |
| `appSecret` | 应用密钥 | 🔴 **密钥**，只进 `credentials.mjs`，永不回显 |
| `salt` | `crypto.randomUUID()` | 🔴 **每次请求（含重试）必须新生成**（§7.3 防重放） |
| `curtime` | `Math.floor(Date.now()/1000)` 的**字符串** | 秒级 |
| `signType` | `'v3'` | 必填 |
| `sign` | 上式，**小写 hex** | `crypto.createHash('sha256').update(s).digest('hex')` |

🔴 **`len(q)` 按什么算 —— 必须钉死**：官方 JS demo 用的是 `q.length`（UTF-16 码元数）。
- 中日文本（BMP 内）每个字 1 个码元 ⇒ 与"字符数"一致，**无分歧**；
- 只有**代理对**（emoji、罕见汉字扩展区）会让 `q.length` 比真实字符数大 1。
⇒ 决策：**照抄官方 demo 的 `q.length`**（与上游实现对齐优先于"更正确"），并在断言里写死该行为；若后续真联调发现不一致，再改并登记台账。

> ⚠️ 文档本身有**一处自相矛盾**：协议须知写 `Content-Type: application/json`，而 `curl` 示例用的是 `application/x-www-form-urlencoded`。
> ⇒ 决策：**以可运行的 `curl` 示例为准，用 form-urlencoded**；真联调时若 400/签名失败，第一件事就是试 `application/json`（§12 待裁定 P-G1）。

### 5.2 大模型翻译（流式）

| 项 | 值 |
|---|---|
| URL | `https://openapi.youdao.com/proxy/http/llm-trans` |
| 方法 / 体 | `POST` · form-urlencoded（见 §5.1 注） |
| 响应 | `text/event-stream`（**逐条 JSON**，非标准 SSE 的 `data:` 分帧） |
| 业务字段 | `i`（待译，**≤5000 字符**）· `prompt`（≤1200 字符 / 400 词）· `from` · `to` · `streamType` |
| `streamType` | `increment`（增量，**默认**）· `full`（全量）· `all`（两者都给） |
| `handleOption` | `0` = 子曰翻译 pro（14B）· `3` = lite（1.5B） |
| QPS | **10** |

**响应逐条形状**：

```json
{"code":"0","message":"success","data":{"transIncre":"Hello","langType":"en"},
 "requestId":"1762951633928-...","successful":true}
```

- `data.transIncre` —— `streamType=increment|all` 时有；
- `data.transFull`  —— `streamType=full|all` 时有；
- 🔴 `code` 是**字符串**（`"0"` = 成功），`successful` 才是布尔。

**本方案的取用方式**：`streamType=increment` ⇒ 每条取 `data.transIncre` 回调 `onDelta`，**门面侧累加**成 `text`。
🔴 **不要用 `full`** 当主路径：全量模式下每条都带前文，**带宽随长度二次增长**（O(n²)），长文本会被上游限速反噬。

**错误码**（本接口）：`0` 成功 · `1` 未知错误 · `101` 缺参 · `108` 应用 ID 无效 · `110` 无权限 · `112` 服务不存在 · `202` 签名失败 · `206` 时间戳无效 · `207` 重放 · `902000` 大模型翻译调用失败。

### 5.3 文本翻译（整体）

| 项 | 值 |
|---|---|
| URL | `https://openapi.youdao.com/api` |
| 方法 / 体 | `GET`/`POST` · form · 响 **JSON** |
| 业务字段 | `q`（待译，**≤5000 字符**）· `from` · `to` · `domain` · `vocabId` · `strict` |
| `domain` | `general`（默认）· `computers` · `medicine` · `finance` · `game`（**非通用仅中英互译**） |
| 限额 | 单次 **≤5000 字符**；**每小时 100 万次 / 120 万字符** |

**响应形状**：

```json
{"errorCode":"0","query":"good","translation":["好"],"l":"EN2zh-CHS", …}
```

- 🔴 `errorCode` 也是**字符串**，`"0"` 才是成功；**没有** `successful` 字段 —— 两个接口的判成功方式**不同**，适配器里必须各自处理（这正是"契约统一、细节下沉"的意义）。
- `translation` 是**数组**：单行入参给 1 个元素；**多行入参（`q` 内换行）给逐行译文**。

**取用方式**：`translation.join('\n')` 作为 `text`；`splitLines=true` 时另存 `lines`（§6.2）。

**错误码**（本接口，取与本方案相关者）：`0` · `101` 缺参 · `102` 不支持语言 · `103` 文本过长 · `108` 应用 ID 无效 · `110` 无有效应用 · `202` 签名失败 · `203` IP 不在白名单 · `205` 平台类型不一致 · `206` 时间戳无效 · `207` 重放 · `301/302` 查询失败 · `303` 服务端异常 · `304` 翻译失败 · `309` domain 参数错误 · `310` 未开通领域 · `401` 欠费 · `411/412` 频率受限。

### 5.4 语言码 / 领域 / 术语表

- 语言码映射见 §4.3；**有道两接口的语种表基本一致**（`zh-CHS` / `en` / `ja` / `auto`…），但大模型接口的语种表**更短**（没有 `ko` 之类以外的部分小语种）⇒ 映射表**按接口分**：`langCode(short, api)`。🔴 不为"少写一个参数"把两表合并 —— 合并的结果是把小语种方向送到不支持的接口上，得到 `102`，而 UI 上看着只是"翻译失败"。
- `domain` 与 `vocabId` 只在 `text` 能力下透传；`prompt` / `model` 只在 `llm` 能力下透传（传错接口上游会忽略或报 `101`，适配器**主动丢弃**不属于该能力的参数）。

---

## 6. 两类翻译的调用与输出处理流程

### 6.1 大模型翻译（流式）· 端到端

```
前端 ──POST /translate/stream──▶ manga-service
                                   │ ① 鉴权(继承) → ② 入参校验 → ③ 语言码归一
                                   │ ④ registry 取适配器 + 查 capabilities('llm')
                                   │ ⑤ limiter.acquire(platform)          ← QPS/并发闸门
                                   │ ⑥ 生成 salt/curtime/sign
                                   │ ⑦ http.postStream(llm-trans)
                                   │      ↳ TTFB 超时 / 空闲超时 / 总超时（§7.1）
                                   │ ⑧ sse-parse：逐行 JSON → 对象
                                   │      ↳ code!=="0" 或 successful=false ⇒ 抛归一错误
                                   │ ⑨ onDelta(transIncre) ──▶ res.write(translate.delta)
前端 ◀──SSE: translate.delta───────┘      ↳ 背压：write 返回 false ⇒ 等 'drain'（§6.4）
前端 ◀──SSE: translate.done─────────  完整结束：{ text, langType }
前端 ◀──SSE: translate.error────────  中途失败：{ code, message, afterChars }
```

**要点**：

1. **签名在流开始前一次性生成**（不是每块生成）。
2. **累计归门面**：适配器只负责"解析出 `transIncre` 并交给 `onDelta`"，累计与终态由门面统一，避免每个平台各写一份累加逻辑。
3. **首块之前失败 = 可重试**；**首块之后失败 = 不再重试**（见 §7.3）。
4. 错误事件带 `afterChars`（已吐多少字），UI 才能显示"已经译出 N 字后中断"。

### 6.2 普通文本翻译（整体）· 端到端

```
前端 ──POST /translate/text──▶ manga-service
                                │ ①②③ 同上
                                │ ④ capabilities('text')
                                │ ⑤ limiter.acquire
                                │ ⑥ 签名 → ⑦ http.postForm(/api)
                                │ ⑧ errorCode!=="0" ⇒ 抛归一错误
                                │ ⑨ text = translation.join('\n')
前端 ◀──200 { text, lines?, langType }──┘
```

**行对齐（`splitLines`）—— 一条明确的设计**：
- 入参多行时，把各行用 `\n` 连成一个 `q` 发送（**一次请求**，省额度）。
- 返回 `translation.length === 行数` ⇒ 逐行对齐，回 `lines[]`；
- 否则（长度不符）⇒ **放弃对齐**，只回整串 `text`，并在 `details.aligned=false` 里说明 —— 🔴 **不硬凑**：错位的"逐行译文"比"没逐行"危害大得多（会把 A 行的译文贴到 B 行）。

### 6.3 服务对外 API（新增 5 条，全部继承 `X-Box-Token` + Origin 校验）

| 方法 | 路径 | 体 / 出参 | 说明 |
|---|---|---|---|
| `POST` | `/api/v1/translate/text` | `{ platform?, text, from, to, splitLines?, domain?, vocabId? }` → `{ text, lines?, langType }` | 整体 |
| `POST` | `/api/v1/translate/stream` | 同入参 → **SSE**（`translate.delta/.done/.error`） | 流式 |
| `GET` | `/api/v1/translate/options` | → `{ platforms:[{id,label,capabilities,langs}], settings:{…不含密钥}, credentials:{youdao:{hasSecret:true}} }` | 给设置页/面板 |
| `POST` | `/api/v1/translate/settings` | 非密钥设置补丁 | 白名单校验 |
| `POST` | `/api/v1/translate/credentials` | `{ platform, appKey, appSecret }` —— **只写不读** | 存 0600 文件 |

> 🔴 **为什么"流式"用 `POST` + SSE 响应体，而不用 `EventSource`**：`EventSource` 只能发 `GET`，待译文本会顶到 URL 上（长度受限 + 进日志）。⇒ 前端用 `fetch()` + `response.body.getReader()` 读 SSE 字节流（或后续统一走壳内 IPC）。本方案**只规定服务端形状**，前端读法由实现期定。

### 6.4 背压 / 客户端断开 / 中途错误

- **背压**：`res.write()` 返回 `false` ⇒ 暂停从上游读取（`http.postStream` 的 Readable 先 `pause()`），等 `'drain'` 再续 —— 否则**下游慢、上游快**会把内存堆成一座山。`sse.mjs:18-26` 的 `writeSseEvent` 已返回布尔，直接用它判。
- **客户端断开**：`req.on('close')` ⇒ `AbortController.abort()` → 上游请求 `destroy()`。🔴 **必须真断上游**：有道是**按量计费**，客户端关了还继续拉 = 白花钱。
- **中途错误**：先写 `translate.error` 事件、**再** `res.end()`（顺序反了浏览器拿到的是"流干净结束"）。

---

## 7. 错误与超时处理

### 7.1 超时分层（**五个超时，不是一个**）

| 名称 | 管什么 | 建议默认 | 为什么必须单独一档 |
|---|---|---|---|
| `connectMs` | TCP/ TLS 建连 | `5_000` | 不可达要**快败**，不能等 30 s |
| `ttfbMs` | 建连后到**首个字节** | `15_000`（text）/ `20_000`（llm） | 大模型首字慢是常态，但它与"整段慢"是两件事 |
| `idleMs` | 两次数据之间 | `20_000` | 卡住 vs 慢慢吐，只有空闲超时能区分 |
| `totalMs` | 整次请求上限 | `30_000`（text）/ `120_000`（llm） | 兜底：防上游"每次都在 idle 之内、但总体永不结束" |
| `probeMs` | `/translate/status` 探测 | `2_000` | 探测**绝不能**用业务超时，否则每次探活都卡半分钟 |

> 参照 `engine-client.mjs:406-426` 的同款纪律：**单次超时**与**探测超时**必须分开（那里是 `engineTimeoutMs` vs `engineProbeMs`）。

### 7.2 错误归一（映射表是**纯函数**，可反证）

**统一码**（新增一组，进 `errors.mjs` 的 `CODES`，**不进插件契约**，与 S6/S7 的增量同族）：

| 统一码 | HTTP | 触发 |
|---|---|---|
| `TRANSLATE_NOT_CONFIGURED` | 503 | 无 appKey / appSecret ⇒ 用户要做的是"去填密钥" |
| `TRANSLATE_AUTH_FAILED` | 502 | `108/110/112/202/206/207/205/203` ⇒ 密钥或应用配置错 |
| `TRANSLATE_INVALID_INPUT` | 400 | `101/102/116/309/308` + 本地校验（空文本、超 5000 字符、未知方向） |
| `TRANSLATE_TEXT_TOO_LONG` | 400 | `103` |
| `TRANSLATE_RATE_LIMITED` | 429 | `411/412` |
| `TRANSLATE_QUOTA_EXCEEDED` | 402 | `401`（欠费） |
| `TRANSLATE_UNSUPPORTED_FEATURE` | 400 | `310` 未开通领域 / 能力协商失败 |
| `TRANSLATE_UPSTREAM_ERROR` | 502 | `1/301/302/303/304/902000` + 5xx |
| `TRANSLATE_UPSTREAM_UNREACHABLE` | 502 | `ENOTFOUND/ECONNREFUSED/ECONNRESET/EAI_AGAIN` |
| `TRANSLATE_TIMEOUT` | 504 | 任一层超时（`details.stage` 标明是哪一层） |

🔴 **不许合并的理由**（沿用 `errors.mjs:24-32` 的既有纪律）：`UNAVAILABLE`（进程不在）与 `ENGINE_NOT_READY`（未就绪）混用就是"把一句假话讲给用户听"。这里同理 —— `429` 该让用户"等一会儿再点"，`503` 该让用户"去填密钥"；合并成"翻译失败"，用户只能反复重试。

**映射实现**：`errors.mjs` 导出 `mapUpstreamError(platform, api, codeOrErr) -> {code, message, details}`；表按「平台 × 接口」分列（两个有道接口的码不完全重合）。

### 7.3 重试与防重放

| 场景 | 策略 |
|---|---|
| `text` 整体 · 可重试错（网络 / 超时 / `5xx` / `303`） | 最多 **2 次**，指数退避 `300ms → 900ms` |
| `text` 整体 · 不可重试（`101/103/202/401/411`…） | **不重试**（重试只会再错一遍，还多花额度） |
| `llm` 流式 · **首块之前**失败且可重试 | 最多 1 次 |
| `llm` 流式 · **首块之后**失败 | 🔴 **绝不自动重试** —— 已经吐给用户一半了，重来会**重复/覆盖**前面的内容 |
| 任一次重试 | 🔴 **必须重新生成 `salt` + `curtime` + `sign`** |

> **为什么"重算签名"是硬约束**：有道用 `salt + curtime` 防重放，同一签名第二次发出去**必然** `207`。把 `sign` 缓存在请求作用域里当"重试复用"，表现为"第一次偶发失败、重试也必失败"——**看起来像上游不稳，实际是我们自己撞了防重放**。

### 7.4 限流

- 每平台一个**令牌桶**（`limiter.mjs`，零依赖）：速率默认取该平台最小 QPS（有道 llm = **10**），桶容量 = 速率。
- **串行化并发**：同一平台的并发请求上限默认 `3`（可配）；超时等待随 `totalMs` 一起算。
- 上游回 `411/412` 时：**不**在适配器里自旋重试，直接冒泡 `TRANSLATE_RATE_LIMITED`，由门面按 §7.3 的退避决定是否再来一次。

---

## 8. 配置项的加载与管理

### 8.1 三层来源与优先级

```
env（验收/排障的强制覆盖）  >  盘上文件（用户设置）  >  出厂默认（代码）
```

- **完全照抄** `engine-settings.mjs:301-338` 的 `mergeWithEnv`（含 `sources` 逐键来源追踪）。
- 沿用同一理由（`engine-settings.mjs:272-277`）：env 在顶上是**为了夹具**；用户不设 env，所以不干扰产品路径。

| 来源 | 载体 | 示例键 |
|---|---|---|
| env | 进程环境 | `MIAO_TRANSLATE_PLATFORM` · `MIAO_YOUDAO_APP_KEY` · `MIAO_YOUDAO_APP_SECRET` · `MIAO_TRANSLATE_TIMEOUT_MS` |
| 文件（非密钥） | `state/translate-settings.json` | `platform` · `youdao.llmModel` · `youdao.textDomain` · `youdao.vocabId` · `timeoutMs` |
| 文件（密钥） | `state/translate-credentials.json`（`0600`） | `youdao.appKey` · `youdao.appSecret` |
| 默认 | 代码常量 | `platform = 'youdao'` · `llmModel = 'pro'` · `textDomain = 'general'` |

### 8.2 白名单与校验（**双向不对称，刻意**）

沿用 `engine-settings.mjs:117-164` 的判据：

| 来源 | 未知键 | 非法值 |
|---|---|---|
| **HTTP 补丁**（`strict: true`） | **抛错** | **抛错** |
| **盘上文件**（`strict: false`） | 丢弃 + 上报 | 丢弃 + 上报 |

- 理由与那份注释逐字相同：补丁是**契约输入**（客户端 bug 要当场炸），文件是**持久化数据**（别的版本写的多余键，不值得让整份设置失效）。
- 校验器示例：`platform ∈ 注册表 id 集`；`llmModel ∈ {'pro','lite'}`；`timeoutMs` 为 `1_000..600_000` 的整数；`textDomain ∈ {'general', ...}`。
- 🔴 **`platform` 必须校验存在性**，因为它是**路由到哪张适配器**的开关：写错一个字母，若静默回落到默认，用户会以为"选了百度、其实还在用有道"。

### 8.3 密钥隔离（本方案与既有设置层的**唯一结构差异**）

1. **独立文件**：`state/translate-credentials.json`，权限 `0600`（与 `state/token` 同款，见 `config.mjs:286-303`）。
2. **只写不读**：`POST /translate/credentials` 接受 `appSecret`；**任何** GET / 响应都只回 `{ appKey, hasSecret: true }`，**绝不回显 secret**。
3. **诊断不回显**：`details` 里出现密钥一律脱敏（打印 `sk-****` 形态）。
4. **来源追踪例外**：`sources` 只对**非密钥键**回显（密钥的"来源"本身也是信息位，能反推用户配没配）。

> 为什么不让密钥也进 `translate-settings.json`：那份文件会被只读脚手架在模块顶层读（照 `config.mjs:226-232` 的范式），
> 而密钥**没有理由进那个读路径**。分成两份，代价是一次 `readFileSync`，收益是"密钥的传播面物理上更小"。

### 8.4 落盘与热更新

- **原子写**：照抄 `writeEngineSettings`（临时文件 + `fsync` + `rename`，`engine-settings.mjs:228-267`）—— 崩在中间不会留下半截 JSON 把设置读坏。
- **生效时机**：非密钥设置**下次调用即生效**（门面每次现读）；**密钥同理**。
- 🔴 **适配器不缓存实例用到的密钥**：门面在每次调用时把 `{appKey, appSecret}` 现读并注入 —— 否则"改了密钥不生效"，而用户看到的是"我明明填了新的，还是签名失败"。

---

## 9. 可扩展性小结（"未来平滑拓展其他平台"的兑现方式）

| 扩展点 | 新增平台时要动的地方 | 不需要动的地方 |
|---|---|---|
| 请求/响应字段 | `platforms/<id>.mjs` 内部 | 门面、路由、事件类型 |
| 签名算法 | 同上（各平台自带 `sign()`） | `http.mjs` |
| 语言码 | 适配器的 `langCode()` | 短码定义（`config.mjs` 的 `TRANSLATE_DIRECTIONS`） |
| 错误码 | `errors.mjs` 加一列 + 适配器映射 | 统一码集合（只在**真有必要**时扩） |
| 配置键 | `settings.mjs` 白名单 | 三层回退机制 |
| 能力差异（只支持 text / 只支持 llm） | `capabilities` 集合 | 门面（按集合拒绝） |

**验收方式**：写一个**只有 `text` 能力**的假平台（`platforms/__fake__.mjs`，仅测试注册），断言「请求 `llm` 被 `TRANSLATE_CAPABILITY_UNSUPPORTED` 挡下且**未发出任何网络请求**」。这是对"抽象层真的存在"的反证。

---

## 10. 验收与断言计划（可反证）

新增脚本 `e2e/service/translate-check.mjs`（拟挂 npm 脚本 `check:translate`），**零网络、秒级**，范式照 `check:engine-client`（用假上游替真上游）。

**假上游做什么**（一个本地 `http.Server`，充当 `openapi.youdao.com`）：
- 用**同一份签名算法**回算 `sign`，不一致就回 `202` ⇒ 证明**签名算对了**；
- 按 `streamType` 吐出可控的 SSE 分块（含**故意半包**，证明 `sse-parse` 能吃半包）；
- 可按注入开关回 `103/411/207/401/902000`；
- 可注入"慢首字节 / 中途卡住 / 永不结束"三种病态，验证 §7.1 的四层超时；
- 记账每个请求的 `salt`（证明**重试换 salt**）；
- 记账请求次数（验证 §7.4 限流）。

**正向断言（草案）**：签名一致 / 增量累加等于全文 / 逐行对齐 / 两接口判成功方式不同（`successful` vs `errorCode`）/ 超时分层各命中一次 / 限流生效 / 配置三层优先级 / 密钥不回显 / capabilities 协商。

**反证（必须成对，草案）**：

| 破坏什么 | 哪条必须变红 |
|---|---|
| 签名去掉 `truncate`（长文本直连） | 长文本用例的"签名一致" |
| 重试复用旧 `salt` | "重试换 salt" + 假上游回 `207` 的用例 |
| 把 `idleMs` 并进 `totalMs`（少一档超时） | "卡住 vs 慢吐"的区分用例 |
| 响应里回显 `appSecret` | "密钥不回显" |
| 流式首块后仍重试 | "首块后不重试"（假上游应只收到 1 次请求） |
| 两个接口判成功逻辑互换 | `errorCode` 用例（`"0"` 被判失败） |

**真联调**（单列，需密钥 + 出网）：`e2e/service/translate-real-check.mjs`，**不进常规门**，与 `check:e3:real` 同族。

---

## 11. 分期实施（建议）

| 阶段 | 内容 | 交付物 | 门 |
|---|---|---|---|
| **T0** | 契约与骨架：`contract.mjs` / `registry.mjs` / `errors.mjs`（纯函数） | 契约 + 码表 + 假平台 | 类型/shape 自检 |
| **T1** | 出网与解析：`http.mjs` / `sse-parse.mjs` / `limiter.mjs` | 零平台依赖的原语 | 半包 / 超时 / 限流单测 |
| **T2** | 有道适配器：`platforms/youdao.mjs`（签名 + 两能力） | text + llm | 对假上游全绿 |
| **T3** | 门面 + 路由 + 事件：`index.mjs` + `server.mjs` 5 条路由 | API 可用 | 端到端（假上游） |
| **T4** | 配置与密钥：`settings.mjs` / `credentials.mjs` | 三层回退 + 只写不读 | 密钥不回显反证 |
| **T5** | 前端面板：② 「翻译来源」小节（来源分段 + 平台 / 密钥 + 保存） | UI | `tsc` + `check:units` |
| **T6** | 真联调（可选，需密钥） | 真翻译记录 | 单独门 |

---

## 12. 待裁定问题（实现期必须给出结论并落台账）

| 编号 | 问题 | 备选 | 影响 |
|---|---|---|---|
| **P-G1** | `llm-trans` 的 `Content-Type` 到底是 form 还是 json（官方文档自相矛盾，§5.1） | ① 先 form（跟 curl 示例）② 先 json（跟协议表） | 只影响真联调；假上游要先定一版 |
| **P-G2** | 密钥存**单独文件**还是并入 settings（§8.3） | ① 单独 `translate-credentials.json`（本方案倾向）② 并入但标记 `secret` | 影响"只读脚手架会不会读到密钥" |
| **P-G3** | `splitLines` 是否作为**默认**行为 | ① 默认关（整串）② 默认开（多行时对齐） | 影响前端与后续漫画链路复用 |
| **P-G4** | `langCode` 按接口分表（`langCode(short, api)`）还是合并单表（§5.4） | ① 分表（本方案倾向）② 单表 | 影响未来小语种扩展的正确性 |
| **P-G5** | 是否需要**余额/额度**主动查询（有道有查询接口） | ① 先不做，靠 `401/411` 被动感知 ② 做一次手动探测 | 影响 `/translate/status` 的范围 |
| **P-G6** | 是否登记 spec-notes（`D-xx`）—— 本方案已定稿的口径 | ① 实现期随 T0 一起登记 ② 现在就登记 | 编号可能与他人并发冲突（本项目有并发写入史） |

---

## 13. 已定的交互与产品决策（ver2.2 追加 · 不再开放）

以下六条是**与设计稿一同定稿**的口径，实现期照做，不再逐条裁定（改动需先改本节）。

| 编号 | 决策 | 关键点与影响 |
|---|---|---|
| **P-D1** | **来源是「服务的设置」，不是「任务的属性」** | 用户只在设置里选一次（本地引擎 / 在线 API），manga-service 记住它；**投放 / 队列 / 重试 / 返工 / 浏览器插件都不加来源控件**。⇒ `TaskRow` **不加** `provider` 字段（避开与既有 `source` 的命名冲突）；不存在"重试继承来源"问题（永远用当前设置） |
| **P-D2** | **在线翻译并入 ② 「翻译服务」，不做独立左栏项** | 作为 ② 的**第一个小节「翻译来源」**（来源分段 + 平台 / appKey / appSecret）。左栏仍是 5 项。⚠️ **② 由「恰 3 个小节」变 4 个** ⇒ `check:settings` 的 C11 判据（数 `.set-subtitle`）必须同步 3 → 4，`SECTION_ITEM_TOTAL` / 项数一并复核 |
| **P-D3** | **漫画翻译的准入判据按来源分档** | 现状 `blocked = state !== 'running'` ⇒ 整片让位给 X-C3（四段时间线全在讲本地引擎 ②③）。改为：`来源=本地` 维持现状；`来源=在线` **只看 ① manga-service 是否在跑**（`state ∈ {stopped,error}` / `port` 空才拦），且用**精简页**（一句「本地服务未启动」+ 启动按钮，**不搬时间线**）；在线时 `degraded`（②③ 掉）**不拦** |
| **P-D4** | **来源=在线 ⇒ 引擎不随开机拉起** | 现 `llmAutostart` 默认 `true`、开机即烤 ③；在线用户完全不需要那份显存/内存 ⇒ 并入 ver2.2「按需化」一并做 |
| **P-D5** | **「大模型流式 vs 文本整体」不进设置界面** | 两类都在适配器里实现（架构支持）；在线默认走**普通文本（整体）**（适配批量漫画），**流式留能力、界面先不暴露**；等出现需要逐字反馈的场景（如实时预览）再开 |
| **P-D6** | **界面只留「选平台 + appKey + appSecret + 保存」** | 去掉语言对（方向已逐任务下发，平台语言码由适配层映射）、测试连接、输出预览、超时、分句、摘要 —— 均已从设计稿移除 |

> 落地时的**可见指示**：漫画翻译模块工具条加一枚**来源 chip**（「在线 · 有道智云」/「本地引擎」），
> 既是准入判据的可视化，也让用户明白"这次为什么没等引擎"。

---

## 附：本方案直接引用的既有代码（便于实现期定位）

| 用途 | 位置 |
|---|---|
| SSE 写出 | `service/src/manga/sse.mjs:4-36` |
| 错误信封与码表 | `service/src/errors.mjs:1-83` |
| 设置白名单 / 原子写 / env 合并 | `service/src/settings/engine-settings.mjs:40-42, 190-267, 301-338` |
| 三层合并与来源 | `service/src/config.mjs:226-251` |
| 路由与鉴权 | `service/src/server.mjs:1520-1630, 1641-1660` |
| SSE 端点范式 | `service/src/server.mjs:1107-1124` |
| "单一耦合点"范式 | `service/src/engine-client.mjs:1-9` |
| 短码方向定义 | `service/src/config.mjs:572-575, 590-599` |
| 超时分层范式 | `service/src/engine-client.mjs:406-426` |
