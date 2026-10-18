// 漫画库的**纯展示小件**：封面缩略 `CoverThumb` · 搜索命中高亮 `Highlight` · 网格缩略 `Thumb`。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-148）：它们是"给数据、画像素"的无状态件，
// 与屏本体的状态机 / 编排无关；单独成文件后屏本体只留编排与列表。
import { matchIndices } from '@tools';
import { useBlobUrl } from '@screens/manga/blob';

/**
 * 网格卡三态 —— 判定依据是 `/library` 给出的**逐页**集合（`translatedSeqs` / `missingSeqs`），
 * 不是张数。张数只能回答「译了几页」，回答不了「译了哪几页」；缺页落在中间时，
 * 用张数推出来的结论会把后面每一页整体前移一位，见 spec-notes G-10。
 */
export type GridState = 'done' | 'pending' | 'missing';

export const GRID_LABEL: Record<GridState, string> = { done: '已译', pending: '待译', missing: '缺页' };

/**
 * 封面缩略。
 *
 * `loading` 与 `missing` 都落到占位（`line-soft` 底 + 书名首字，设计稿 §7.1）：
 * 32×44 的小格子里塞「加载中…」比直接显示首字更难看，且缩略图取回来只要几十毫秒。
 * 但 `ready` 与"取不到"必须分开 —— 取不到时**不能**装作还在加载。
 *
 * 尺寸与圆角由调用方从 `LIBRARY.cover` 传进来（左栏缩略 32×44、详情头 56×76）：
 * 这两个值只差尺寸，各写一份 CSS 规则就会出现"改了一处、另一处还是旧的"。
 */
export function CoverThumb({
  path,
  name,
  className,
  w,
  h,
  radius,
}: {
  path: string | null;
  name: string;
  className: string;
  w: number;
  h: number;
  radius: number;
}) {
  const blob = useBlobUrl(path);
  const style = { width: w, height: h, borderRadius: radius };
  if (blob.kind === 'ready') {
    return <img className={className} style={style} src={blob.url} alt="" draggable={false} />;
  }
  return (
    <div className={`${className} is-ph`} style={style} aria-hidden="true">
      {name.slice(0, 1)}
    </div>
  );
}

/**
 * 把 `text` 按命中下标切成「命中 / 未命中」两色片段（命中片段加 `grp-hit`，设计稿 §7.2）。
 *
 * 下标来自 `matchIndices()` —— 与 `fuzzyMatch()` **同一判定**，所以不可能出现
 * "行判为命中却一个字都没高亮"。相连的下标合并成一段，避免一个字一个 `<span>`。
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const idx = matchIndices(text, query);
  if (!idx || idx.length === 0) return <>{text}</>;
  const set = new Set(idx);
  const runs: { hit: boolean; text: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i]!;
    else runs.push({ hit, text: text[i]! });
  }
  return (
    <>
      {runs.map((r, i) =>
        r.hit ? (
          <span key={i} className="grp-hit">
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/**
 * 网格缩略图。三态必须分开，且**只在确实有译文时才发请求** ——
 * 对已知没有译文的页仍去取一次、失败后显示「加载中…」，是把「不存在」伪装成「还没到」。
 *
 * 收 `path`（而不是 `comicName + seq` 自己去拼）：屏 C 的页源可能是大类里的一话
 * （`/library/{书}/chapters/{话}/files/…`），也可能是「其它」里的单话或旧口径的整本
 * （`/library/{名}/files/…`）。让缩略图自己拼路径，就得在这里再判一次"我这一层是话还是整本"
 * —— 那个判断只该有一处（`PageView`）。
 */
export function Thumb({ path, seq, state }: { path: string; seq: number; state: GridState }) {
  // hooks 不能条件调用，故把「要不要取」编码进 path（null = 不取）
  const blob = useBlobUrl(state === 'done' ? path : null);
  if (state === 'done') {
    if (blob.kind === 'loading') return <div className="grid-placeholder">加载中…</div>;
    if (blob.kind === 'ready') {
      return <img className="grid-thumb" src={blob.url} alt={`第 ${seq} 页译文`} draggable={false} />;
    }
    // 库扫描说这页有译文、文件却取不到 —— 不装作没事
    return (
      <div className="grid-placeholder is-bad" title="库里有这一页的译文记录，但文件读不出来">
        读取失败
      </div>
    );
  }
  if (state === 'missing') return <div className="grid-placeholder">缺页</div>;
  return <div className="grid-placeholder">待译</div>;
}
