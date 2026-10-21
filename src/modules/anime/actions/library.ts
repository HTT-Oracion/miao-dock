/**
 * 番剧库切片 —— 服务状态 / 扫描 / 选中 / 收藏 / 进度 / 偏好。
 *
 * 纪律：**状态先写进 store，再落盘**。落盘失败只回填 `error`，不回滚界面 ——
 * 用户刚点下的动作立刻被撤销比"稍后重试"更让人困惑；而 `error` 会显示在屏上。
 */
import * as ipc from '@anime/ipc';
import type { AnimeState, StoreGet, StoreSet } from '@anime/slice';
import type { AccountQueueItem, AnimeEpisode, CollectionType, SyncConflict } from '@anime/types';
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
  | 'playWebUrl'
  | 'loadExplore'
  | 'importCandidate'
  | 'loadDetailExtra'
  | 'importByRef'
  | 'applyMetadataCandidate'
  | 'clearMetaCandidates'
  | 'setSearchFilter'
  | 'resetSearchFilters'
  | 'addCache'
  | 'pauseCache'
  | 'resumeCache'
  | 'deleteCache'
  | 'loadAccount'
  | 'loginPassword'
  | 'startDevice'
  | 'pollDevice'
  | 'approveDevice'
  | 'logoutAccount'
  | 'syncNow'
  | 'resolveConflict'
  | 'loadBt'
  | 'addBt'
  | 'pauseBt'
  | 'resumeBt'
  | 'deleteBt'
  | 'playBt'
  | 'loadPikpak'
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
        // 服务起来后把「元数据来源」推过去：子进程是新的，环境变量那份只在启动时读
        void ipc.animeSetMetaProvider(get().prefs.metaProvider);
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
      await queueLocalChange(
        next,
        watched ? 'watched' : 'progress',
        { positionMs: next.positionMs, episodeIndex: next.index, subjectTitle: next.title },
        get().prefs.autoSync,
        get().account.loggedIn,
      );
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
      await queueLocalChange(
        next,
        'progress',
        { positionMs, episodeIndex: next.index, subjectTitle: next.title },
        get().prefs.autoSync,
        get().account.loggedIn,
      );
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
        const list = (await ipc.animeMetadataSearch(target.title)).candidates ?? [];
        const pool = list.length ? list : [hit];
        if (pool.length > 1) {
          // 多候选不擅自选第一条：同名 / 同系列很容易挑错，交给用户在详情页里点
          set({ metaCandidates: { dir: subjectId, list: pool } });
          return { ok: true, message: `找到 ${pool.length} 个候选，挑一个用` };
        }
        const applied = await ipc.animeMetadataApply(
          subjectId,
          hit.provider ?? 'bangumi',
          hit.externalId ?? String(hit.bgmId ?? ''),
        );
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
      // 限速是**会话级**参数：运行期立刻改（会话没起就先记下，创建时套用）
      if (key === 'btDownKbps' || key === 'btUpKbps' || key === 'btSeedRatio') {
        const limits = {
          downKbps: prefs.btDownKbps,
          upKbps: prefs.btUpKbps,
          seedRatio: prefs.btSeedRatio,
        };
        void ipc.animeSetBtLimits(limits);
        void ipc.animeStoreBtLimits(limits);
      }
      // BT 端口与 peer 过滤是**子进程**的启动参数：改完立刻推给 Rust，下次拉起 animesvc 生效
      if (key === 'btPort' || key === 'peerFilterUrl') {
        // `btPort` 是文本框（默认「随机」）：只有纯数字才当端口，其它一律「随机」
        const port = Number.parseInt(prefs.btPort.trim(), 10);
        void ipc.animeSetBtOptions({
          port: Number.isFinite(port) && port > 0 && port < 65536 ? port : null,
          peerFilterUrl: prefs.peerFilterUrl.trim() || null,
        });
      }
      // 元数据来源：**即时**推给运行中的服务（不等重启）；子进程环境同时记住，重启后仍是它
      if (key === 'metaProvider') {
        void ipc.animeSetMetaProvider(prefs.metaProvider);
      }
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

    /** 缓存任务：拉服务侧真实任务表（进度以盘上为准） */
    loadCache: async () => {
      try {
        const r = await ipc.animeCache();
        set({ cache: r.tasks });
      } catch (e) {
        set({ error: `缓存列表没拉到：${errText(e)}` });
      }
    },

    /** 新建缓存任务：目录与容量上限来自设置（改目录只影响新任务） */
    addCache: async (input) => {
      try {
        const p = get().prefs;
        await ipc.animeCacheAdd({
          ...input,
          cacheDir: p.cacheDir.trim() || undefined,
          limitGb: p.cacheLimitGb,
        });
        await get().loadCache();
        return { ok: true, message: `已加入缓存：「${input.title}」` };
      } catch (e) {
        const message = `加入缓存失败：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
      }
    },

    pauseCache: async (id) => {
      try {
        await ipc.animeCachePause(id);
      } catch (e) {
        set({ error: `暂停失败：${errText(e)}` });
      }
      await get().loadCache();
    },

    resumeCache: async (id) => {
      try {
        await ipc.animeCacheResume(id);
      } catch (e) {
        set({ error: `继续失败：${errText(e)}` });
      }
      await get().loadCache();
    },

    deleteCache: async (id) => {
      try {
        await ipc.animeCacheDelete(id);
      } catch (e) {
        set({ error: `删除失败：${errText(e)}` });
      }
      await get().loadCache();
    },

    /** BT：任务与会话状态（librqbit 真数据；没起会话时就是空表） */
    loadBt: async () => {
      try {
        const [list, stats] = await Promise.all([ipc.animeBtList(), ipc.animeBtStats()]);
        set({ btTasks: list.tasks, btStats: stats });
      } catch (e) {
        set({ error: `BT 任务没拉到：${errText(e)}` });
      }
    },

    /** BT：添加磁力（设置里关掉「允许 BT 下载」时直接拒绝，不偷偷跑） */
    addBt: async (url) => {
      if (!get().prefs.allowBt) {
        return { ok: false, message: '设置里关掉了「允许 BT 下载」，先打开再添加' };
      }
      try {
        await ipc.animeBtAdd(url.trim());
        await get().loadBt();
        return { ok: true, message: '已添加 BT 任务' };
      } catch (e) {
        return { ok: false, message: `添加 BT 失败：${errText(e)}` };
      }
    },

    pauseBt: async (id) => {
      try {
        await ipc.animeBtPause(id);
      } catch (e) {
        set({ error: `BT 暂停失败：${errText(e)}` });
      }
      await get().loadBt();
    },

    resumeBt: async (id) => {
      try {
        await ipc.animeBtResume(id);
      } catch (e) {
        set({ error: `BT 继续失败：${errText(e)}` });
      }
      await get().loadBt();
    },

    deleteBt: async (id) => {
      try {
        await ipc.animeBtDelete(id, false);
      } catch (e) {
        set({ error: `BT 删除失败：${errText(e)}` });
      }
      await get().loadBt();
    },
    /** BT 边下边播：受「边下边播」开关约束；拿不到地址就如实报错 */
    playBt: async (id, name) => {
      if (!get().prefs.btStream) {
        return { ok: false, message: '设置里关掉了「边下边播」，先打开再播' };
      }
      try {
        const r = await ipc.animeBtStreamUrl(id);
        get().playWebUrl(r.url, name, 'BT', String(id));
        return { ok: true, message: '开始播放（等字节就位）' };
      } catch (e) {
        return { ok: false, message: `BT 播放失败：${errText(e)}` };
      }
    },

    /** PikPak：只拉接口状态，界面据此显示"未接入"而不是"暂无任务" */
    loadPikpak: async () => {
      try {
        set({ pikpakStatus: await ipc.animeBtPikpak(get().prefs.pikpak) });
      } catch (e) {
        set({ error: `PikPak 状态没拉到：${errText(e)}` });
      }
    },
    /** 账号状态：登录态 + 待同步队列（队列条目来自服务侧，标签由条目自身推出来） */
    loadAccount: async () => {
      try {
        const r = await ipc.animeAccount();
        set({
          account: {
            loggedIn: r.loggedIn,
            username: r.user?.name,
            email: r.user?.email,
            cloudCount: r.cloudCount,
            lastSyncAt: r.lastSyncAt,
          },
          syncQueue: r.queue.map((q) => ({ id: q.id, label: queueLabel(q), state: 'queued' as const })),
        });
      } catch (e) {
        set({ error: `账号状态没拉到：${errText(e)}` });
      }
    },

    loginPassword: async (email, password) => {
      try {
        await ipc.animeAccountLogin(email, password);
        await get().loadAccount();
        return { ok: true, message: '已登录' };
      } catch (e) {
        return { ok: false, message: `登录失败：${errText(e)}` };
      }
    },

    startDevice: async (kind) => {
      try {
        const r = await ipc.animeAccountDeviceStart(kind);
        return { deviceCode: r.deviceCode, userCode: r.userCode, interval: r.interval };
      } catch (e) {
        set({ error: `设备码获取失败：${errText(e)}` });
        return null;
      }
    },

    pollDevice: async (code) => {
      try {
        const r = await ipc.animeAccountDevicePoll(code);
        if (r.status === 'ok') await get().loadAccount();
        return r.status;
      } catch (e) {
        set({ error: `轮询失败：${errText(e)}` });
        return 'pending';
      }
    },

    approveDevice: async (code) => {
      try {
        await ipc.animeAccountDeviceApprove(code);
      } catch (e) {
        set({ error: `确认失败：${errText(e)}` });
      }
    },

    logoutAccount: async () => {
      try {
        await ipc.animeAccountLogout();
      } catch (e) {
        set({ error: `退出失败：${errText(e)}` });
      }
      set({ account: { loggedIn: false }, syncQueue: [], conflicts: [] });
    },

    /** 手动挑边：解决一条冲突后重新同步一次（列表与队列都刷新） */
    resolveConflict: async (id, side) => {
      try {
        await ipc.animeResolveConflict(id, side);
        const r = await get().syncNow();
        return { ok: true, message: r.message };
      } catch (e) {
        return { ok: false, message: `处理冲突失败：${errText(e)}` };
      }
    },
    /** 同步一次：策略来自设置；冲突回填给合并面板 */
    syncNow: async () => {
      try {
        const r = await ipc.animeAccountSync(get().prefs.conflictPolicy);
        set({ conflicts: r.conflicts.map(toConflict) });
        await get().loadAccount();
        return {
          ok: true,
          message: `推送 ${r.pushed} 条 · 云端 ${r.cloudCount} 条 · 冲突 ${r.conflicts.length} 条`,
          conflicts: r.conflicts.length,
        };
      } catch (e) {
        return { ok: false, message: `同步失败：${errText(e)}`, conflicts: 0 };
      }
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
     * 在线源解析出的直链：交给 WebView 轨（不经过中继，防盗链站点会失败并如实报错）。
     *
     * `cookie`：个别站点（如 anime1）**要求带 Cookie 才放行**片址。
     * 播放器是 `<video src>`，浏览器不会替我们发这个头 ⇒ 只能由本机服务侧中继时补。
     * 所以这里带上它，交给 `anime_play_remote` 那条带票中继（见 `playWebUrlCookie`）。
     */
    playWebUrl: (url, title, sourceName, sourceId, cookie?: string | null) => {
      set({
        remote: { url, title, sourceId, sourceName, expiresAt: Date.now() + 2 * 3600_000, cookie: cookie ?? null },
        view: 'player',
      });
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
    importCandidate: async (provider, externalId) => {
      try {
        const r = await ipc.animeMetadataImport(provider, externalId);
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

    /** 粘贴 Bangumi 链接 / 手输编号 → 建库（服务侧解析，认不出会明说） */
    importByRef: async (input) => {
      try {
        const r = await ipc.animeMetadataImportRef(input);
        await get().refreshLibrary();
        const id = r.subject?.id ?? r.dir;
        set({ selectedId: id, view: 'detail', query: '', metaCandidates: null });
        const title = r.subject?.title ?? r.dir;
        return { ok: true, message: `已把「${title}」加入番剧库` };
      } catch (e) {
        const message = `加入番剧库失败：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
      }
    },

    /** 改一个筛选条（年份 / 季度 / 标签 / 排序 / 布局） */
    setSearchFilter: (key, value) => {
      set((s) => ({ searchFilters: { ...s.searchFilters, [key]: value } }));
    },

    /** 清空筛选条（布局不重置：那是个人偏好，不该被「清筛选」顺手改掉） */
    resetSearchFilters: () => {
      set((s) => ({ searchFilters: { ...s.searchFilters, year: null, quarter: null, tag: null, sort: 'match' } }));
    },

    /** 收起候选面板 */
    clearMetaCandidates: () => {
      set({ metaCandidates: null });
    },

    /** 从候选里挑一个：按它的 bgmId 补全，然后清空候选面板 */
    applyMetadataCandidate: async (dir, provider, externalId) => {
      try {
        const applied = await ipc.animeMetadataApply(dir, provider, externalId);
        await get().refreshLibrary();
        set({ metaCandidates: null });
        return { ok: true, message: `已补全「${applied.subject.title}」` };
      } catch (e) {
        const message = `补全失败：${errText(e)}`;
        set({ error: message });
        return { ok: false, message };
      }
    },
  };
}

/** 队列条目的人话标签（由条目自身推出，不额外存一份） */
function queueLabel(q: AccountQueueItem): string {
  const where = q.payload.subjectTitle ? String(q.payload.subjectTitle) : q.key;
  const ep = q.payload.episodeIndex != null ? ` 第 ${String(q.payload.episodeIndex)} 话` : '';
  if (q.kind === 'watched') return `${where}${ep} 标记为看完`;
  if (q.kind === 'collection') return `${where} 收藏变更`;
  return `${where}${ep} 进度`;
}

/** 服务侧冲突 → 界面用的双侧对比 */
function toConflict(c: {
  id: string;
  key: string;
  local: AccountQueueItem | null;
  cloud: AccountQueueItem;
}): SyncConflict {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
  return {
    id: c.id,
    subjectTitle: String(c.cloud.payload.subjectTitle ?? c.key),
    episodeIndex: num(c.cloud.payload.episodeIndex),
    localMs: num(c.local?.payload.positionMs),
    cloudMs: num(c.cloud.payload.positionMs),
    localAt: c.local?.updatedAt ?? 0,
    cloudAt: c.cloud.updatedAt,
  };
}

/** 本地改动入队：只在「已登录 + 开着自动同步」时入队（关掉就只手动推） */
async function queueLocalChange(
  ep: AnimeEpisode,
  kind: 'progress' | 'watched',
  payload: Record<string, unknown>,
  autoSync: boolean,
  loggedIn: boolean,
): Promise<void> {
  if (!autoSync || !loggedIn) return;
  try {
    await ipc.animeAccountEnqueue({
      id: `${kind}:${ep.id}`,
      kind,
      key: ep.id,
      updatedAt: Date.now(),
      payload,
    });
  } catch {
    // 入队失败不影响本地：下次同步会重新入队
  }
}
