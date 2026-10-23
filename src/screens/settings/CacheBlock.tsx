import { useCallback, useEffect, useState } from 'react';
import { Btn, Modal } from '@components/units';
import { useEsc } from '@hooks/useEsc';
import { openPath } from '@/ipc';
import { toastBus } from '@/stores/toastBus';
import { musicCacheClear, musicCacheStats } from '@music/ipc';
import type { CacheStats } from '@music/types';
import type { MusicProvider } from '@music/types';

/**
 * 设置页 ③ 播放·媒体 ·「音乐缓存」项的**四格块**（左右各两行）。
 *
 * ## 为什么它是独立组件、而不是 `Row` 里的一行
 *
 * `Row`（`parts.tsx`）是固定两栏：标题在左、**窄**控件列在右。而这一项要的四格里，
 * 左列是两行（文案 + 缓存目录绝对路径）、右列也是两行（总大小 + 两个按钮）——
 * 塞进窄列会把路径挤成一条细缝。catalog 的 `SettingItem.layout = 'block'` 就是
 * 给这一项的出口：`Group` 见到它就不包 `Row`，直接把 children 渲染出来。
 *
 * ## 为什么下拉与二次确认都不复用现成件
 *
 * - **不复用 `Select`**：它是**受控值选择器**（`value` + `options` + `onChange`），
 *   语义是「在给定值里选一个」。清缓存是**触发动作** —— 每项带各自的大小文案、
 *   点了就删，没有可回显的 `value`，套 `Select` 会造出一个假的"当前选中项"。
 * - **不复用 `QuitConfirm`**：它的文案是契约冻结字面量（`spec-check.ts` 的 B3 组盯着），
 *   改成通用确认框等于改动退出流程的契约。
 *   弹层**样式**直接复用 `.modal-*`（通用，`components.scss`），Esc 用 `useEsc`。
 *
 * ## ⚠️「打开目录」的边界：为什么它不会在清空后变成坏按钮
 *
 * `open_path` 会先判 `p.exists()`，目录不存在直接返回 `Err`（`commands.rs`）——
 * 也就是「刚点完清除，'打开目录' 就报错」这类最让人困惑的缺陷。
 * 本项对这个边界有**两道**处置，缺一即静默失败：
 *   ① Rust 侧 `cache_store.rs` 的 `clear` **只删目录内容、保留根目录**（刻意设计）；
 *   ② 前端**不依赖** ① —— `root` 为空串时**禁用按钮并给出原因**（`title`），
 *      而不是让用户点一下换一条报错。若目录被手工删掉，`stats` 拿不到路径时同理。
 */
export function CacheBlock({ settingId }: { settingId: string }) {
  const [stats, setStats] = useState<CacheStats | null>(null);
  /** 读失败与"读到了但缓存是 0"是两件事：前者要如实说读不到，后者是正常的空缓存 */
  const [failed, setFailed] = useState(false);
  /** 待确认的清除范围；`null` = 没在确认 */
  const [pending, setPending] = useState<MusicProvider | 'all' | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 拉一次统计。
   *
   * 刻意**每次挂载都拉**，而不是缓存到 store：缓存大小是**播放行为**的副产物
   * （查命中 + 后台预热），设置页自己既不产生也不消费它，离谱的缓存只会读到旧值。
   */
  const reload = useCallback(async () => {
    try {
      setStats(await musicCacheStats());
      setFailed(false);
    } catch {
      // 读不到就如实显示"读取失败"，不退回 0 —— 「0」会被读成"缓存是空的"，
      // 而真相是"没读到"，两者的用户下一步完全不同。
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const root = stats?.root ?? '';
  const total = stats?.total ?? 0;

  const clear = useCallback(
    async (scope: MusicProvider | 'all') => {
      setBusy(true);
      // 记下清之前的字节数：清完再读统计只能拿到 0，"释放了多少"就说不出来了
      const freed = scope === 'all' ? total : providerBytes(stats, scope);
      try {
        // 刻意不 `void`：必须等它落盘完再重拉统计，否则会读到清之前的数字，
        // 界面上表现为"点了没反应"。
        await musicCacheClear(scope === 'all' ? undefined : scope);
        await reload();
        // 回执（设计稿同款）：单平台「已清除 X 缓存」，全部「音乐缓存已清理 + 已释放 N」
        if (scope === 'all') {
          toastBus.push('音乐缓存已清理', 'good', freed > 0 ? `已释放 ${formatBytes(freed)}` : undefined);
        } else {
          toastBus.push(`已清除 ${PROVIDER_LABEL[scope]} 缓存`, 'good', '歌词与音频缓存已释放');
        }
      } catch {
        // Rust 侧刻意不抛（清缓存失败没有可执行的下一步），真抛了也要有交代，
        // 不能变成一次静默无响应。
        toastBus.push('清理失败', 'bad', '缓存没有变化，可稍后再试');
      } finally {
        setBusy(false);
      }
    },
    [reload, total, stats],
  );

  return (
    <div className="set-cache" data-setting-id={settingId}>
      {/* 卡头由外层 `.set-subtitle` 给（设计稿把「音乐缓存」+ 统计口径写成卡头，
          这一块只负责合计、逐平台行与动作） */}

      {/* 合计（设计稿 `.cache-total`）：大字总量 + 一句口径 */}
      <div className="set-cache-total">
        {/* 无缓存显示「无」而不是「0 K」—— 后者像"精确测得是 0"，
            而这里真正的含义是"根本没有缓存" */}
        <strong>{failed ? '读取失败' : total > 0 ? formatBytes(total) : '无'}</strong>
        <span>共 {PROVIDER_ORDER.length} 个平台 · 可随时清理</span>
      </div>

      {/*
        按平台的占用明细（设计稿 `.cache-platforms` / `.cache-row`）：**常驻可见**。
        旧形态把这些数字藏在「清除缓存」的下拉里 —— 而"哪个平台占了多少"
        正是决定"要不要清、清哪个"的依据，藏在菜单里等于让用户先点一下才知道。
      */}
      <div className="set-cache-rows">
        {PROVIDER_ORDER.map((p) => {
          const bytes = providerBytes(stats, p);
          return (
            <div className="set-cache-row" key={p}>
              <span className="set-cache-row-name">{PROVIDER_LABEL[p]}</span>
              <span className="set-cache-row-size">{bytes > 0 ? formatBytes(bytes) : '无'}</span>
              <Btn
                size="sm"
                // 0 缓存置灰：没有可删的东西就不给可点的入口（点了没反应最伤）
                disabled={bytes <= 0 || busy || failed}
                title={bytes <= 0 ? `${PROVIDER_LABEL[p]}暂无缓存` : `清除${PROVIDER_LABEL[p]}的缓存`}
                // 单平台**不再二次确认**（设计稿如此）：按钮本身已经是明确作用域的动作，
                // 而缓存清掉只会重新下载，没有不可逆的数据损失；「清理全部」才需要问一句。
                onClick={() => void clear(p)}
              >
                清除
              </Btn>
            </div>
          );
        })}
      </div>

      {/* 动作区（设计稿 `.s-block-actions`）：打开缓存目录 + 清理全部缓存 */}
      <div className="set-cache-acts">
        <Btn
          size="sm"
          // 拿不到路径就禁用，而不是点了报错。`title` 说清原因 ——
          // 一个灰按钮加一句"为什么灰"才是可用的状态。
          disabled={!root || failed}
          title={root ? '在系统文件管理器里打开缓存目录' : '未拿到缓存目录，无法打开'}
          onClick={() => {
            if (!root) return;
            // `openPath` 在路径不存在时 reject（`open_path` 先判 exists）。
            // 目录可能已被手工删掉，所以这里必须兜住并说清楚 —— 静默失败最伤。
            openPath(root).catch(() => {
              setFailed(true);
              void reload();
            });
          }}
        >
          打开缓存目录
        </Btn>
        <Btn
          size="sm"
          disabled={busy || failed || total <= 0}
          title={total <= 0 ? '当前没有可清理的缓存' : '清空全部平台的音乐缓存'}
          onClick={() => setPending('all')}
        >
          清理全部缓存
        </Btn>
      </div>

      {/* 目录路径：设计稿这一卡不显示，但"缓存到底在哪"是用户清理前的必要信息，保留为脚注 */}
      <div className="set-cache-path" title={root || '未拿到缓存目录'}>
        {root || '未拿到缓存目录'}
      </div>

      {pending ? (
        <ClearConfirm
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void clear('all');
          }}
        />
      ) : null}
    </div>
  );
}

/** 四个平台的 id → 中文名（`MusicProvider` 的顺序即列表的显示顺序） */
const PROVIDER_LABEL: Record<MusicProvider, string> = {
  netease: '网易云',
  kugou: '酷狗',
  qqmusic: 'QQ音乐',
  migu: '咪咕',
};

/** 四个平台的固定顺序（明细行与「共 N 个平台」都用它，不在 JSX 里另写一份） */
const PROVIDER_ORDER = Object.keys(PROVIDER_LABEL) as MusicProvider[];

/** 某平台占用字节数（歌词 + 音频）。缺键按 0 处理 —— Rust 侧四个键恒存在 */
function providerBytes(stats: CacheStats | null, p: MusicProvider): number {
  const s = stats?.providers?.[p];
  return (s?.lyric_bytes ?? 0) + (s?.audio_bytes ?? 0);
}

/**
 * 字节 → `xx K` / `xx M` / `xx G`。
 *
 * **1024 进制 + 保留 2 位小数**（如 `1.50 M`）。1024 而不是 1000：磁盘与操作系统
 * 报的容量是 1024 进制，用 1000 会让"缓存 1.5 M"和系统显示的量对不上。
 * 两位小数：小到 KB、大到 GB 都要能看出变化，`0.5 M` 比 `512 K` 更便于一眼比较量级。
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 K';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['K', 'M', 'G'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(2)} ${units[u]}`;
}
/**
 * 「清理全部」前的二次确认（单平台不确认，见上面那个按钮的注释）。
 *
 * 清缓存**不可撤销**（删掉的文件没有回收站可捞），所以"一次清光四个平台"必须先问一句。
 * 弹层结构与 `components.scss` 的 `.modal-*` 一致 —— 那是通用样式层，
 * 与 `QuitConfirm` 那个**文案冻结**的组件无关，所以复用样式而非组件。
 */
function ClearConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  useEsc(onCancel);

  return (
    <Modal
      title="清理全部音乐缓存？"
      onClose={onCancel}
      actions={
        <>
          <Btn kind="ghost" onClick={onCancel}>
            取消
          </Btn>
          <Btn kind="danger" onClick={onConfirm}>
            清理全部
          </Btn>
        </>
      }
    >
      {/* 设计稿先说"删什么、不碰什么"（不碰歌单与本地文件），产品再补一句播放侧的影响 */}
      会删除四个平台的歌词与音频缓存，不会影响歌单与本地文件。
      <br />
      正在播放的歌会自动重新联网加载，不会中断，只是首次播放要多等一会儿。
    </Modal>
  );
}
