// 平台注册表 —— id → 适配器工厂；**不含任何平台逻辑**
// =============================================================================
// 依据：在线翻译服务设计方案 §4.4。
// 新增一个平台 = 在 `FACTORIES` 加一行 + 新建 `platforms/<id>.mjs`，门面 / 路由 /
// 事件类型都不用动。工厂用**动态 import**：平台文件只在被用到时才加载（也避免
// 注册表 → 平台 → 注册表 的静态成环）。

import { assertAdapter } from './contract.mjs';
import { TranslateError } from './errors.mjs';
import { setPlatformIds } from './settings.mjs';

/**
 * 平台 id → 适配器工厂。
 * `__fake__` 只给验收脚本用，**不进产品注册表**（它是反证件，见方案 §10）。
 */
export const FACTORIES = {
  youdao: () => import('./platforms/youdao.mjs').then((m) => m.create()),
};

/** 实例缓存：一个平台在进程内只构建一次（适配器无状态，密钥走 ctx 现传） */
const cache = new Map();

// 把真实 id 集注入 settings 的白名单校验（`platform` 是路由开关，必须与注册表同源）——
// 依赖方向是 registry → settings，不成环。
setPlatformIds(Object.keys(FACTORIES));

/**
 * 取一个平台的适配器（未知 id 当场抛，details 带 available 供界面提示）。
 * @param {string} id
 * @returns {Promise<import('./contract.mjs').PlatformAdapter>}
 */
export async function getAdapter(id) {
  const factory = FACTORIES[id];
  if (!factory) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `未知翻译平台 ${JSON.stringify(id)}`, { platform: id, available: Object.keys(FACTORIES) });
  }
  if (cache.has(id)) return cache.get(id);
  const adapter = await factory();
  assertAdapter(adapter); // 形状不对当场炸，不留到运行期（方案 §4.4 第 3 步）
  cache.set(id, adapter);
  return adapter;
}

/**
 * 全部平台的能力清单（给 `GET /translate/options` 用）。
 * @returns {Promise<Array<{id:string, label:string, capabilities:string[], langs:string[]}>>}
 */
export async function listPlatforms() {
  const out = [];
  for (const id of Object.keys(FACTORIES)) {
    const a = await getAdapter(id);
    out.push({
      id: a.id,
      label: a.label,
      capabilities: [...a.capabilities],
      langs: Array.isArray(a.langs) ? [...a.langs] : [],
    });
  }
  return out;
}

/**
 * 某平台的能力集合（门面能力协商的查询口，§4.2）。
 * 返回**副本**：调用方改不到适配器内部的 Set。
 * @returns {Promise<Set<'llm'|'text'>>}
 */
export async function capabilities(id) {
  const a = await getAdapter(id);
  return new Set(a.capabilities);
}
