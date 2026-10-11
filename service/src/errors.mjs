// 错误信封（契约 §2.2）：所有错误统一 { error: { code, message, details } }
export const CODES = {
  BATCH_LIMIT_EXCEEDED: 400,
  COMIC_NAME_REQUIRED: 400,
  INVALID_COMIC_NAME: 400,
  INVALID_IMAGE: 400,
  IDEMPOTENT_REPLAY: 200,
  TASK_NOT_FOUND: 404,
  TASK_NOT_APPENDABLE: 409,
  TASK_NOT_CANCELABLE: 409,
  // 与上一条同一个家族：**任务当前这个状态不允许该动作**（而不是"任务不存在"=404）。
  // 两个分支都会走到它：① 任务还在跑（running/queued）却被点重试；② 任务没有任何失败页
  //（例如 done）。都用 409 表达"冲突：现在不是做这件事的时候"，别混成 404 或 500。
  TASK_NOT_RETRYABLE: 409,
  // 又是同一家族：**任务当前状态不允许删除**。只有「翻译中 / 排队中」会被它挡下 ——
  // 那两条没有可删的「记录」可言（任务还在跑，进程随时会回写），所以拒绝而不是删掉内存里的副本。
  // 用 409 表达"冲突：现在不是做这件事的时候"，与 NOT_CANCELABLE / NOT_RETRYABLE 一致。
  TASK_NOT_DELETABLE: 409,
  SEQUENCE_OVERFLOW: 409,
  DISK_FULL: 507,
  PERMISSION_DENIED: 403,
  UNAVAILABLE: 503,
  INTERNAL: 500,
  // ---------------------------------------------------------------- ver2.0 新增 2 条（契约 §2.3）
  //
  // 🔴 这两个码与 `UNAVAILABLE` **不可混用**（§2.3 的「边界」原文）：
  //    · `UNAVAILABLE`         = **进程不在**      ⇒ 用户要做的是"启动 Box"
  //    · `ENGINE_NOT_READY`    = **进程在但未就绪** ⇒ 用户要做的是"等一会儿"
  //    · `MODEL_DOWNLOAD_FAILED` = 模型缺失/校验失败 ⇒ 用户要做的是"重新下载模型"
  //    混用不是文案瑕疵，而是**把一句假话讲给用户听**：说"服务未就绪"会把人的动作
  //    引向重启，而真正该做的是等待或重下。
  ENGINE_NOT_READY: 503,
  MODEL_DOWNLOAD_FAILED: 503,
  // ---------------------------------------------------------------- S6 新增（**不进插件契约**）
  // 设置页写接口（`POST /engine/settings`）的输入错误。它不是契约 §2.2 的成员 ——
  // 那条契约描述的是**插件**要认的错误集，而 `/engine/*` 一族端点全是 Box 专用（§5.2 同理）。
  // 为什么仍要有一个具名码而不是复用 `INVALID_IMAGE`：错误码是给**界面**分支用的，
  // 用"图片格式错"来表达"档位不可用"，界面就只能靠文案去猜该怎么提示。
  INVALID_SETTING: 400,
  // 同一个模型下载任务**已在跑**时再次发起（`POST /engine/models/download`）。
  //
  // 🔴 用 409 而不是 200「已在下载中」：后者会让界面以为"这次点击也生效了"，
  //    于是用户看不出自己其实什么都没触发。两个并发下载会同时往同一批
  //    `.part` 文件里写（`model-store.mjs` 的续传文件），互相截断 —— 这类损坏
  //    在成功后表现为"文件在、哈希不对"，归因极难。
  DOWNLOAD_IN_PROGRESS: 409,
  // ---------------------------------------------------------------- ver2.1 新增（**不进插件契约**）
  //
  // 建单 / 续做里 `payload.lang` 不是支持的翻译方向（如 `zh>ja`、`en>ja`、拼错的码）。
  //
  // 🔴 为什么**必须**是显式 400、不能"认不出来就当默认方向"：方向直接决定**翻译器选型**
  //    （`en` 走离线 `nllb`、`ja` 走 `sakura`）。静默回落成日译中，会让英文漫画
  //    以日语送进引擎 —— A 组实测 sakura + 英文 = 8/8 行**原文照抄**，再被下游
  //    「identical to original」滤掉，用户看到的是「任务跑完了、一个字都没翻」，
  //    而错误现场早已被丢掉，归因只能靠猜。
  INVALID_TRANSLATE_LANG: 400,
  // ---------------------------------------------------------------- ver2.2 新增（漫画库「本 → 话 → 页」，**不进插件契约**）
  //
  // 🔴 这一族全部是 **Box 专用**端点（`/library/create` · `/meta` · `/cover` · `/merge`）
  //    的输入/冲突错误。它们与契约 §2.2 的插件错误集**互不影响** —— 插件端不认识这些路径。
  //
  // 为什么每一条都要独立码、不肯复用既有码：错误码是给**界面分支**用的。若"同名已存在"
  // 复用 `TASK_NOT_APPENDABLE`、"封面太大"复用 `INVALID_IMAGE`，界面就只能靠文案去猜该提示什么，
  // 而文案是会改的。可判定的码让"新建同名 → 提示换名"与"封面超限 → 提示压缩图片"能各自分流。
  /** `POST /library/create` 撞上已存在的同名目录/同名大类 */
  BOOK_NAME_TAKEN: 409,
  /** `POST /library/{book}/meta` 的字段不合法（title 空/超长、author 超长、没给任何要更新的字段） */
  INVALID_BOOK_META: 400,
  /**
   * 封面字节超过 `COVER_MAX_BYTES`（10 MiB）。
   *
   * 🔴 必须与 `INVALID_IMAGE`（嗅探失败）分开：两者在界面上要引导用户做**相反的事**
   *    （"换一张小点的图" vs "这个文件根本不是图片"）。合并成一个码，用户会拿着
   *    "图片不能超过 10 MB"的提示去检查一张 200 KB 的 png，归因方向被带偏。
   */
  COVER_TOO_LARGE: 400,
  /** `POST /library/{name}/merge`：源目录已是某大类（有 `manifest.json`），不能再归并一次 */
  ALREADY_MERGED: 409,
  /** 归并时源目录还有**未终态**任务（翻译中/排队中）—— 搬走目录会让在跑的任务写向不存在的路径 */
  MERGE_SOURCE_BUSY: 409,
  /** 归并目标大类里该话号（目录名或 `episodes[].no`）已被占用 */
  CHAPTER_NO_TAKEN: 409,
  /**
   * 归并的物理移动撞上 `EXDEV`（跨卷 / 网络盘）。
   *
   * 🔴 不降级成"复制再删"是有意的：那是**不可逆**操作（复制到一半失败会留下半个目录，
   *    而源目录已被删）。宁可报 409 让用户知道"这本不能自动归并"，也不要赌一次跨卷拷贝。
   */
  MERGE_CROSS_DEVICE: 409,
  /**
   * 归并的物理移动撞上 Windows「句柄占用族」（EPERM/EBUSY/EACCES）且退避重试（≈800ms）耗尽。
   * 归因成 409 而不是 500：用户能行动（关掉预览/资源管理器窗口，稍后再试），D-125。
   */
  MERGE_SOURCE_LOCKED: 409,
  /**
   * `POST /library/{book}/chapters/{no}/renumber`：该话还有未终态任务（翻译中/排队中）——
   * 改话号 = 改名目录，会让在跑的任务写向不存在的旧路径。与 `MERGE_SOURCE_BUSY` 同理但
   * 不肯复用：界面提示的主语不同（"这本漫画" vs "这一话"）。
   */
  CHAPTER_SOURCE_BUSY: 409,
  /** 改话号的目录改名撞上 Windows「句柄占用族」且退避重试耗尽（D-125 同款归因） */
  CHAPTER_SOURCE_LOCKED: 409,
  // ---------------------------------------------------------------- ver2.2 新增（在线翻译一族，**不进插件契约**）
  //
  // 🔴 与 S6 的 `INVALID_SETTING` 同族：这一组全是 **Box 专用**端点（`/api/v1/translate/*`）
  //    的错误码。契约 §2.2 描述的是**插件**要认的错误集，插件端不认识这些路径 —— 两者互不影响。
  //
  // 🔴 为什么 11 条一条都不能合并（沿用本文件 :24-32 与方案 §7.2 的纪律）：错误码是给
  //    **界面分支**用的，而这一族每条码指向的**用户动作**互不相同 ——
  //      · `429` RATE_LIMITED      ⇒ 「等一会儿再点」（重试只会更堵）
  //      · `503` NOT_CONFIGURED    ⇒ 「去填密钥」（设置 → 翻译来源）
  //      · `402` QUOTA_EXCEEDED    ⇒ 「账户欠费，去充值」
  //      · `504` TIMEOUT           ⇒ 「上游慢了，可重试」
  //      · `400` CAPABILITY        ⇒ 「这个平台没这个能力，换平台/换入口」
  //    合并成一个"翻译失败"，用户只能对着同一句话反复重试 —— 那是把一句假话讲给用户听。
  //
  // 取值与 `manga/translate/errors.mjs` 的 `TRANSLATE_CODES` **逐字一致**（门面把
  // TranslateError 转成 ApiError 时以两边同一状态码出信封，不许有一丝偏差）。
  /** 无 appKey / appSecret ⇒ 用户要做的是"去填密钥"（503，不是 500） */
  TRANSLATE_NOT_CONFIGURED: 503,
  /** 密钥或应用配置错（上游 108/110/112/202/203/205/206/207）⇒ 检查 appKey/appSecret */
  TRANSLATE_AUTH_FAILED: 502,
  /** 本地校验失败（空文本 / 未知方向 / 缺参 / prompt 超限）⇒ 改请求 */
  TRANSLATE_INVALID_INPUT: 400,
  /** 文本超过上游单次长度上限（5000 字符）⇒ 切短再试 */
  TRANSLATE_TEXT_TOO_LONG: 400,
  /** 频率/字符数受限（上游 411/412 或本服务闸门排队超时）⇒ 等一会儿再点 */
  TRANSLATE_RATE_LIMITED: 429,
  /** 账户欠费（上游 401）⇒ 去充值 */
  TRANSLATE_QUOTA_EXCEEDED: 402,
  /** 未开通领域（上游 310）⇒ 换领域或到控制台开通 */
  TRANSLATE_UNSUPPORTED_FEATURE: 400,
  /** 上游业务错误（1/301/302/303/304/902000）或 5xx ⇒ 稍后重试 / 看上游状态 */
  TRANSLATE_UPSTREAM_ERROR: 502,
  /** 根本到不了上游（ENOTFOUND/ECONNREFUSED/ECONNRESET/EAI_AGAIN）⇒ 检查网络 */
  TRANSLATE_UPSTREAM_UNREACHABLE: 502,
  /** 任一层超时（connect/ttfb/idle/total，details.stage 标明哪层）⇒ 可重试 */
  TRANSLATE_TIMEOUT: 504,
  /** 请求的能力平台不支持（如 mode:'llm' 而平台只有 'text'）⇒ 换平台/换入口 */
  TRANSLATE_CAPABILITY_UNSUPPORTED: 400,
};

export class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = CODES[code] ?? 500;
    this.details = details || {};
  }
}

/** 令牌错误与 Origin 拒绝共用同一个错误码，不泄露是哪一项失败（契约 §2.1） */
export function permissionDenied() {
  return new ApiError('PERMISSION_DENIED', '鉴权失败或来源不被允许', {});
}

/**
 * 安全事件日志（越界拒绝 / 令牌失败 / Origin 拒绝）。
 *
 * 为什么和 `permissionDenied` 同住 `errors.mjs`：两者是**同一个安全响应**的两半 ——
 * 「记一笔」+「回 403」。原先定义在 `server.mjs`，但 `manga/library.mjs` 的寻址函数
 * （`resolveComicDir` 等）也要在拒绝时记这一笔 ⇒ 下沉到底座才能被域层复用（D-147）。
 */
export function securityLog(msg) {
  console.warn(`[box-service][security] ${msg}`);
}

export function errorEnvelope(err) {
  const code = err instanceof ApiError ? err.code : 'INTERNAL';
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof ApiError ? err.message : '服务内部错误';
  const details = err instanceof ApiError ? err.details : { reason: String(err && err.message) };
  return {
    status,
    body: { error: { code, message, details: details || {} } },
  };
}
