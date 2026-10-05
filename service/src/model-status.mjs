// 模型就绪态 —— `GET /engine/status` 的 `models` 块（《03》§5.2）
//
// 回答两个问题：
//   ① 现在能不能真翻译（`visualReady` / `sakuraReady`）
//   ② 盘上这些文件**上一次被完整校验**是什么时候（`lastVerifiedAt`）
//
// 🔴 为什么这里只做 `stat`、不做哈希：
//    视觉 4 件 + Sakura 权重合计 ≈ 4 GB。诊断视图是**可以被反复打开**的界面元素，
//    每次打开都重算 3.3 GB 的 sha256 会让"看一眼状态"变成分钟级操作。
//    所以本模块的判据是 **在位 + 大小与清单一致**，而 `lastVerifiedAt` 专门用来把
//    「刚才 stat 过」和「上次完整校验过」这两件事分开报 —— 不把前者说成后者。
//    需要真哈希时有现成入口：`engine/scripts/fetch-models.mjs --check`（S3 的 `verifyModels`）。
//
// ⚠️ 路径按**谁真会去开它**来选，不是按"清单里写的是哪个"：
//    · 声明了 `linkTo` 的文件 → 引擎实际打开的是 `<rootDir>/src/<linkTo>`（硬链接，见 model-store.mjs）；
//    · 没声明 `linkTo` 的（Sakura 权重 / llama 归档）→ 就地读 `<rootDir>/<dest>`。
//    只看 `dest` 会漏掉「store 里有、但没链进引擎树」这一种**真的跑不起来**的状态：
//    引擎读的是自己源码树里那份，store 里那份再完整也白搭。
import fs from 'node:fs';
import path from 'node:path';

/** 读取 `.ready` 标记（S3 写入；不存在 ⇒ null，不报错） */
function readReadyMarker(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, '.models.ready.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // 没跑过下载 / 标记被删 —— 这不是错误，只是"没校验过"
  }
}

function sizeAt(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.manifestPath `engine/models.manifest.json` 的绝对路径
 * @param {string} opts.rootDir      模型根目录（`dest` 相对于它）
 * @param {string} [opts.linkBase]   `linkTo` 的基准目录，缺省 `<rootDir>/src`
 * @returns {Promise<{visualReady:boolean, sakuraReady:boolean, lastVerifiedAt:string|null}>}
 */
export async function modelStatus({ manifestPath, rootDir, linkBase } = {}) {
  const base = linkBase || path.join(rootDir, 'src');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // 清单本身读不到 ⇒ 无法回答"就绪"，一律 false（而不是抛错把整个诊断视图带崩）
    return { visualReady: false, sakuraReady: false, lastVerifiedAt: null };
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const inSet = (setName) => new Set(manifest.sets?.[setName]?.files ?? []);

  /** 该文件是否"在位且大小与清单一致" */
  const isReady = (f) => {
    const abs = path.isAbsolute(f.linkTo || '') ? f.linkTo
      : (f.linkTo ? path.join(base, f.linkTo) : path.join(rootDir, f.dest));
    const got = sizeAt(abs);
    if (got === null) return false;
    // 清单没写 sizeBytes 时退化为"存在即就绪"（不假装校验过大小）
    return Number.isFinite(f.sizeBytes) ? got === f.sizeBytes : true;
  };
  const allReady = (setName) => {
    const ids = inSet(setName);
    const picked = files.filter((f) => ids.has(f.id));
    // 空集合 ⇒ **不是**"就绪"：清单里一个文件都没声明时，说什么都不该是"能翻译"
    return picked.length > 0 && picked.every(isReady);
  };

  const marker = readReadyMarker(rootDir);
  return {
    visualReady: allReady('visual'),
    sakuraReady: allReady('llm'),
    lastVerifiedAt: marker && typeof marker.verifiedAt === 'string' ? marker.verifiedAt : null,
  };
}
