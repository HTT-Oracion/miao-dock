/**
 * M5 端到端与截图取证共用的临时路径。
 *
 * 为什么抽出来：`e2e/e2e.mjs` 跑完**故意不清理** —— 它落盘的那批漫画正是
 * `e2e/capture.mjs` 要截的取证素材（「截的是真数据、不是摆拍」）。于是清理只能发生在
 * **下一次运行的开头**，那时目录里攒着上一次的全套产物（三五本漫画，几百个文件）。
 *
 * 默认位置仍是项目内的 `.tmp/e2e/`（可在 Finder 里直接翻，便于人工核对）；
 * 但允许用 `MIAO_E2E_TMP` 指到别处 —— CI 或不希望在工作区里反复做大目录清理的场景，
 * 指到系统临时目录即可。**两个脚本共用这一个解析**，否则 e2e 写在一处、capture 读到另一处。
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const TMP_ENV = 'MIAO_E2E_TMP';

/** 端到端那一轮的临时根目录 */
export function e2eTmp() {
  const raw = (process.env[TMP_ENV] || '').trim();
  return raw ? path.resolve(raw) : path.join(path.resolve(import.meta.dirname, '..'), '.tmp', 'e2e');
}

/** 数据根（`MIAO_ROOT`）—— 状态 / 运行时 / 将来其它域的默认父级 */
export const e2eData = () => path.join(e2eTmp(), 'data');

/** 漫画落盘根目录（`MIAO_MANGA_ROOT_DIR`）——`capture.mjs` 要把它喂给应用才能扫出真数据 */
export const e2eRoot = () => path.join(e2eTmp(), 'root');

/** 漫画服务状态目录（`MIAO_MANGA_STATE_DIR`） */
export const e2eState = () => path.join(e2eTmp(), 'state');

/** 漫画引擎运行时根（`MIAO_MANGA_RUNTIME_ROOT`） */
export const e2eRuntime = () => path.join(e2eTmp(), 'runtime');

/** 给日志用的展示路径：默认位置显示相对项目根的路径，覆盖时显示绝对路径 */
export function describeE2eTmp() {
  const dir = e2eTmp();
  const project = path.resolve(import.meta.dirname, '..');
  return dir.startsWith(project + path.sep) ? path.relative(project, dir) : dir;
}

/** 系统临时目录下的一个子目录（`MIAO_E2E_TMP` 的便捷取值） */
export const underOsTmp = (name) => path.join(os.tmpdir(), name);
