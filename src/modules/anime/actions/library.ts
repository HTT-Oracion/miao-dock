/**
 * 番剧库切片 —— 服务状态 / 扫描 / 选中 / 收藏 / 进度 / 偏好。
 *
 * 纪律：**状态先写进 store，再落盘**。落盘失败只回填 `error`，不回滚界面 ——
 * 用户刚点下的动作立刻被撤销比"稍后重试"更让人困惑；而 `error` 会显示在屏上。
 */
import * as ipc from '@anime/ipc';
import type { AnimeState, StoreGet, StoreSet } from '@anime/slice';
import type { AnimeEpisode, CollectionType } from '@anime/types';
import type { AnimePrefs } from '@anime/prefs';
import { savePrefs } from '@anime/prefs';
import { errText } from '@anime/convert';

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
  | 'fillMetadata'
  | 'setPref'
  | 'loadDemo'
  | 'clearDemo'
  | 'loadSources'
  | 'loadCache'
  | 'refreshStatus'
  | 'applyLibraryRoot'
  | 'applyProxy'
  | 'saveSource'
  | 'deleteSource'
  | 'importFolder'
  | 'playRemoteSource'
  | 'clearRemote'
  | 'loadExplore'
  | 'importCandidate'
  | 'loadDetailExtra'
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

    /**
     * 补全元数据：先按标题检索，再取第一条候选写进 manifest。
     * 不做「候选选择器」—— 多选一是 M3 的搜索屏；详情页这里只解决"一条都没有"。
     */
    fillMetadata: async (subjectId) => {
      const target = get().subjects.find((s) => s.id === subjectId);
      if (!target) return { ok: false, message: '没有这个作品' };
      try {
        // Bangumi 的 keyword 对译名不敏感：中文名搜不到时用原名再试一次
        let hit = (await ipc.animeMetadataSearch(target.title)).candidates[0] ?? null;
        if (!hit && target.titleOriginal && target.titleOriginal !== target.title) {
          hit = (await ipc.animeMetadataSearch(target.titleOriginal)).candidates[0] ?? null;
        }
        if (!hit) return { ok: false, message: `Bangumi 没搜到「${target.title}」` };
        const applied = await ipc.animeMetadataApply(subjectId, hit.bgmId);
        // 重新扫描：列表 / 详情 / 时间表都读同一份结果，避免只改一处
        await get().refreshLibrary();
        return { ok: true, message: `已补全「${applied.subject.title}」` };
      } catch (e) {
        const message = `补全失败：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
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
     * 数据源列表：真实来自服务侧（`<state>/sources.json` + 内置本地库）。
     * 在线 / RSS / 选择器 / 媒体服务器 / BT 的适配器按同一契约随后接入。
     */
    loadSources: async () => {
      try {
        const st = get().status ?? (await ipc.animeStatus().catch(() => null));
        const r = await ipc.animeSources();
        set({ status: st, sources: r.sources });
      } catch (e) {
        set({ error: `数据源读取失败：${errText(e)}` });
      }
    },

    /** 缓存任务：M5（librqbit）之前没有任务，返回空数组 —— 不编造进度 */
    loadCache: async () => {
      set({ cache: [] });
    },

    /** 切换番剧库根：写设置 → 重启动漫服务 → 重新扫描（三步缺一都不生效） */
    applyLibraryRoot: async (dir) => {
      try {
        set({ status: await ipc.animeSetLibraryRoot(dir) });
        await get().refreshLibrary();
      } catch (e) {
        set({ error: `库根没切成：${errText(e)}` });
      }
    },

    /** 切换代理：只影响番剧模块的出网请求（漫画 / 音乐不受影响） */
    applyProxy: async (mode, url) => {
      try {
        set({ status: await ipc.animeSetProxy(mode, url) });
      } catch (e) {
        set({ error: `代理没切成：${errText(e)}` });
      }
    },

    saveSource: async (source) => {
      try {
        const r = await ipc.animeSaveSource(source);
        set((s) => ({
          sources: s.sources.some((x) => x.id === r.source.id)
            ? s.sources.map((x) => (x.id === r.source.id ? r.source : x))
            : [...s.sources, r.source],
        }));
      } catch (e) {
        set({ error: `源没存住：${errText(e)}` });
      }
    },

    deleteSource: async (id) => {
      try {
        await ipc.animeDeleteSource(id);
        set((s) => ({ sources: s.sources.filter((x) => x.id !== id) }));
      } catch (e) {
        set({ error: `源没删掉：${errText(e)}` });
      }
    },

    /** 本机导入：复制进库根后重新扫描，让新片立刻出现在列表里 */
    importFolder: async (path, subject = null) => {
      const p = path.trim();
      if (!p) return { ok: false, message: '先选一个文件夹' };
      try {
        const r = await ipc.animeImportFolder(p, subject);
        await get().refreshLibrary();
        const skipped = r.skipped.length ? `，跳过 ${r.skipped.length} 个同名文件` : '';
        return { ok: true, message: `已把 ${r.copied} 个文件导入「${r.subject}」${skipped}` };
      } catch (e) {
        const message = `导入失败：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
      }
    },

    /**
     * 播媒体服务器里的一集：取带票中继地址 → 记 remote → 跳播放器。
     *
     * remote 与本地播放是**两条互不干扰的路**：本地那条由 `subjectId + episode` 驱动，
     * 这条由 `remote` 驱动；用户从库里点一部番时本地那条自动接管。
     */
    playRemoteSource: async (sourceId, item) => {
      if (!item.id) return { ok: false, message: '这一条没有条目 id，播不了' };
      try {
        const r = await ipc.animePlayRemote(sourceId, item.id);
        const src = get().sources.find((s) => s.id === sourceId);
        set({
          remote: {
            url: r.url,
            title: item.title,
            sourceId,
            sourceName: src?.name ?? sourceId,
            expiresAt: r.expiresAt,
          },
        });
        set({ view: 'player' });
        return { ok: true, message: `正在播放「${item.title}」` };
      } catch (e) {
        const message = `远程播放没起来：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
      }
    },

    clearRemote: () => {
      set({ remote: null });
    },

    /**
     * 拉探索页在线数据：新番时间表 + 热度。
     *
     * 缓存策略：一次会话内只拉一次（`force` 给「刷新」按钮）；失败**不清空**旧数据，
     * 只把原因写进 `exploreError` —— 断网时整页变空比"旧数据 + 一句错误"更糟。
     */
    loadExplore: async (force = false) => {
      const { calendar, hot, exploreLoading } = get();
      if (exploreLoading) return;
      if (!force && calendar.length > 0 && hot.length > 0) return;
      set({ exploreLoading: true, exploreError: null });
      try {
        const [cal, h] = await Promise.all([ipc.animeMetadataCalendar(), ipc.animeMetadataHot(12)]);
        set({
          calendar: cal.days ?? [],
          hot: h.candidates ?? [],
          hotSource: h.source === 'rank' ? 'rank' : 'heat',
          exploreLoading: false,
        });
      } catch (e) {
        set({ exploreError: `在线数据没拉到：${errText(e)}`, exploreLoading: false });
      }
    },

    /**
     * 把 Bangumi 候选建成一条新番剧（只有元数据、没有片源）。
     *
     * 建完立刻重扫并选中：不重扫的话列表里还是旧快照，用户会以为没成功。
     */
    importCandidate: async (bgmId) => {
      try {
        const r = await ipc.animeMetadataImport(bgmId);
        await get().refreshLibrary();
        const id = r.subject?.id ?? r.dir;
        set({ selectedId: id, view: 'detail' });
        const title = r.subject?.title ?? r.dir;
        return { ok: true, message: `已把「${title}」加入番剧库（还没有片源，放片后重新扫描即可）` };
      } catch (e) {
        const message = `加入番剧库失败：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
      }
    },
    /**
     * 详情页补充数据：角色 / 制作 / 关联，三个接口**各拉各的**。
     *
     * 用 `allSettled` 而不是 `all`：角色接口挂了不该把制作与关联一起清空 ——
     * 三个版块互相独立，失败只影响它自己，错误信息汇总成一句。
     */
    loadDetailExtra: async (bgmId) => {
      const cur = get().detailExtra;
      if (
        cur?.bgmId === bgmId &&
        (cur.loading || cur.error || cur.characters.length || cur.staff.length || cur.related.length)
      ) {
        return;
      }
      set({ detailExtra: { bgmId, characters: [], staff: [], related: [], loading: true, error: null } });
      const [c, s, r] = await Promise.allSettled([
        ipc.animeMetadataCharacters(bgmId),
        ipc.animeMetadataStaff(bgmId),
        ipc.animeMetadataRelated(bgmId),
      ]);
      const errors: string[] = [];
      if (c.status === 'rejected') errors.push(`角色：${errText(c.reason)}`);
      if (s.status === 'rejected') errors.push(`制作：${errText(s.reason)}`);
      if (r.status === 'rejected') errors.push(`关联：${errText(r.reason)}`);
      set({
        detailExtra: {
          bgmId,
          characters: c.status === 'fulfilled' ? (c.value.characters ?? []) : [],
          staff: s.status === 'fulfilled' ? (s.value.staff ?? []) : [],
          related: r.status === 'fulfilled' ? (r.value.related ?? []) : [],
          loading: false,
          error: errors.length ? errors.join('；') : null,
        },
      });
    },
  };
}
