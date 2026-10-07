import { useCallback, useEffect, useState } from 'react';
import { musicCacheStats } from '@music/ipc';
import type { LibraryResponse } from '@/types';
import { formatBytes } from '@/util';
import type { SettingItem } from '@screens/settings/catalog';

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
 * · 模型：没有命令可用 ⇒ 如实写 `未统计`，并说明缺的是哪一条接口。
 */
export function StorageBlock({ item, lib }: { item: SettingItem; lib: LibraryResponse | null }) {
  const [cache, setCache] = useState<{ total: number } | null>(null);
  /** 与「音乐缓存」同一把尺子：读失败与"读到了但是空"必须分开 */
  const [cacheFailed, setCacheFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const s = await musicCacheStats();
      setCache({ total: s.total });
      setCacheFailed(false);
    } catch {
      setCacheFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 音频缓存那一行的取值 —— 三种"没有值"分开说，别混成一个「—」 */
  const cacheText = cacheFailed ? '读取失败' : cache === null ? '读取中…' : cache.total > 0 ? formatBytes(cache.total) : '无';

  return (
    <div className="set-storage">
      <div className="set-storage-head">
        <div className="set-storage-name">{item.label}</div>
        {/* 立场写在脸上：用户看到三行会本能地想做加法，这里先把话说明 */}
        <div className="set-storage-rule">三处分开列 · 不合计</div>
      </div>

      <div className="set-storage-rows">
        <div className="set-storage-row">
          <span className="set-storage-k">译文库</span>
          <span className="set-storage-v">
            {lib === null ? '读取中…' : lib.totalBytes > 0 ? formatBytes(lib.totalBytes) : '无'}
          </span>
          <span className="set-storage-src">
            {lib === null ? '漫画库盘点 · 未读到' : `漫画库盘点 · ${lib.count} 部 / ${lib.totalImages} 张`}
          </span>
        </div>

        <div className="set-storage-row">
          <span className="set-storage-k">音频缓存</span>
          <span className="set-storage-v">{cacheText}</span>
          <span className="set-storage-src">音乐缓存目录 · 仅在线歌曲</span>
        </div>

        {/*
          模型那一行是本项的**诚实位**：没有接口就是没有接口。
          刻意不写「0」也不写「—」—— 前者会被读成"模型没占空间"（显然不对），
          后者什么都不说明。写「未统计」+ 缺哪条接口，才让下一个人知道该做什么。
        */}
        <div className="set-storage-row">
          <span className="set-storage-k">模型</span>
          <span className="set-storage-v is-unknown">未统计</span>
          <span className="set-storage-src">缺少接口 · 模型目录占用需 Rust 侧盘点</span>
        </div>
      </div>
    </div>
  );
}
