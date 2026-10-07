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
  //
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
