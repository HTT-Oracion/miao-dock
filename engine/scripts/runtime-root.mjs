/**
 * runtime-root.mjs —— 引擎工具链的**运行时落点**单一事实源（Node 侧）
 * =============================================================================
 * 为什么需要它：引擎运行时不在仓库里，而在平台应用数据目录下的
 * `MiaoDock/manga/runtimes`（与安装位置无关；打包后 `repo_root()` 必然算错，见 A1/D-174）。
 * 产品侧由 Rust `paths::manga_runtime_root()` 落地；而**装配脚本**（setup-engine /
 * install-engine-deps / fetch-models）原先各自写死 `path.join(REPO, 'runtimes', …)` ——
 * 那会让「装到 A、读到 B」，且两边都不报错（正是 B1 要防的那类静默失配）。
 *
 * 🔴 与 Rust 侧是**两份实现、同一套规则**（不同语言，无法共享代码）。漂移由
 *    `check:paths` 的 `PATH.tooling` 断言把守 —— 它拿本模块的 `runtimeRoot()` 与快照里的
 *    `mangaRuntimeRoot` 逐字节比对。
 *
 * 环境变量：
 *   MIAO_MANGA_RUNTIME_ROOT  覆盖运行时根本身
 *   MIAO_MODEL_ROOT          模型根目录（历史名，语义 = `runtimesDir()`，仍受支持）
 */
import os from 'node:os';
import path from 'node:path';

/**
 * 平台的**应用数据目录**（`~/Library/Application Support` / `%LOCALAPPDATA%` / `~/.local/share`）。
 * 与 `config.mjs::defaultAppDataDir` / Rust `paths::app_data_dir` 同一套分叉。
 */
export function defaultAppDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  return path.join(os.homedir(), '.local', 'share');
}

/** 引擎运行时根（`<appData>/MiaoDock/manga/runtimes`）—— 与安装位置无关，始终可写。 */
export function defaultRuntimeRoot() {
  return path.join(defaultAppDataDir(), 'MiaoDock', 'manga', 'runtimes');
}

/** 生效的运行时根（`MIAO_MANGA_RUNTIME_ROOT` 可覆盖）。 */
export function runtimeRoot() {
  const v = process.env.MIAO_MANGA_RUNTIME_ROOT;
  return v && v.trim() ? path.resolve(v) : defaultRuntimeRoot();
}

/** 引擎运行时根（`<runtimeRoot>/manga-translator`）—— 也就是历史上的「模型根目录」。 */
export function runtimesDir() {
  return path.join(runtimeRoot(), 'manga-translator');
}
