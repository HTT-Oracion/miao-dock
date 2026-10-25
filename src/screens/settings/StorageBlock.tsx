import { useCallback, useEffect, useState } from 'react';
import { BookOpenText, Music2 } from 'lucide-react';
import { musicCacheClear, musicCacheStats } from '@music/ipc';
import { MenuButton, MenuItem, Btn, Modal } from '@components/units';
import { useEsc } from '@hooks/useEsc';
import type { LibraryResponse } from '@/types';
import { errorText, openPath } from '@/ipc';
import { useToasts } from '@hooks';
import { toastBus } from '@/stores/toastBus';
import { formatBytes } from '@tools';
import { PLATFORMS } from '@music/platform';
import type { CacheStats, MusicProvider } from '@music/types';
import type { SettingItem } from '@screens/settings/catalog';

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
 * 设置页 ④ 资源与投放 ·「存储占用」项的**三行分列块**（台账 D-84）。
 *
 * ## 为什么是"三行各有各的来源"，而不是一个大数字
 *
 * 这一项原先整条 `pending`，理由是"要覆盖译文库 + 音频缓存 + 模型三处，需 Rust 侧统一盘点"。
 * 那个理由只在"要凑一个总占用"这个前提下成立 —— 而**凑总数恰恰是不该做的事**：
 * 三处的口径、位置、生命周期都不同（译文库按任务落盘、音频缓存按平台分子目录、
 * 模型在服务侧且**目前没有任何接口能读出它占了多少**）。
 * 把它们加在一起，等于把"没有接口的那一处"当 0 算进总数 —— 用户看到的是
 * 一个看起来完整、实际少算的假数字。
 *
 * 拆开就没有这个问题：**每一行要么给出真实数字，要么如实说"未统计"**。
 * 所以这里刻意**没有一个合计行** —— 那不是遗漏，是本项的立场。
 *
 * ## 三种"没有值"必须分开说（这一项最容易做错的地方）
 *
 * | 情形 | 显示 | 为什么不能都写「—」/都写 0 |
 * |---|---|---|
 * | 服务没起来 / 还没读到 | `读取中…` | 与"读到了，就是这么大"是两件事 |
 * | 读到了，确实是空 | `无` | 写 `0 B` 会被读成"精确测得是 0"，而真相是"这一处还没有东西" |
 * | 压根没有接口 | `未统计` | 与"读了但失败"必须区分：前者要等接口，后者重试即可 |
 *
 * ## 数据来源的取法
 *
 * · 译文库：由 `App` 的 `useLibrary` 传进来（**详情页读的是同一份**）——
 *   设置页不再自己拉一次，否则两处会因为取数时刻不同而各报一个数，
 *   而两边都没错、却谁也说服不了谁。
 * · 音频缓存：`musicCacheStats()`（与 ③「音乐缓存」同一个命令，不是第二套口径）。
 *
 * ## 「翻译模型」那一行已去掉（2026-10-25，用户要求）
 *
 * 它长期只有 `未统计`（服务侧没有"模型占了多少"的接口），留一行"读不出来"的数字
 * 只是占位。去掉后本块是**两行**：译文库 / 音乐缓存 —— 两行都给出真实读数与目录地址。
 * ⚠️ 这不是"删掉一个不好看的项"：只要那条接口出现，这一行就该加回来（连同它的读数）。
 */
export function StorageBlock({ item, lib }: { item: SettingItem; lib: LibraryResponse | null }) {
  const { push: toast } = useToasts();
  const [cache, setCache] = useState<CacheStats | null>(null);
  /** 与「音乐缓存」同一把尺子：读失败与"读到了但是空"必须分开 */
  const [cacheFailed, setCacheFailed] = useState(false);
  /** 待确认的清除范围；`null` = 没在确认 */
  const [pending, setPending] = useState<MusicProvider | 'all' | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setCache(await musicCacheStats());
      setCacheFailed(false);
    } catch {
      setCacheFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const root = cache?.root ?? '';
  const total = cache?.total ?? 0;

  /** 音频缓存那一行的取值 —— 三种"没有值"分开说，别混成一个「—」 */
  const cacheText = cacheFailed
    ? '读取失败'
    : cache === null
      ? '读取中…'
      : cache.total > 0
        ? formatBytes(cache.total)
        : '无';

  /**
   * 译文库占用（右列读数）。同样三种"没有值"分开说：
   * `lib === null` 是"还没读到"，与"读到了但是空"不是一回事。
   */
  const libText = lib === null ? '读取中…' : lib.totalBytes > 0 ? formatBytes(lib.totalBytes) : '无';

  const clear = useCallback(
    async (scope: MusicProvider | 'all') => {
      setBusy(true);
      // 记下清之前的字节数：清完再读统计只能拿到 0，"释放了多少"就说不出来了
      const freed = scope === 'all' ? total : providerBytes(cache, scope);
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
    [reload, total, cache],
  );

  return (
    <div className="set-storage" data-setting-id={item.id}>
      <div className="set-storage-head">
        <div className="set-storage-name">{item.label}</div>
      </div>

      <div className="set-storage-rows">
        <div className="set-storage-row">
          <span className="set-storage-ico">
            <BookOpenText size={16} />
          </span>
          <div className="set-storage-tx">
            <strong>译文库</strong>
            {lib?.root ? (
              <Btn
                kind="text"
                className="set-storage-dir"
                title={lib.root}
                onClick={() => openPath(lib.root!).catch((e: unknown) => toast(errorText(e), 'bad'))}
              >
                {lib.root}
              </Btn>
            ) : (
              <small className="is-unknown">{lib === null ? '目录读取中…' : '未拿到目录'}</small>
            )}
          </div>
          {/* 右列：占用大小（与音乐缓存那行的读数同形，三行右缘对齐） */}
          <span className="set-storage-acts">
            <span className="set-storage-size">{libText}</span>
          </span>
        </div>

        {/*
          「音乐缓存」行
        */}
        <div className="set-storage-row">
          <span className="set-storage-ico">
            <Music2 size={16} />
          </span>
          <div className="set-storage-tx">
            <strong>音乐缓存</strong>
            {root ? (
              <Btn
                kind="text"
                className="set-storage-dir"
                title={root}
                onClick={() => openPath(root).catch((e: unknown) => toast(errorText(e), 'bad'))}
              >
                {root}
              </Btn>
            ) : (
              <small className="is-unknown">{cacheText} · 未拿到缓存目录</small>
            )}
          </div>
          <span className="set-storage-acts is-stacked">
            <span className="set-storage-size">{cacheText}</span>
            <MenuButton
              label="删除"
              ariaLabel="删除音乐缓存"
              size="sm"
              disabled={busy || cacheFailed || total <= 0}
              title={total <= 0 ? '当前没有可清理的缓存' : '按平台删除音乐缓存'}
            >
              {(close) => (
                <>
                  {PROVIDER_ORDER.map((p) => {
                    const bytes = providerBytes(cache, p);
                    const meta = PLATFORMS.find((x) => x.id === p);
                    return (
                      <MenuItem
                        key={p}
                        icon={
                          <span className="set-cache-orb" style={{ background: meta?.color ?? 'var(--md-line-soft)' }}>
                            {meta?.short ?? '?'}
                          </span>
                        }
                        label={PROVIDER_LABEL[p]}
                        sub={bytes > 0 ? formatBytes(bytes) : '无'}
                        disabled={bytes <= 0}
                        title={bytes <= 0 ? `${PROVIDER_LABEL[p]}暂无缓存` : `清除${PROVIDER_LABEL[p]}的缓存`}
                        onClick={() => {
                          close();
                          setPending(p);
                        }}
                      />
                    );
                  })}
                  <MenuItem
                    danger
                    label="删除全部"
                    sub={total > 0 ? formatBytes(total) : undefined}
                    disabled={total <= 0}
                    title="清空全部平台的音乐缓存"
                    onClick={() => {
                      close();
                      setPending('all');
                    }}
                  />
                </>
              )}
            </MenuButton>
          </span>
        </div>
      </div>

      {pending ? (
        <ClearConfirm
          scope={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const scope = pending;
            setPending(null);
            void clear(scope);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 「删除全部」前的二次确认
 */
function ClearConfirm({
  scope,
  onCancel,
  onConfirm,
}: {
  scope: MusicProvider | 'all';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEsc(onCancel);

  const title = scope === 'all' ? '清理全部音乐缓存？' : `清除${PROVIDER_LABEL[scope]}的缓存？`;
  const confirmLabel = scope === 'all' ? '清理全部' : '清除';

  return (
    <Modal
      title={title}
      onClose={onCancel}
      actions={
        <>
          <Btn kind="ghost" onClick={onCancel}>
            取消
          </Btn>
          <Btn kind="danger" onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </>
      }
    >
      会删除{scope === 'all' ? '四个平台' : PROVIDER_LABEL[scope]}的歌词与音频缓存，不会影响歌单与本地文件。
      <br />
      正在播放的歌会自动重新联网加载，不会中断，只是首次播放要多等一会儿。
    </Modal>
  );
}
