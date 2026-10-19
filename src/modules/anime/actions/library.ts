/**
 * 番剧库切片 —— 服务状态 / 扫描 / 选中 / 收藏 / 进度 / 偏好。
 *
 * 纪律：**状态先写进 store，再落盘**。落盘失败只回填 `error`，不回滚界面 ——
 * 用户刚点下的动作立刻被撤销比"稍后重试"更让人困惑；而 `error` 会显示在屏上。
 */
import * as ipc from '@anime/ipc';
import type { AnimeState, StoreGet, StoreSet } from '@anime/slice';
import type { AnimeEpisode, CollectionType, MediaSourceView } from '@anime/types';
import type { AnimePrefs } from '@anime/prefs';
import { savePrefs } from '@anime/prefs';

/** 把 IPC 错误折成一句能显示的话（Tauri 抛的是 unknown） */
function errText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function libraryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AnimeState,
  | 'refreshLibrary'
  | 'selectSubject'
  | 'openPlayer'
  | 'setCollection'
  | 'markWatched'
  | 'savePosition'
  | 'setPref'
  | 'loadDemo'
  | 'clearDemo'
  | 'loadSources'
  | 'loadCache'
  | 'refreshStatus'
> {
  /** 把扫描结果写进 store（三处调用共用，避免字段漏写） */
  const applySnapshot = (snap: Awaited<ReturnType<typeof ipc.animeLibrary>>) => {
    set({
      libraryRoot: snap.root,
      subjects: snap.subjects,
      episodes: snap.episodes,
      scannedAt: snap.scannedAt,
      skipped: snap.skipped,
      loaded: true,
      loading: false,
      error: null,
    });
  };

  return {
    refreshStatus: async () => {
      try {
        set({ status: await ipc.animeStatus() });
      } catch (e) {
        set({ error: `动漫服务状态读取失败：${errText(e)}` });
      }
    },

    refreshLibrary: async () => {
      set({ loading: true, error: null });
      try {
        // 首次进入时服务可能还没起：先确保进程在（懒启动），再扫
        set({ status: await ipc.animeStart() });
        applySnapshot(await ipc.animeLibrary());
      } catch (e) {
        set({ loading: false, error: errText(e) });
      }
    },

    selectSubject: (id) =>
      set((s) => ({
        selectedId: id,
        // 选中条目即进详情；取消选中回追番，避免停在空白详情页
        view: id ? 'detail' : 'collection',
        selectedEpisodeId: null,
        playback: { ...s.playback, positionMs: 0, playing: false },
      })),

    /**
     * 进播放器：优先用指定集，否则用最近续看点，再否则第一集。
     * 三段落空时回详情页并给出错误 —— 不渲染一个没有片源的播放器。
     */
    openPlayer: (subjectId, episodeId = null) => {
      const { episodes } = get();
      const own = episodes.filter((e) => e.subjectId === subjectId).sort((a, b) => a.index - b.index);
      const picked =
        (episodeId ? own.find((e) => e.id === episodeId) : null) ??
        own.find((e) => e.positionMs > 0 && !e.watched) ??
        own[0];
      if (!picked) {
        set({ error: '这部番还没有可播放的剧集', view: 'detail' });
        return;
      }
      set((s) => ({
        view: 'player',
        selectedId: subjectId,
        selectedEpisodeId: picked.id,
        playback: {
          ...s.playback,
          episodeId: picked.id,
          positionMs: picked.positionMs,
          durationMs: picked.durationMs,
          playing: false,
        },
      }));
    },

    setCollection: async (id, collection: CollectionType | null) => {
      // 先改本地（列表立即反馈），再落盘
      set((s) => ({
        subjects: s.subjects.map((x) => (x.id === id ? { ...x, collection, updatedAt: Date.now() } : x)),
      }));
      try {
        await ipc.animeSetCollection(id, collection);
      } catch (e) {
        set({ error: `收藏态没存住：${errText(e)}` });
      }
    },

    markWatched: async (episodeId, watched) => {
      const target = get().episodes.find((e) => e.id === episodeId);
      if (!target) return;
      const next: AnimeEpisode = {
        ...target,
        watched,
        // 标记看完即把续看位置推到片尾：下次进来不会又从中间续
        positionMs: watched ? target.durationMs : 0,
        updatedAt: Date.now(),
      };
      set((s) => {
        const episodes = s.episodes.map((e) => (e.id === episodeId ? next : e));
        return {
          episodes,
          subjects: s.subjects.map((x) =>
            x.id === next.subjectId
              ? {
                  ...x,
                  progress: episodes.filter((e) => e.subjectId === x.id && e.watched && Number.isInteger(e.index))
                    .length,
                }
              : x,
          ),
        };
      });
      try {
        await ipc.animeSaveEpisode(next);
      } catch (e) {
        set({ error: `进度没存住：${errText(e)}` });
      }
    },

    savePosition: async (episodeId, positionMs) => {
      const target = get().episodes.find((e) => e.id === episodeId);
      if (!target) return;
      // 5 秒内最多落一次：播放器的进度事件比这密得多，逐次写盘等于拿磁盘当内存用
      const now = Date.now();
      if (Math.abs(now - target.updatedAt) < 5000) {
        set((s) => ({
          playback: { ...s.playback, positionMs },
          episodes: s.episodes.map((e) => (e.id === episodeId ? { ...e, positionMs } : e)),
        }));
        return;
      }
      const next: AnimeEpisode = { ...target, positionMs, updatedAt: now };
      set((s) => ({
        episodes: s.episodes.map((e) => (e.id === episodeId ? next : e)),
        playback: { ...s.playback, positionMs },
      }));
      try {
        await ipc.animeSaveEpisode(next);
      } catch (e) {
        set({ error: `播放位置没存住：${errText(e)}` });
      }
    },

    setPref: (key, value) => {
      const prefs = { ...get().prefs, [key]: value } as AnimePrefs;
      set({ prefs });
      savePrefs(prefs);
    },

    loadDemo: async () => {
      set({ loading: true, error: null });
      try {
        applySnapshot(await ipc.animeSeedDemo());
      } catch (e) {
        set({ loading: false, error: errText(e) });
      }
    },

    clearDemo: async () => {
      set({ loading: true, error: null });
      try {
        applySnapshot(await ipc.animeClearDemo());
      } catch (e) {
        set({ loading: false, error: errText(e) });
      }
    },

    /**
     * 数据源列表：目前**真实存在**的只有两项 —— 内置的本地目录源与本地缓存源。
     * 在线源 / BT / 媒体服务器随 M3 接入后再出现；这里不列"看得见点不动"的假源。
     */
    loadSources: async () => {
      const st = get().status ?? (await ipc.animeStatus().catch(() => null));
      const list: MediaSourceView[] = [
        {
          id: 'builtin-local',
          name: '内置源 · 本地番剧库',
          kind: 'builtin',
          url: st?.rootDir ?? undefined,
          enabled: true,
          health: st?.running ? 'ok' : 'untested',
        },
        {
          id: 'local-cache',
          name: '本地缓存',
          kind: 'local',
          enabled: true,
          health: 'untested',
        },
      ];
      set({ status: st, sources: list });
    },

    /** 缓存任务：M5（librqbit）之前没有任务，返回空数组 —— 不编造进度 */
    loadCache: async () => {
      set({ cache: [] });
    },
  };
}
