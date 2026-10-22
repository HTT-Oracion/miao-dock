// 屏 B 的「话卡」（设计稿 §7.3）。
//
// ## 为什么单独一个文件
// `LibraryScreen.tsx` 被断言脚本按路径写死并读源码（`e2e/units-structure-check.mjs:71`、
// `e2e/service/retranslate-check.mjs:66`、`e2e/service/library-manage-check.mjs:426`），
// 搬它有"静默跳过断言"的风险；而 Step 6 又要往屏里加两屏。故按 plan Step 5 的同一裁定：
// **新件**落 `app/src/screens/library/`，老文件原地不动。
//
// ## 与弹窗同样的纪律：受控视图
// 话卡自己**不发任何请求**、不改任何状态 —— 连缩略图都用声明式的 `useBlobUrl`。
// 「重译本话 / 打开目录」只把意图回抛给屏：这三个动作都要 `onRefresh()`、要发 Toast、
// 失败还要把结构化错误翻成人话，那些全在屏里。放在卡片里做，就会出现"卡片自己刷了、
// 左栏与头部没刷"的半刷新。
import { FolderUp, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react';

import { Dot, MenuButton, MenuItem } from '@components/units';
import type { ChapterEntry } from '@/types';

// ------------------------------------------------------------------ 状态

/**
 * 话的四种状态（设计稿 §7.3「状态点 / 脚注」）。
 *
 * 与左栏的 `progressLabel` 不是同一套：那里的主语是**一部漫画**，空目录叫「空目录」；
 * 这里的主语是**一话**，空的那一话该叫「空话」（设计稿 §7.3 的缩略占位用的就是这个词）。
 * 硬合成一个函数就得给"空"这个字配参数，反而更难读。
 */
export type ChapterState = 'done' | 'pending' | 'missing' | 'empty';

const CHAPTER_STATE_LABEL: Record<ChapterState, string> = {
  done: '已译完',
  pending: '待译',
  missing: '缺页',
  empty: '空话',
};

/**
 * 状态点色（设计稿 §7.3：已译完 success / 待译 blue / 缺页 warning / 空话 muted）。
 *
 * 颜色只是**辅助**：每种状态在脚注里都有文字（`.chapter-state` 同时渲染点与字），
 * 所以色盲用户不会丢信息 —— 这也是《02》§5.2「颜色不得作为唯一信息载体」的落地。
 */
const CHAPTER_STATE_DOT: Record<ChapterState, string> = {
  done: '--md-success',
  pending: '--md-blue',
  missing: '--md-warning',
  empty: '--md-muted',
};

export interface ChapterStatus {
  state: ChapterState;
  /** 脚注右侧的短语，如「待译 3」 */
  text: string;
}

/**
 * 一话的状态短语。
 *
 * 判定一律用**逐页集合**（`translatedSeqs` / `missingSeqs`），不用张数（G-10）：
 * `imageCount - translatedCount` 回答不了"译了哪几页"，缺页落在中间时会把后面每一页
 * 整体前移一位，于是「待译 N」这个数本身是错的。
 *
 * 优先级：缺页 > 待译 —— 缺页是"文件真的没了"（用户得去补文件），待译只是"还没轮到"。
 * 两者同时存在时**两个数都写出来**（`缺页 1 · 待译 3`），不靠"取更严重的那个"掩盖另一个。
 */
export function chapterStatusOf(c: {
  imageCount: number;
  translatedCount: number;
  missingSeqs: number[];
}): ChapterStatus {
  if (c.imageCount === 0) return { state: 'empty', text: CHAPTER_STATE_LABEL.empty };
  const missing = c.missingSeqs.length;
  // `translatedCount` 可能大于 imageCount（译文在、原图被外部拿掉了），故钳到 0
  const pending = Math.max(0, c.imageCount - c.translatedCount - missing);
  const parts: string[] = [];
  if (missing > 0) parts.push(`${CHAPTER_STATE_LABEL.missing} ${missing}`);
  if (pending > 0) parts.push(`${CHAPTER_STATE_LABEL.pending} ${pending}`);
  if (parts.length === 0) return { state: 'done', text: CHAPTER_STATE_LABEL.done };
  return { state: missing > 0 ? 'missing' : 'pending', text: parts.join(' · ') };
}

// ------------------------------------------------------------------ 话卡

/**
 * 「删除本话」的置灰理由（设计稿 §8.4 的统一文案 + §7.3 的裁决）。
 *
 * 详情页里的话**恒为已归并语义**（它已经在所属漫画目录里了），所以这条永远置灰：
 * 「话不能脱离所属漫画单独消失」这条规则要**显式表达出来**，而不是把入口藏起来
 * 让人找不到。置灰 ≠ 不弹窗，点它应当是"没反应"，而不是弹一个必然失败的确认框。
 */
export const CHAPTER_DELETE_BLOCKED_TITLE = (bookName: string, no: number): string =>
  `已归并到《${bookName}》第 ${no} 话，请在《${bookName}》中删除`;

/**
 * 话卡 110×165 r12（沿用 `LIBRARY.card` 令牌，设计稿 §7.3 明写"不新增几何"）。
 *
 * ## 为什么外层是 `div`、内层才是 `button`
 * 卡片本体要能点（进屏 C），卡片上又有一个菜单按钮 —— 把菜单塞进 `<button>` 里
 * 就是嵌套交互元素（HTML 不合法、读屏器会当成一个按钮里的两个动作）。
 * 拆成「容器 + 主按钮 + 悬浮菜单」三个平级节点后，语义与焦点顺序都正常。
 */
export function ChapterCard({
  bookName,
  chapter,
  busy,
  onOpen,
  onOpenDir,
  onResume,
  onRetranslate,
  onEditNo,
}: {
  bookName: string;
  chapter: ChapterEntry;
  /** 本话（或所属漫画）已有任务在跑 ⇒ 重译/续做入口置灰 */
  busy: boolean;
  onOpen: () => void;
  onOpenDir: () => void;
  /** 续做本话（把「有原图、缺译文」的页加入队列）—— 头部菜单迁往右键后，话级续做的家在这里 */
  onResume: () => void;
  onRetranslate: () => void;
  /** 编辑话数（改号 = 服务端给话目录改名，弹窗收集新号） */
  onEditNo: () => void;
}) {
  const no = chapter.no;
  const status = chapterStatusOf(chapter);
  // 空话（一张原图都没有）不取图：对"确定没有"的东西发一次必然 404 的请求，
  // 表现是缩略图先停在「加载中…」再变成失败 —— 把"不存在"伪装成"还没到"。
  // 本话待续做张数（有原图、缺译文的页数；集合判定，不用张数倒推 —— G-10）
  const pendingCount = Math.max(0, chapter.imageCount - chapter.translatedCount - chapter.missingSeqs.length);

  // 无原图 ⇒ 服务端的返工计划会是空的（`retranslateCount === 0`），点了必然 409。
  // 前端先拦：与「更多操作」菜单的 `noOriginal` 分支同一口径。
  const noOriginal = chapter.imageCount === 0;
  const rtTitle = busy
    ? '该漫画已有任务在队列中，等它跑完再返工'
    : noOriginal
      ? '该话没有原图，无从返工'
      : `重新翻译本话 ${chapter.imageCount} 张（覆盖 ${chapter.translatedCount} 张已有译文）`;
  const rtSub = busy ? '返工中' : noOriginal ? '没有原图' : `覆盖 ${chapter.translatedCount} 张`;

  return (
    /*
     * 话卡（设计稿 `.chapter-card`）：**文字卡**，不是封面缩略图卡。
     * 旧写法复用 110×165 的 `.grid-card` 并加载缩略图 —— 一部 30 话就要拉 30 张图，
     * 而这一层要回答的是"第几话、译了多少、缺不缺页"，一张缩略图提供不了这些信息。
     * 现在：上排「第 N 话 + 状态」、中排页数、下排一条进度条，右上角是操作菜单。
     */
    <div className={`chapter-card is-${status.state}`} data-chapter-no={no ?? undefined}>
      <button
        type="button"
        className="cc-main"
        onClick={onOpen}
        disabled={no === null}
        aria-label={no === null ? '未编号的目录' : `第 ${no} 话`}
        title={no === null ? '该目录没有话号，无法作为话打开' : `第 ${no} 话 · 点开看这一话的页`}
      >
        <div className="cc-top">
          <span className="cc-no">{no === null ? '未编号' : `第 ${no} 话`}</span>
          <span className="cc-state" title={status.text}>
            <Dot colorVar={CHAPTER_STATE_DOT[status.state]} />
            {status.text}
          </span>
        </div>
        <div className="cc-pages">
          <span className="num">{chapter.translatedCount}</span> / <span className="num">{chapter.imageCount}</span>{' '}
          页已译
          {chapter.missingSeqs.length > 0 ? ` · 缺 ${chapter.missingSeqs.length} 页` : ''}
        </div>
        <div className="cc-bar">
          <i
            style={{
              width: `${
                chapter.imageCount > 0 ? Math.round((chapter.translatedCount / chapter.imageCount) * 100) : 0
              }%`,
            }}
          />
        </div>
      </button>

      {/* 悬浮菜单：点它不能顺带把卡片点开（否则"想重译却进了屏 C"） */}
      <span className="cc-menu" onClick={(e) => e.stopPropagation()}>
        <MenuButton label="⋯" size="sm" ariaLabel="话操作" title={`第 ${no} 话的操作`}>
          {(close) => (
            <>
              <MenuItem
                icon={<FolderUp size={13} />}
                label="打开目录"
                title="在文件管理器里打开这一话的目录"
                onClick={() => {
                  close();
                  onOpenDir();
                }}
              />
              <MenuItem
                icon={<Play size={13} />}
                label="续做本话"
                sub={pendingCount > 0 ? `待续做 ${pendingCount} 张` : '没有待续做的页'}
                disabled={busy || pendingCount === 0}
                title={
                  pendingCount === 0
                    ? '本话没有「有原图、缺译文」的页'
                    : `把待译的 ${pendingCount} 页加入队列（不覆盖已有译文）`
                }
                onClick={() => {
                  close();
                  onResume();
                }}
              />
              <MenuItem
                icon={<RotateCcw size={13} />}
                label="重译本话"
                sub={rtSub}
                disabled={busy || noOriginal}
                title={rtTitle}
                onClick={() => {
                  close();
                  onRetranslate();
                }}
              />
              <MenuItem
                icon={<Pencil size={13} />}
                label="编辑话数"
                title={no === null ? '该目录没有话号，无从改起' : `把第 ${no} 话改成另一个话号（页文件原地保留）`}
                disabled={no === null}
                onClick={() => {
                  close();
                  onEditNo();
                }}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="删除本话"
                danger
                disabled
                title={no === null ? '该目录没有话号' : CHAPTER_DELETE_BLOCKED_TITLE(bookName, no)}
                // 恒置灰：`MenuItem` 的 `onClick` 是必填，给一个空实现而不是删掉这个入口
                onClick={() => {}}
              />
            </>
          )}
        </MenuButton>
      </span>
    </div>
  );
}
