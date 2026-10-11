import { apiGet, apiPost } from '@/ipc';

/**
 * ② 翻译服务 ·「翻译来源」小节的**服务端接口收口**（ver2.2 在线翻译服务）。
 *
 * ## 为什么单独成文件
 * 这三个端点（`/translate/options|settings|credentials`）都是 **Box 专用**
 * （不在插件契约里），且密钥字段的**只写不读**是不变量：`appSecret` 只出站、
 * 任何入站响应里都没有它。把形状定义与调用散在组件里，会出现"界面读的字段名和
 * 服务端给的对不上"—— 而这类错**在运行时只表现为 `undefined`**（渲染成一个空值
 * 或"读取中…"），不报错、不崩、断言也抓不到。所以形状在这里只定义一次，组件只消费。
 *
 * ## 为什么字段全部标 `| null`
 * 服务端刻意用 `null` 表达"此刻没有"（没配过密钥 ⇒ `appKey=null`；没设过词表表 ⇒
 * `vocabId=null`）。类型上允许 null 是**逼调用方显式处理这种情况**，而不是让
 * `?? '—'` 之类的兜底把它悄悄变成一个看起来正常的值。
 *
 * ## 为什么密钥单独一个端点（`credentials`），不与 `settings` 合并
 * 盘上它们是两份文件：非密钥进 `translate-settings.json`（会被只读脚手架在模块
 * 顶层读），密钥进 `translate-credentials.json`（`0600`）。分成两个写入口是
 * **物理上缩小密钥的传播面** —— 也让界面能对两类失败分别归因（设置被拒 vs 密钥
 * 被拒，用户要做的事完全不同：改选项 vs 重新填密钥）。
 */

// ------------------------------------------------------------------ 取值域

/**
 * 翻译来源（P-D1）：**服务的设置，不是任务的属性** —— 用户只在设置里选一次，
 * box-service 记住它；投放 / 队列 / 重试 / 返工 / 浏览器插件都不加来源控件。
 */
export type TranslateSource = 'local' | 'online';

// ------------------------------------------------------------------ /translate/options

export interface TranslatePlatformOption {
  id: string;
  label: string;
  /** 该平台支持的能力集合（`text` 整体 / `llm` 流式）—— 界面可据它解释边界 */
  capabilities: string[];
  /** 该平台支持的语言短码（界面当前不展示，P-D6；留字段是为契约完整） */
  langs: string[];
}

/**
 * 密钥的**回显形状**：`appKey` 可读（设置页要显示"已配置哪个 key"），
 * `appSecret` **永不回显** —— 只回一个 `hasSecret` 布尔。
 * 🔴 任何情况下本类型都不出现 `appSecret` 字段：那是它在类型上的保证。
 */
export interface TranslateCredentialView {
  appKey: string | null;
  hasSecret: boolean;
}

/**
 * `settings` 的非密钥部分。
 *
 * `youdao.*` 里三个字段（`llmModel` / `textDomain` / `vocabId`）按 P-D6
 * **不进界面**，类型保留只为契约完整 —— 后端下发什么、这里就接什么，
 * 界面一个都不渲染（假控件比缺控件更伤）。
 */
export interface TranslateSettingsView {
  platform: string;
  source: TranslateSource;
  youdao: {
    llmModel: string;
    textDomain: string;
    /** 用户没配过词表表 ⇒ `null`（不是空串：空串会被读成"配了空的"） */
    vocabId: string | null;
  };
  timeoutMs: number;
}

export interface TranslateOptions {
  /** 平台清单由服务端动态下发（未来加平台不改前端） */
  platforms: TranslatePlatformOption[];
  settings: TranslateSettingsView;
  /**
   * 按平台 id 索引的密钥回显。契约当前只有 `youdao` 一把，但**不用具名字段**：
   * 平台清单是服务端下发的，写死 `youdao` 会让第二个平台悄悄读不到已配密钥。
   */
  credentials: Record<string, TranslateCredentialView>;
}

// ------------------------------------------------------------------ /translate/settings

/** 非密钥设置补丁 —— **只写改动过的字段**（不发明"整份提交"的语义） */
export interface TranslateSettingsPatch {
  platform?: string;
  source?: TranslateSource;
}

export interface TranslateSettingsResult {
  ok: true;
  /** 这次真改了哪几个键（"保存成功"不该是一个不说明改了什么的消息） */
  changed: string[];
}

// ------------------------------------------------------------------ /translate/credentials

/** 密钥写入体（P-D6）：三件套一起交，`appSecret` 只在这条路上出站 */
export interface TranslateCredentialsPatch {
  platform: string;
  appKey: string;
  appSecret: string;
}

export interface TranslateSaveResult {
  ok: true;
  saved: { platform: string; appKey: string };
}

// ------------------------------------------------------------------ 调用

export const translateOptions = () => apiGet<TranslateOptions>('/translate/options');

export const saveTranslateSettings = (patch: TranslateSettingsPatch) =>
  apiPost<TranslateSettingsResult>('/translate/settings', patch);

export const saveTranslateCredentials = (body: TranslateCredentialsPatch) =>
  apiPost<TranslateSaveResult>('/translate/credentials', body);
