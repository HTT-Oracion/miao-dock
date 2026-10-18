#!/usr/bin/env node
/**
 * 原子解包（D3 · 修 D-95 的待修项）
 * =============================================================================
 * 老写法是「**先删后解**」：
 *
 *     fs.rmSync(destDir, { recursive: true, force: true });
 *     fs.mkdirSync(destDir, { recursive: true });
 *     tar -xf archive -C destDir
 *
 * 它有一个**不可逆**的坏处：解包中途失败（断网、磁盘满、tar 报错、用户 Ctrl-C）
 * 之后，`destDir` **已经被删掉了**，里面只剩下半份内容 —— 而这个状态与"装好了"
 * 在目录层面看不出区别，下一次跑脚本时 `sourceReady()` 之类的判据可能还会说"已就位"。
 * `engine/VERSIONS.lock` §6.4 把这一条记成了待修项（D-95）。
 *
 * ## 这套写法为什么是原子的
 *
 *   ① 解到 `<destDir>.part`（同一父目录 ⇒ 同一个卷 ⇒ `rename` 才是原子的）；
 *   ② 解包失败 / 校验失败 ⇒ **只删 `.part`**，`destDir` **一个字节都不动**；
 *   ③ 全部成功后才换：旧内容 `rename` 成 `<destDir>.old-<时间戳>`，`.part` `rename` 成
 *      `destDir`；第二步若失败，把旧的**改回来**（回滚），再删 `.part`；
 *   ④ 换成功后才删 `<destDir>.old-*`。
 *
 * ⇒ 任何一步中断，`destDir` 要么是**完整的旧内容**、要么是**完整的新内容**，
 *   不会出现"半份 + 已经删掉旧的"。
 *
 * 🔴 为什么 `.part` 而是不用临时目录：与 `model_store.rs` 的 `PART_SUFFIX` 同一条约定
 *    ——**存在 `.part` 就等于"这里有一次没跑完的解包"**，人和脚本都能一眼看出来。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 半成品后缀（与 `mangasvc::engine::model_store` 的 `PART_SUFFIX` 同名同义）。 */
export const PART_SUFFIX = '.part';

/** 被换下来的旧内容的后缀（换成功后立刻删掉；只有换的那一瞬间存在）。 */
export const OLD_SUFFIX = '.old-';

/** 半成品/残渣的清理。**只删传进来的那个目录**，调用方负责别把 `destDir` 传进来。 */
function cleanupPart(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 把 `archive` 解到 `destDir`（原子）。
 *
 * @param {string} archive            归档路径（`.tar.gz` / `.zip`，交给 `tar -xf`）
 * @param {string} destDir            目标目录（可以已存在；内容会被整体替换）
 * @param {{strip?: number, verify?: (dir: string) => void}} [opts]
 *        `strip`  —— `tar --strip-components`（默认 1）
 *        `verify` —— 在 `.part` 上做校验（抛错 ⇒ 当作失败，`destDir` 不动）
 * @returns {string} `destDir`
 */
export function extractAtomic(archive, destDir, { strip = 1, verify } = {}) {
  const part = `${destDir}${PART_SUFFIX}`;
  const oldDir = `${destDir}${OLD_SUFFIX}${Date.now()}`;

  // 上次中断留下的半成品：按定义它就是坏的，先清掉（不清会让 tar 解到一半的旧文件混进来）
  cleanupPart(part);
  fs.mkdirSync(part, { recursive: true });

  const args = ['-xf', archive, '-C', part];
  if (strip > 0) args.push(`--strip-components=${strip}`);
  const rc = spawnSync('tar', args, { stdio: 'inherit' });
  if (rc.status !== 0) {
    cleanupPart(part);
    throw new Error(`解包失败（exit ${rc.status}）：${archive}；${destDir} 未被改动`);
  }

  if (verify) {
    try {
      verify(part);
    } catch (e) {
      cleanupPart(part);
      throw new Error(`${e.message}；${destDir} 未被改动`);
    }
  }

  // —— 提交：旧内容让位，新内容落位；第二步失败要能滚回去
  let movedOld = false;
  if (fs.existsSync(destDir)) {
    fs.renameSync(destDir, oldDir);
    movedOld = true;
  }
  try {
    fs.renameSync(part, destDir);
  } catch (e) {
    if (movedOld) fs.renameSync(oldDir, destDir);
    cleanupPart(part);
    throw new Error(`落位失败：${e.message}（已回滚到原内容）`);
  }
  if (movedOld) fs.rmSync(oldDir, { recursive: true, force: true });

  return destDir;
}

/** 供 `setup-engine.mjs` 打印用：目标目录是否留着"上一次没跑完"的痕迹。 */
export function leftovers(destDir) {
  const parent = path.dirname(destDir);
  const base = path.basename(destDir);
  try {
    return fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(`${base}${PART_SUFFIX}`) || n.startsWith(`${base}${OLD_SUFFIX}`));
  } catch {
    return [];
  }
}
