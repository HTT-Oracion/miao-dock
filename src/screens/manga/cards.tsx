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
 * 页卡状态角的悬停说明（与 `GRID_LABEL` 同源）。
 *
 * 抽成具名映射而不是在 JSX 里写三元链：三种状态的文案各自不同，
 * 内联三元会让「已译 / 待译 / 缺页」的解释混在一行里，改一处要重新读整行。
 */
export const GRID_HINT: Record<GridState, (seq: number) => string> = {
  done: (seq) => `第 ${seq} 页：本地已有译文`,
  pending: (seq) => `第 ${seq} 页：有原图、缺译文 —— 点「继续翻译」可以补`,
  missing: (seq) => `第 ${seq} 页：本机没有这一页`,
};

/**
 * 空态插画（设计稿 `.empty-art` 里的猫头）。
 *
 * 为什么画成 SVG 而不是放一张图：它要跟着主题换色（描边取 ink、纸页取 surface-2、
 * 星芒取 accent），位图做不到；且它是**空态**的装饰，不该多一次网络/IPC 往返。
 * 纯装饰，故 `aria-hidden` —— 空态的信息由旁边的标题与说明承载。
 */
export function EmptyArt() {
  return (
    <svg className="empty-art" viewBox="0 0 132 112" fill="none" aria-hidden="true">
      <ellipse cx="66" cy="102" rx="40" ry="5" fill="var(--miao-line)" opacity="0.7" />
      <path
        d="M36 56c0-18 13-30 30-30s30 12 30 30v22c0 12-13 20-30 20s-30-8-30-20V56Z"
        fill="var(--miao-surface)"
        stroke="var(--miao-ink)"
        strokeWidth="1.8"
      />
      <path
        d="M42 32 38 13l17 10M90 32l4-19-17 10"
        fill="var(--miao-surface-2)"
        stroke="var(--miao-ink)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M46 57c3-4 8-4 11 0M75 57c3-4 8-4 11 0" stroke="var(--miao-ink)" strokeWidth="2" strokeLinecap="round" />
      <path d="M62 68c3 3 7 3 10 0" stroke="var(--miao-ink)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M56 38c4-6 16-6 20 0" stroke="var(--miao-accent)" strokeWidth="1.2" opacity="0.55" />
      <path
        d="M51 79c-8 0-14 5-14 12v9h60v-9c0-7-6-12-14-12"
        fill="var(--miao-surface-2)"
        stroke="var(--miao-ink)"
        strokeWidth="1.8"
      />
      <rect
        x="72"
        y="72"
        width="38"
        height="28"
        rx="3"
        fill="var(--miao-accent-soft)"
        stroke="var(--miao-ink)"
        strokeWidth="1.5"
        transform="rotate(-6 91 86)"
      />
      <path
        d="M79 82h24M79 88h17"
        stroke="var(--miao-ink)"
        strokeWidth="1.1"
        opacity="0.5"
        transform="rotate(-6 91 86)"
      />
      <path
        d="M104 49l1.8 4.2 4.2 1.8-4.2 1.8L104 61l-1.8-4.2L98 55l4.2-1.8z"
        fill="var(--miao-accent)"
        opacity="0.8"
      />
      <path d="M24 42l1.2 2.8 2.8 1.2-2.8 1.2L24 50l-1.2-2.8L20 46l2.8-1.2z" fill="var(--miao-accent)" opacity="0.6" />
    </svg>
  );
}

/**
 * 封面缩略。
 *
 * `loading` 与 `missing` 都落到占位（`line-soft` 底 + 书名首字，设计稿 §7.1）：
 * 小格子里塞「加载中…」比直接显示首字更难看，且缩略图取回来只要几十毫秒。
 * 但 `ready` 与"取不到"必须分开 —— 取不到时**不能**装作还在加载。
 *
 * 尺寸与圆角由调用方从 `LIBRARY.cover.thumb` 传进来（38×50 / r7，设计稿 `.book-thumb`）：
 * 它们是**行内样式**，优先级高于样式表 ⇒ 改 CSS 里的 `.cover-thumb` 不会生效。
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
