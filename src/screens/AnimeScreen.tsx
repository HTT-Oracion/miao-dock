/**
 * 番剧屏本体（与 `MusicScreen` 同级）—— 模块内十屏的分派点。
 *
 * 为什么视图不进制路由：与音乐同口径（`APP_VIEWS.anime = null`）——
 * 番剧是独立应用、自成工作区；URL 只回答「哪个应用」（`/anime`）。
 * 屏内切换由 store 的 `view` 承担，侧栏 popover 与各屏内按钮都走同一个 `setView`。
 */
import { useEffect } from 'react';
import { useAnimeStore } from '@anime/store';
import { DiscoverScreen } from '@screens/anime/DiscoverScreen';
import { CollectionScreen } from '@screens/anime/CollectionScreen';
import { CacheScreen } from '@screens/anime/CacheScreen';
import { DetailScreen } from '@screens/anime/DetailScreen';
import { PlayerScreen } from '@screens/anime/PlayerScreen';
import { HistoryScreen } from '@screens/anime/HistoryScreen';
import { AccountScreen } from '@screens/anime/AccountScreen';
import { SourceScreen } from '@screens/anime/SourceScreen';
import { StatesScreen } from '@screens/anime/StatesScreen';

export function AnimeScreen() {
  const view = useAnimeStore((s) => s.view);
  const refresh = useAnimeStore((s) => s.refreshLibrary);
  const loadSources = useAnimeStore((s) => s.loadSources);
  const loadCache = useAnimeStore((s) => s.loadCache);
  const loaded = useAnimeStore((s) => s.loaded);

  /*
   * 首次进入才拉数据：`loaded` 置真后不再重复扫描。
   * 扫描走 `animesvc`（目录 + manifest），前端不直接碰文件系统 —— 分层硬约束。
   */
  useEffect(() => {
    if (loaded) return;
    void refresh();
    void loadSources();
    void loadCache();
  }, [loaded, refresh, loadSources, loadCache]);

  return (
    <div className="an-root">
      {view === 'explore' ? <DiscoverScreen /> : null}
      {view === 'collection' ? <CollectionScreen /> : null}
      {view === 'cache' ? <CacheScreen /> : null}
      {view === 'detail' ? <DetailScreen /> : null}
      {view === 'player' ? <PlayerScreen /> : null}
      {view === 'history' ? <HistoryScreen /> : null}
      {view === 'account' ? <AccountScreen /> : null}
      {view === 'source' ? <SourceScreen /> : null}
      {view === 'states' ? <StatesScreen /> : null}
    </div>
  );
}
