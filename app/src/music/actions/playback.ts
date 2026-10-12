// 播放切片 —— 「播放」段（D-156 从 store.ts 按 action 段切出）。
//
// 与它同批搬来的模块级件（**全部只被播放段使用**，故随段走）：
//   · 无版权自动跳过控制（unplayableSkipCount / isAutoSkipping / playSeq）
//   · 播放地址解析与音频缓存（audioCacheId / lookupAudioCache / prefetchAudioCache /
//     resolveOnlineUrl / resolvePlayUrl）
//   · audio 元素登记（audioEl / registerAudioElement）—— MusicKernel 从这里导入
//   · seek 推送去抖（SEEK_PUSH_DEBOUNCE_MS / seekPushTimer）
import * as ipc from '@music/ipc';
import * as platform from '@music/platform';
import { convertFileSrc } from '@tauri-apps/api/core';
import { DL_BASE_COLOR_DEF, DL_HIGHLIGHT_COLOR_DEF, DL_LINE_COUNT, DL_LYRICS_SIZE } from '@music/player-options';
import { songKey } from '@music/convert';
import { MAX_PLAY_QUEUE } from '@music/slice';
import { savePrefs } from '@music/prefs';
import type { PlayMode, Song, MusicProvider } from '@music/types';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

// ------------------------------------------------------------------ 无版权自动跳过控制

let unplayableSkipCount = 0;
let isAutoSkipping = false;
/** 每次 playSong 递增，用于忽略飞行中的旧请求（切歌竞态） */
let playSeq = 0;

/**
 * 心动模式一次请求多少首相似歌。
 *
 * ⚠️ 这个数字**只影响回落路径的实际条数** —— 上游是两条（2026-10-12 实测）：
 *   ① `playmode/intelligence/list`（智能播放，主路）：单次固定 ~149 条，
 *      **完全忽略 `limit`**；且必须登录、`pid` 只能是「我喜欢的音乐」；
 *   ② `simiSong`（回落）：单次**硬顶 5 条**，`limit` 传 5 / 20 / 50 / 100
 *      都一样，`offset` 翻页也无效（0 / 5 / 10 / 20 拿回同一批 5 首）。
 *
 * 所以别指望调大它拿到更长队列 —— 主路给多少由上游定（149），
 * 回落能给多少由上游封顶（5）。这里保留 20 不动（回落路径的行为不变）。
 * 连带影响（要心里有数）：主路心动队列 = [当前歌, ...~149]，
 * 回落路径 = [当前歌, ...≤5] 最多 6 条，播到尾就得再换一批。
 */
const HEARTBEAT_FETCH = 20;

/**
 * 心动模式可用吗？—— **唯一的判据出口**。
 *
 * 两个条件同时成立才可用：
 *   ① 播放源是网易云（其它平台没有"按 songid 找相似"的接口，需求也明确"其它平台不处理"）；
 *   ② 当前队列来自「我喜欢的音乐」（需求原文：只在该歌单上下文有效）。
 *
 * 为什么收成一个函数而不是散在 cycleMode / next / UI 各判一次：
 * 这三处只要有一处判得不一样，就会出现"按钮上是心动、实际按随机播"这种
 * 自相矛盾的状态 —— 而它不报错，只表现为行为怪异。判据必须只有一个来源。
 */
export function canUseHeartbeat(state: {
  playbackSource: MusicProvider;
  queueFromLiked: boolean;
}): boolean {
  // 平台能力走 platform.supportsSimilar（唯一事实源），**不在这里硬编码 'netease'** ——
  // 两处各写一份平台名单，日后新增支持相似的平台时会漏改一处，
  // 表现为"接口有了、门禁仍拦着"（或反过来）。
  return platform.supportsSimilar(state.playbackSource) && state.queueFromLiked;
}

/**
 * 一首歌在**音频缓存**里的稳定主键（逐平台）。
 *
 * ⚠️ 必须与 `platform.songUrl` / `platform.lyric` 取 id 的口径对齐，
 * 否则会出现「按A 的 key 存了 B 的歌」这种错位 —— 症状是**别的歌的音频**，
 * 且全程不报错。
 *
 * ## 为什么用 `||` 而不是 `??`
 *
 * `kugou.rs` 会把空 hash 序列化成 `Some("")`（不是 `None`），
 * 而 `??` 只对 `null` / `undefined` 回落 ⇒ 空串会原样传下去。
 * 于是所有空 hash 的酷狗歌会共用同一个 key，表现为「A 歌的音频出现在 B 歌上」。
 * `||` 对空串也回落，比 `??` 严格更安全。QQ 的 `mid` 同理。
 */
function audioCacheId(provider: MusicProvider, song: Song): string {
  switch (provider) {
    case 'kugou':
      return song.hash || song.id;
    case 'qqmusic':
      return song.mid || song.id;
    // 咪咕的 `Song.id` 存的是 copyrightId（主键）；`content_id` 只是
    // `listen_url` 的另一个必填查询参数，**别把它当主键**。
    default:
      return song.id;
  }
}

/**
 * 查整首音频缓存，命中返回**可直接播放的 asset URL**，未命中返回 `null`。
 *
 * ## ⚠️ 为什么不直接把结果交给上层而不在这里转 `convertFileSrc`
 *
 * 命中返回的是**绝对路径**，而 `<audio>` 在 Tauri 下不能直接吃 `file://`
 * （被跨源策略挡），必须经 `convertFileSrc` 转 `asset://` ——
 * 与本地歌曲（`resolvePlayUrl` 对 `song._localPath` 的处理）完全同一条路。
 * 转换放在这里，是为了让本函数的契约是「返回能播的 URL」而不是「返回路径」，
 * 调用方不必知道缓存命中拿到的是什么东西。
 *
 * ## 为什么吞掉异常
 *
 * 缓存是**优化**。查缓存失败（命令未注册 / 缓存目录不可读）时，
 * 正确反应是「当它不存在」—— 走原来的代理路径在线播。
 * 一旦让异常冒泡，`playSong` 会把它当成"解析播放地址失败"，
 * 弹「播放失败」并**自动跳下一首** —— 症状是"缓存坏了就放不出歌"，
 * 而缓存本该是可有可无的。
 */
async function lookupAudioCache(
  song: Song,
  provider: MusicProvider,
  quality: string,
): Promise<string | null> {
  /**
   * 本地歌曲**不入缓存链**。
   *
   * 两个理由：① 它走 `asset://` 直接播，文件本就在本地，再问一遍缓存是多余的系统调用；
   * ② 它是用户自己导入的文件，计入「音乐缓存」统计会让设置页的占用数字失真
   * （用户会看到"缓存占了 1.2GB"，其实全是自己的歌）。
   *
   * 这道闸放在**缓存链的入口**而不是调用点：将来多一个调用方也不会漏掉。
   */
  if (song._localPath) return null;
  try {
    const hit = await ipc.musicAudioCached(provider, audioCacheId(provider, song), quality);
    return hit ? convertFileSrc(hit) : null;
  } catch {
    // 见上方注释：查不到就当没缓存，绝不影响播放
    return null;
  }
}

/**
 * 后台整首下载落盘。**绝不阻塞播放，也绝不打断播放。**
 *
 * 调用点必须放在「播放地址已经拿到」之后（它需要源站真实 URL），
 * 且以 `void` 发出、不 `await`。
 *
 * ## 为什么失败可以完全静默
 *
 * 下载失败对用户而言**与「没缓存」完全等价** —— 歌已经在放了，缓存只是让它下次更快。
 * 所以这里既不弹提示也不重试：任何"下载缓存失败"的打扰都是净损失。
 * 静默放弃的是**这一次**缓存机会，不是播放。
 */
function prefetchAudioCache(
  song: Song,
  provider: MusicProvider,
  quality: string,
  url: string,
): void {
  if (song._localPath) return;
  // `void` 明确表达"发出即弃"，`.catch` 保证拒绝不会变成未处理的 Promise
  void ipc.musicCacheDownload(provider, audioCacheId(provider, song), quality, url).catch(() => {});
}

/** 按平台解析在线播放地址（本地音频缓存 → song_url → 音频代理） */
async function resolveOnlineUrl(song: Song, set: StoreSet, get: StoreGet): Promise<string> {
  const state = get();
  const provider = song.provider as MusicProvider;
  /**
   * ⚠️ 缓存 key 里的 quality **只能是这个值**（5 值枚举的请求档位），
   * 绝不能是 `r.quality` / `r.level` —— 四平台那两个字段值域互不相同
   * （网易云是中文 label、QQ 是英文 label、咪咕是 `PQ`/`SQ`/`ZQ`），
   * 拿它们当 key 会让同一首歌每次 key 都不同 ⇒ **缓存永不命中且不报错**。
   *
   * 它也天然**非空**（`PlaybackQuality` 是不含空串的联合类型，
   * 水合处有 `?? 'hires'` 兜底）。Rust 侧对空档位判为"无法寻址"直接不下缓存，
   * 那里也**刻意没有**默认成 `standard` —— 宁可无缓存，也不能让用户
   * 以为听到了自己选的高音质。
   */
  const quality = state.playbackQuality;

  // 先查缓存：命中就直接播本地文件，**不再回源**（省掉一次取流地址的网络往返）
  const cached = await lookupAudioCache(song, provider, quality);
  if (cached) {
    /**
     * 命中时拿不到"实际码率"（没调 `songUrl`），所以 `currentBitrate` 置 0 ——
     * UI 侧只在 `> 0` 时显示码率（`PlayerBar`），置 0 等于"不谎报"。
     * ⚠️ 不能留着上一首的值：那样播放条会显示**上一首**的码率。
     * `currentQuality` 填请求档位是诚实的 —— 这个文件本就是按该档位的 key 存的
     *（源站当时是否降级无从得知，不谎报具体码率）。
     */
    set({ currentQuality: quality, currentBitrate: 0 });
    return cached;
  }

  const r = await platform.songUrl(provider, song, quality);
  if (!r?.url) return '';
  let port = state.proxyPort;
  if (!port) {
    port = await ipc.getProxyPort();
    set({ proxyPort: port });
  }
  // 回写「实际拿到的音质与码率」。
  // 这两个字段在 store 里定义了却**一直没有被赋值**（播放条上那个音质标签因此从来不显示）
  // —— 档位是**要的**、这两个是**真拿到的**，平台降级时两者不一致；
  // 只显示档位等于把降级藏了起来。
  // `br` 单位是 bps（网易云/QQ 原样透传；咪咕恒为 0），故 UI 侧只在 >0 时显示。
  set({
    currentQuality: r.quality || r.level || '',
    currentBitrate: r.br || 0,
  });
  // 播放地址已就绪 → 这时才后台预热。`void` 不阻塞，且失败不打断播放。
  prefetchAudioCache(song, provider, quality, r.url);
  return `http://127.0.0.1:${port}/audio?url=${encodeURIComponent(r.url)}`;
}

/** 统一解析一首歌的可播放 URL（本地 asset 协议 / 在线音频代理） */
async function resolvePlayUrl(song: Song, set: StoreSet, get: StoreGet): Promise<string> {
  if (song._localPath) return convertFileSrc(song._localPath);
  return resolveOnlineUrl(song, set, get);
}

// ------------------------------------------------------------------ store

/**
 * 播放内核登记进来的 <audio> 元素。
 *
 * **刻意不放进 zustand state**：它是 DOM 引用、不是可渲染数据，放进 state 只会让
 * 每次登记都惊动所有订阅者。它唯一的作用是让 `seek` 能在**同一处**同时改
 * 「store.progressMs」与「audio.currentTime」—— 这两件事分开做必然被漏掉一件。
 *
 * 为什么需要这条通道：`<audio>` 住在组件里（`components/MusicKernel.tsx`，挂应用根常驻），
 * 而 seek 是 store action。没有它，就得把 audio 的 ref 一路当 prop 传进每个进度条。
 */
let audioEl: HTMLAudioElement | null = null;

/** 播放内核在挂载 / 卸载时登记与注销 audio 元素 */
export function registerAudioElement(el: HTMLAudioElement | null): void {
  audioEl = el;
}

/**
 * 拖动进度条后、真正推给歌词窗之前的去抖定时器。
 *
 * 为什么需要：展开播放器的进度条 `onChange` 直连 `seek`，拖动时每秒几十次；
 * 不去抖就等于把 `setProgress` 那种频率从另一个入口灌进事件通道。
 * 120ms 是"手还在动就别推、停下来就推一次"的取舍 —— 短到察觉不出延迟，
 * 长到足以把一次拖动的几十次调用压成一次。
 */
const SEEK_PUSH_DEBOUNCE_MS = 120;
let seekPushTimer: ReturnType<typeof setTimeout> | null = null;

export const createPlaybackSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'playSong' | 'playQueue' | 'playPlaylist' | 'enterHeartbeat' | 'togglePlay' | 'next' | 'handleTrackEnded' | 'prev' | 'seek' | 'setVolume' | 'toggleMute' | 'stepVolume' | 'closePlayback' | 'cycleMode' | 'setPlayMode' | 'setPlaybackQuality' | 'clearResumeAt' | 'setLyricsFontSize' | 'setLyricsHighlightColor' | 'setLyricsMode' | 'setDesktopLyricsFontSize' | 'setDesktopLyricsHighlightColor' | 'setDesktopLyricsBaseColor' | 'setDesktopLyricsLineCount' | 'resetDesktopLyricsPrefs' | 'setDynamicEnabled' | 'setDiscMode' | 'setVinylColorMode' | 'setVinylCustomColor' | 'setIslandView' | 'setProgress' | 'setDuration'> => ({
  playSong: async (song, queue, opts) => {
    const mySeq = ++playSeq;

    // 队列与位置
    if (queue) {
      const idx = queue.findIndex((s) => songKey(s) === songKey(song));
      set({ queue, currentIndex: idx >= 0 ? idx : 0 });
    } else {
      /**
       * 没给队列 → 在**现有队列**里移动指针。
       *
       * ⚠️ 找不到时**不能什么都不做**（这里曾是一个真实缺陷）：
       * 从「播放历史」点一首不在当前队列里的歌，`findIndex` 返回 -1，
       * 于是队列与 currentIndex 都不动 —— 结果 `currentSong` 是这首歌、
       * 而 `queue[currentIndex]` 指向**另一首**：点「下一首」从错误位置往后走，
       * 队列抽屉高亮的也不是正在播的那首。**自相矛盾的状态，且不报错。**
       * 对齐网易云的做法：把这首歌**接进队列**。
       */
      const idx = get().queue.findIndex((s) => songKey(s) === songKey(song));
      if (idx >= 0) {
        set({ currentIndex: idx });
      } else {
        // 队列满（2000 首，极少见）时退化成"以这首歌开一个新队列"，
        // 而不是静默丢弃 —— 用户点了播放却什么都没发生是最难解释的行为。
        const cur = get().queue;
        const next = cur.length >= MAX_PLAY_QUEUE ? [song] : [...cur, song];
        set({ queue: next, currentIndex: next.length - 1 });
      }
    }

    if (!isAutoSkipping) unplayableSkipCount = 0;

    // 恢复态：进度**先显示**到快照里的位置。
    // 为什么 display 值要先给：真实 seek 要等 loadedmetadata（见 MusicKernel），
    // 两者之间有几百毫秒到几秒；这段时间播放条若停在 0:00，定位完成后会"跳一下"，
    // 看起来就像 bug（评估稿 §1.4 记的正是这个）。先给目标值，跳动就发生在
    // 同一个组件的同一次渲染里，肉眼几乎看不出。
    const startAt = Math.max(0, opts?.resumeAtMs ?? 0);
    set({
      currentSong: song,
      progressMs: startAt,
      durationMs: song.duration || 0,
      isPlaying: false,
      // 「详情」= 展开播放器（《09》§5.6 第 3 项）。用户主动点一首歌就展开它；
      // **自动续播/切歌不展开**（否则听歌时会被不断弹开）—— 由 next/prev 传 expand:false 表达。
      // 默认展开，因为调用点绝大多数是"用户点了某一首"。
      ...(opts?.expand === false ? {} : { expanded: true }),
    });
    // 把 seek 意图交给播放内核：它在 loadedmetadata 之后才真正设 currentTime。
    // 必须在换歌前清掉旧的 resumeAtMs，否则上一首残留的位置会作用到这一首。
    if (startAt > 0) set({ resumeAtMs: startAt });
    else if (get().resumeAtMs !== 0) set({ resumeAtMs: 0 });
    // 歌词与 URL 获取并行（不阻塞播放）
    void get().loadLyrics(song);
    // 换歌即刻推一次（此刻歌词多半还没到，歌词窗会先显示歌名/纯音乐提示，
    // 歌词解析完后再由 loadLyrics 补推一次）。不推的话换歌后桌面会停留在上一首。
    void get().pushLyricsState();

    let url = '';
    try {
      url = await resolvePlayUrl(song, set, get);
    } catch (e) {
      if (mySeq !== playSeq) return;
      // ⚠️ 这里的 `restoring: false` 不是顺手写的：解析抛错是**唯一一条
      // playUrl 永远不会被设置**的失败路径 ⇒ 不会有 loadedmetadata 来关恢复态的闸。
      // 闸漏在这里的后果：用户之后正常播放遇到一次网络失败，也会静默遍历整个队列
      // 并清空播放条（一次抖动把队列丢光）。
      set({ isPlaying: false, restoring: false });
      get().toast(`播放失败：${String(e)}`);
      return;
    }
    if (mySeq !== playSeq) return;

    if (!url) {
      // 无版权 / 需会员：提示后自动跳下一首
      //
      // ⚠️ **两条路的跳数上限不同，这是刻意的**：
      //   · 平时（用户自己点的歌）：上限 10 首。整队列全不可播时停下来，
      //     免得一路跳下去让界面疯转 —— 平时用户在场，看得见发生了什么。
      //   · 恢复态（Q4 拍板）：上限 = 队列长度，**遍历到有一首能播的为止**。
      //     恢复时用户什么都还没做，队列里混着被移走的本地文件 / 已下架的专辑
      //     是常态；停在"全都不行"等于恢复失败（播放条空着、用户一脸茫然）。
      //     全部失败才落到 clearQueue（见 handleRestoreFailed）。
      const restoring = get().restoring;
      const skipLimit = restoring ? Math.max(1, get().queue.length) : 10;
      set({ isPlaying: false });
      if (unplayableSkipCount < skipLimit) {
        unplayableSkipCount += 1;
        isAutoSkipping = true;
        // 恢复态**不弹提示**：用户还没做任何操作，一串"该歌曲无版权"是纯噪音
        if (!restoring) get().toast('该歌曲无版权或需会员，已自动跳过');
        setTimeout(() => {
          if (get().queue.length > 1) {
            get().next();
          } else if (get().restoring) {
            /**
             * 队列只有一首歌，而它恰好也失败 —— 没有"下一首"可跳，恢复到此为止。
             * 不清的话 `restoring` 会一直开着（下面那个 else 分支只在"跳够次数"时才到），
             * 于是用户之后正常播放遇到一次失败也会遍历整个队列并清空。
             * 在回调里**重新读** restoring 而不是用闭包里那份：800ms 里用户可能
             * 已经点了别的歌（那时不该由这一条定时器去清他的队列）。
             */
            get().clearQueue();
            set({ restoring: false });
          }
        }, 800);
      } else {
        isAutoSkipping = false;
        unplayableSkipCount = 0;
        // 恢复态走到这里 = 整个队列都试过了（Q4）→ 清空，播放条随之隐藏
        if (restoring) {
          get().clearQueue();
          return;
        }
        get().toast('当前队列中多首歌曲无法播放，已停止自动切换');
      }
      return;
    }

    isAutoSkipping = false;
    // autoplay:false（恢复）→ 停在暂停态，但**地址照样挂上**：
    // 播放条要显示歌曲信息、进度条要显示定位后的位置，而音频元素必须真的
    // 加载到那首歌（否则 onError 永远不会触发，Q4 的"失败切下一首"无从判断）。
    set({ playUrl: url, isPlaying: opts?.autoplay !== false });
    // 「取到地址、真正开始播」是第二次状态跳变（上面那次推的时候还没在播）。
    // 不推的话桌面歌词会停在那首歌的暂停态，直到用户手动暂停/播放一次才恢复。
    void get().pushLyricsState();
    get().recordPlayHistory(song, opts?.fromHistory);
    // 切歌后立刻存快照：此刻进度是 0，但「换了哪首、队列长什么样」必须立刻落盘
    get().persistSnapshot();
  },

  playQueue: async (songs, startIndex, opts) => {
    const song = songs[startIndex];
    if (!song) return;
    /*
     * 入队即刷新两个上下文标记，**不留旧值**。
     *
     * 为什么在这里做而不是让各调用方各自 set：搜索/本地/历史/歌单等入口全都经过本函数，
     * 在唯一收口处写一次，就不可能漏。默认均为假 —— 只有 `playPlaylist` 明确传
     * `fromLiked` 才置真。若把"置真"留给调用方而"置假"没人做，
     * 用户播过一次我喜欢的音乐之后，播任何东西都会被判成"仍在喜欢上下文"，
     * 心动模式会在一堆无关队列上出现 —— 这正是必须在收口处复位的原因。
     */
    set({
      queueFromLiked: opts?.fromLiked === true,
      heartbeatSeeded: false,
      // 播了新歌单/新列表 ⇒ 之前那份"心动前的快照"已经过期，留着会在切模式时
      // 把一个无关的旧队列恢复出来（用户会看到列表突然变回早先某个歌单）
      heartbeatRestore: null,
    });
    await get().playSong(song, songs, opts);
  },

  playPlaylist: async (songs, opts) => {
    if (songs.length === 0) return;
    const liked = opts?.playlist?.isLiked === true;

    /*
     * 离开心动模式：切歌单/换来源时若当前是心动模式 → 先切成顺序播放（需求第 4 条）。
     *
     * 顺序是先改模式、再定起始下标：这样"随机播放挑一首"的判据读到的是**改后**的模式，
     * 否则"从心动切来 + 恰好是随机档"会走随机，与"直接切换到顺序播放"的要求相抵。
     */
    if (get().playMode === 'heartbeat') {
      set({ playMode: 'order' });
      savePrefs({ playMode: 'order' });
    }

    /*
     * 起始下标：**用户点了具体某一首**（`opts.index`）就用它；否则是"播放全部"，
     * 按需求第 2 条 —— 列表循环 / 单曲循环 / 顺序播放从第一首起，随机播放随机挑一首。
     *
     * 为什么两者必须分开：点行是"我就要听这首"的精确意图，任何模式都不该改写它。
     * 而"播放全部"没有指定曲目，才由模式决定从哪儿开始。
     * 单曲循环也从第一首起 —— 那个档位管的是"播完重播同一首"，
     * 与"从哪一首开始"无关，不该让它影响入口。
     */
    const startIndex =
      opts?.index != null
        ? opts.index
        : get().playMode === 'shuffle'
          ? Math.floor(Math.random() * songs.length)
          : 0;
    if (!songs[startIndex]) return;

    await get().playQueue(songs, startIndex, {
      fromLiked: liked,
      // 历史点播要原样带过去：它是"不要因为播放而重排历史列表"的唯一依据
      fromHistory: opts?.fromHistory,
    });

    /*
     * 进入「我喜欢的音乐」：它**自己**记着有没有开启过心动模式（需求第 4 条）——
     * 开启过就自动切到心动模式并开始播放；没开启过就沿用前一个歌单的播放模式（什么都不做）。
     *
     * ⚠️ 放在 playQueue 之后：心动模式要拿"当前播放歌曲"当种子去找相似歌，
     * 而调用本函数之前 currentSong 还是上一首。顺序反了会拿着旧歌去找相似。
     */
    if (liked && get().likedHeartbeatOn) {
      get().setPlayMode('heartbeat');
    }
  },

  enterHeartbeat: async (opts) => {
    const seed = get().currentSong;
    if (!seed) return;
    if (!canUseHeartbeat(get())) return;

    /*
     * 抓种子歌的相似列表。`get().playbackSource` 逐次现取而不是提前缓存：
     * 等待网络期间用户可能切了平台，用旧平台去解析新歌 id 会拿到驴唇不对马嘴的结果。
     */
    let similar: Song[] = [];
    try {
      similar = await platform.similarSongs(get().playbackSource, seed.id, HEARTBEAT_FETCH);
    } catch (e) {
      get().toast(`找相似歌曲失败：${String(e)}`);
      // 失败时**不动队列**：把用户正在听的歌单换掉、结果又没换成，
      // 是比"没切成功"更糟的结果 —— 他会失去原本的队列却什么也没得到。
      return;
    }
    /*
     * 排除种子自身：接口常把它自己也算进"相似"里，留着会在队列里出现两遍。
     * 同时按 songKey 去重：智能播放一次回 ~149 条，实测存在少量重复项，
     * 不去重会让队列里出现同一首歌的多行（用户看着像 Bug）。
     */
    const seen = new Set<string>([songKey(seed)]);
    const pick: Song[] = [];
    for (const s of similar) {
      const k = songKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      pick.push(s);
    }
    if (pick.length === 0) {
      get().toast('没有找到相似歌曲，已保持当前队列');
      return;
    }

    const already = get().heartbeatSeeded;
    /*
     * 队列 = 心动列表本身。两种情形的差别**只在于从哪里开始播**：
     *   ① 首次进入：队列整个换成心动列表，**从它的第一首开始播** ——
     *      即接口返回的第一首，不是"进来之前在听的那首"。
     *      种子歌不进队列：它是"为什么换这批"的因由，不是这批歌的一员；
     *      留在队首会让播放列表第一行永远显示一首没在播的歌。
     *   ② 再次进入：当前歌原样继续播，把它放到队首、其余换成新的心动列表。
     * 两种都保住 currentIndex 与 currentSong 对得上（抽屉里必有一行是正在播的那首）。
     */
    const nextQueue = already ? [seed, ...pick] : pick;

    /*
     * 首次进入前**先存一份原队列快照**，供"切离心动模式时恢复原播放列表"用。
     * ⚠️ 只在首次进入时存：再次进入时 get().queue 已经是上一次的心动列表，
     * 覆盖快照会把"相似歌"当成原列表存下来 —— 那恢复出来的还是相似歌，等于没恢复。
     */
    if (!already) {
      const snapQueue = get().queue;
      set({
        heartbeatRestore: {
          queue: snapQueue.length > 0 ? snapQueue : [seed],
          index: Math.max(0, get().currentIndex),
          queueFromLiked: get().queueFromLiked,
        },
      });
    }

    if (opts?.advance) {
      /*
       * 走到队尾时的续播（`next` 在最后一首时调）：换一批新的相似歌，
       * 从**新的第一首**接着播。
       * 这条路径**必须自己前进** —— 它是"播完了往下走"，不是"切模式"，
       * 沿用"保留当前歌"的语义会让播完的歌原地重播。
       * ⚠️ 首次进入时队列里没有种子（`nextQueue = pick`），此时下标 0 才是新列表第一首；
       * 再次进入时种子在队首，要跳过它 —— 否则续播又回到刚播完的那首。
       */
      const startAt = already ? 1 : 0;
      await get().playSong(nextQueue[startAt] ?? nextQueue[0], nextQueue, { expand: false });
      set({ queueFromLiked: true, heartbeatSeeded: true });
      return;
    }

    if (already) {
      // 只换队列，不碰 audio / 进度 / isPlaying —— "继续播放当前歌曲"
      set({ queue: nextQueue, currentIndex: 0, queueFromLiked: true, heartbeatSeeded: true });
      return;
    }

    // 首次进入：从**心动列表的第一首**开始播（不是进来前在听的那首）。
    // autoplay 打开、不展开播放器（与自动续播同款口径）
    await get().playSong(nextQueue[0], nextQueue, { autoplay: true, expand: false });
    set({ queueFromLiked: true, heartbeatSeeded: true });
  },

  // 播放/暂停切换必须推：歌词窗收到 playing=false 才会真的停住走表，
  // 否则暂停期间歌词会继续往前爬（这是最容易被当成"歌词乱跳"的故障）。
  togglePlay: () => {
    set((s) => ({ isPlaying: !s.isPlaying }));
    void get().pushLyricsState();
    // **暂停时**存快照 —— 这是"听完暂停、第二天再打开"这个主场景的落盘点。
    // （继续播放时不存：进度每秒都在变，交给 MusicKernel 的低频定时器。）
    if (!get().isPlaying) get().persistSnapshot();
  },

  next: () => {
    const { queue, currentIndex, playMode } = get();
    if (queue.length === 0) return;

    /*
     * 心动模式：换一批相似歌接着听。
     *
     * ⚠️ 这里**不再有"平台不支持就降级成随机"**的分支（旧行为的遗留）。
     * 新口径下心动模式是**有条件才可选**的档位（见 canUseHeartbeat）：
     * 不可用时 `cycleMode` 根本切不进来，队列换成别的歌单时 `playPlaylist` 也会先切回顺序播放。
     * 所以"走到这里但不可用"只剩一种边角情形（例如平台在被切换的瞬间），
     * 那时**按顺序往下走**而不是随机 —— 需求明确"其它平台不处理"，
     * 随机听起来像心动、实则毫无相关性，比老老实实顺序播更糟。
     */
    if (playMode === 'heartbeat') {
      if (canUseHeartbeat(get())) {
        /*
         * 队列里**还有下一首** → 就正常往后走。
         *
         * ⚠️ 这一步不能省（本轮真实缺陷）：早先这里无条件调 enterHeartbeat()，
         * 而 enterHeartbeat 的"再次进入"路径是**保留当前歌**（那是给切模式用的语义），
         * 于是自然播完时它不会前进 —— 刚放完的歌会被原地重播，整个心动模式卡死在第一首。
         * 自动续播要的是"往下走"，只有走到队尾才需要换一批。
         */
        if (currentIndex + 1 < queue.length) {
          return void get().playSong(queue[currentIndex + 1], undefined, { expand: false });
        }
        // 走到队尾 → 以当前歌为种子换一批（新的第一首接在后面），从它开始播
        return void get().enterHeartbeat({ advance: true });
      }
      // 落到下面的顺序分支（不回卷到开头，见 order 的处理）
    }

    if (playMode === 'shuffle') {
      const idx = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length);
      return void get().playSong(queue[idx], undefined, { expand: false });
    }

    // 顺序播放：播到最后一首就停住，不回卷（与列表循环的唯一差别，见 PlayMode 注释）
    if (playMode === 'order') {
      const idx = currentIndex + 1;
      if (idx >= queue.length) {
        // 已到队尾：停住当前歌曲（不清队列、不换歌）——"放完了"就该静下来
        set({ isPlaying: false });
        return;
      }
      return void get().playSong(queue[idx], undefined, { expand: false });
    }

    // list（列表循环）与 one（手动点「下一首」时单曲循环也要换歌）：回卷
    const idx = (currentIndex + 1) % queue.length;
    // expand:false —— 自动切歌不该把播放器弹开（含 onEnded 自动续播与无版权自动跳过）
    void get().playSong(queue[idx], undefined, { expand: false });
  },

  /**
   * 一首**自然播完**时的分流。
   *
   * ## 为什么必须在这里分流，而不是让 `onEnded` 直接调 `next()`
   *
   * 「单曲循环」的语义是：**自动播完重播当前曲**，但**手动点「下一首」要换歌**。
   * `next()` 同时服务这两条路，没法在里面区分 —— 所以此前 `one` 档
   * 落进了 `next()` 的"顺序下一首"分支，**单曲循环实际是坏的**（播完就切歌）。
   *
   * ## 为什么是"定位回 0"而不是重新 `playSong`
   * 重新播要走完整的取 URL 流程（网络歌要重新解析、可能还要等代理），
   * 单曲循环会因此每轮卡一下。直接 `currentTime = 0` 是即时的。
   */
  handleTrackEnded: () => {
    const { playMode } = get();
    if (playMode === 'one') {
      set({ progressMs: 0, isPlaying: true });
      const a = audioEl;
      if (a) {
        a.currentTime = 0;
        void a.play().catch(() => undefined);
      }
      // 歌词窗自己按 startedAtMs 走表，重播必须补推一次，否则它会继续按上一轮的基准往前跑
      void get().pushLyricsState();
      return;
    }
    get().next();
  },

  prev: () => {
    const { queue, currentIndex, playMode } = get();
    if (queue.length === 0) return;
    let idx: number;
    if (playMode === 'shuffle') {
      idx = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length);
    } else if (playMode === 'order') {
      // 顺序播放：**不回卷**。已是第一首就停在原地，而不是跳到队尾 ——
      // 回卷会让"顺序播放"在边界上与"列表循环"无法区分。
      idx = Math.max(0, currentIndex - 1);
    } else {
      idx = (currentIndex - 1 + queue.length) % queue.length;
    }
    void get().playSong(queue[idx], undefined, { expand: false });
  },

  seek: (ms) => {
    set({ progressMs: ms });
    // 必须**同时**挪 audio.currentTime：只改 store 是进度条动、声音不动；
    // 只改 currentTime 则进度条与音频不同步。两件事放在同一处做，才不会被人只做一半。
    const a = audioEl;
    if (a) a.currentTime = ms / 1000;
    // 拖动进度是**不连续跳变**：歌词窗靠自己走表，拖过之后它的基准就错了
    // （会一直按旧位置往下算），所以必须重推一次对齐。
    //
    // ⚠️ 但这里**必须去抖**，不能一调就推：展开播放器的进度条是
    // `onChange` 直连 seek（`ExpandedPlayer.tsx`），拖动过程中每秒能触发几十次 ——
    // 那就是「setProgress 那种频率」换个入口又灌进来一遍，把事件通道打爆。
    // 去抖后一次拖动只推一次（停手 120ms 后），既对齐了位置又压住了频率。
    // 播放条那条路径本身有拖拽会话（松手才提交），经过这里也只剩一次。
    if (seekPushTimer) clearTimeout(seekPushTimer);
    seekPushTimer = setTimeout(() => {
      seekPushTimer = null;
      void get().pushLyricsState();
    }, SEEK_PUSH_DEBOUNCE_MS);
  },

  setVolume: (v) => {
    // 调音量即「想听见」：若正静音则顺带解除，否则拖/滚了半天毫无反馈
    set(v > 0 ? { volume: v, muted: false } : { volume: v });
    savePrefs({ volume: v });
  },

  toggleMute: () => set((s) => ({ muted: !s.muted })),

  stepVolume: (delta) => {
    const v = Math.min(1, Math.max(0, get().volume + delta));
    get().setVolume(v);
  },

  closePlayback: () => {
    // 只停这一首，队列原样留着（下一首还能接着播）
    set({
      currentSong: null,
      playUrl: '',
      isPlaying: false,
      progressMs: 0,
      durationMs: 0,
      currentQuality: '',
      currentBitrate: 0,
    });
    // 必须推一次空状态：否则桌面歌词会一直挂着刚停掉那首的歌词
    void get().pushLyricsState();
  },

  setPlayMode: (mode) => {
    /*
     * 进入心动模式的前置闸 + 副作用，**只在这一处**。
     *
     * 不可用时直接不改模式（保持原档）—— 而不是把档位切过去、实际却按别的规则播。
     * 那种"按钮上是心动、行为是随机"的错位不报错、只表现为行为怪异，
     * 是本项目明确禁止的假控件级问题。其它平台按需求"不处理"。
     *
     * ⚠️ 这里**刻意不弹 toast**：需求给定的心动模式入口只有播放模式按钮一处，
     * 而它是"循环切下一档"的单按钮 —— 不可用时正确做法是**这一档不出现在
     * 可选范围里**（UI 不显示），而不是每次按都甩一条"不可用"的提示。
     * 提示只说明"你按的没用"，对用户没有可操作的价值。
     */
    if (mode === 'heartbeat') {
      if (!canUseHeartbeat(get())) return;
      /*
       * 记下"「我喜欢的音乐」开启过心动模式"：这是切回该歌单时自动进心动的唯一依据
       * （需求第 4 条）。写状态 + 落偏好，跨会话保留。
       */
      set({ playMode: mode, likedHeartbeatOn: true });
      savePrefs({ playMode: mode, likedHeartbeatOn: true });
      void get().enterHeartbeat();
      return;
    }

    /*
     * 切离心动模式 → 把队列**恢复成原来的播放列表**。
     *
     * 为什么在这里（而不是在 enterHeartbeat 里做清理）：切走的入口就是本函数，
     * 所有非心动档位都会经过它。放在这里就不可能有别的路径绕过恢复。
     *
     * 当前正在播的那首歌若还在原列表里，就把下标对到它身上 —— 这样画面与队列都不动，
     * 用户只觉得"列表回来了、歌没断"。若它不在原列表里（第二次进心动时种子歌是上一批
     * 相似歌），则回到当初离开时的下标：语义是"从原列表的那个位置继续"，
     * 这比强行跳去插一行"当前歌"更贴近"原来的播放列表"这个要求。
     */
    if (get().playMode === 'heartbeat' && get().heartbeatRestore) {
      const snap = get().heartbeatRestore as { queue: Song[]; index: number; queueFromLiked: boolean };
      const cur = get().currentSong;
      const found = cur ? snap.queue.findIndex((s) => songKey(s) === songKey(cur)) : -1;
      /*
       * 恢复后的队列分两种：
       *   ① 正在播的歌**在**原列表里 → 原样恢复并把下标对到它（列表回到位、歌不断）；
       *   ② 不在原列表里（心动列表是接口给的，未必收在原歌单内）→
       *      把它**插到队首**再恢复。
       * 为什么必须置顶而不是跳回原下标：那样用户会突然换到一首**别的歌**上，
       * 而界面毫无提示 —— 听感是"我点的歌自己跳走了"。置顶既保住了正在播的
       * 这首，又让它出现在列表第一行，语义自洽（下一首/上一首也从它往后走）。
       */
      const restored =
        cur && found < 0 ? [cur, ...snap.queue] : snap.queue;
      set({
        playMode: mode,
        queue: restored,
        currentIndex: cur && found < 0 ? 0 : found >= 0 ? found : snap.index,
        queueFromLiked: snap.queueFromLiked,
        /*
         * ⚠️ 这里**故意不**复位 `heartbeatSeeded`。
         * 队列虽然换回原列表了，但"进过心动"这个事实必须留着 —— 需求要求
         * 再切回心动时走"保留当前歌、只换其余"的路径；一旦在这里置假，
         * 切回来就会被当成首次进入，把用户正在听的歌**从头重播**。
         * 只在 `playQueue`（换播放源/歌单）时才复位。
         */
        heartbeatRestore: null,
      });
      savePrefs({ playMode: mode });
      return;
    }

    set({ playMode: mode });
    savePrefs({ playMode: mode });
  },

  cycleMode: () => {
    /*
     * 五档循环（需求给定顺序）：列表循环 → 单曲循环 → 随机播放 → 顺序播放 → 心动模式 → 回列表。
     *
     * 心动模式是**有条件可用**的档位：不可用时**跳过**它直接到下一档，
     * 不做"降级成随机"（降级会让用户以为在听相似歌曲，实际听的是随机），
     * 也**不弹提示**（需求给定"不显示心动模式的按钮"—— 不可用的档位就该静默不出现在
     * 可选范围里，每次按都提示只会让人以为按钮坏了）。`setPlayMode` 内部还有
     * 一道同样的闸兜底 —— 两处判据同源（都走 canUseHeartbeat），不会分歧。
     */
    const order: PlayMode[] = ['list', 'one', 'shuffle', 'order', 'heartbeat'];
    const cur = order.indexOf(get().playMode);
    const from = cur >= 0 ? cur : order.indexOf('order');

    for (let step = 1; step <= order.length; step++) {
      const cand = order[(from + step) % order.length];
      if (cand === 'heartbeat' && !canUseHeartbeat(get())) continue;
      get().setPlayMode(cand);
      return;
    }
  },

  setPlaybackQuality: async (q) => {
    set({ playbackQuality: q });
    savePrefs({ playbackQuality: q });

    // 正在播放时换档必须重取地址，否则「换了音质」要等下一首才生效。
    // 重取会让 <audio> 从 0 起播，所以把当前进度交给播放内核去续播（resumeAtMs）。
    const { currentSong, playUrl, progressMs } = get();
    if (!currentSong || !playUrl) return;
    try {
      const url = await resolvePlayUrl(currentSong, set, get);
      if (!url) return;
      // 期间又切歌了 → 放弃本次换档，避免把旧歌的地址盖到新歌上
      if (get().currentSong !== currentSong) return;
      set({ playUrl: url, resumeAtMs: progressMs, isPlaying: true });
      // 换档后音频从 resumeAtMs 续播，播放位置对歌词窗来说是一次跳变 —— 重推对齐
      void get().pushLyricsState();
    } catch {
      get().toast('切换音质失败，已保持原音质');
    }
  },

  clearResumeAt: () => set({ resumeAtMs: 0 }),

  setLyricsFontSize: (px) => {
    set({ lyricsFontSize: px });
    savePrefs({ lyricsFontSize: px });
  },

  setLyricsHighlightColor: (color) => {
    set({ lyricsHighlightColor: color });
    savePrefs({ lyricsHighlightColor: color });
  },

  setLyricsMode: (mode) => {
    set({ lyricsMode: mode });
    savePrefs({ lyricsMode: mode });
  },

  /*
   * 下面四个 setter 的形态一致：改内存 → 写偏好 → **推给歌词窗**。
   *
   * 第三条是「实时预览」的全部实现：偏好只写 localStorage 是不够的 ——
   * 两个 WebView 之间 `storage` 事件不保证触发（见 ipc.ts 的注释），
   * 所以必须显式走事件通道。用 pushLyricsPrefs（轻量）而不是 pushLyricsState，
   * 理由见 `pushLyricsPrefs` 的注释（拖滑杆会连发几十次）。
   *
   * 窗口没开时 Rust 侧静默成功，所以不必先判断开没开。
   */
  setDesktopLyricsFontSize: (px) => {
    set({ desktopLyricsFontSize: px });
    savePrefs({ desktopLyricsFontSize: px });
    void get().pushLyricsPrefs();
  },

  setDesktopLyricsHighlightColor: (color) => {
    set({ desktopLyricsHighlightColor: color });
    savePrefs({ desktopLyricsHighlightColor: color });
    void get().pushLyricsPrefs();
  },

  setDesktopLyricsBaseColor: (color) => {
    set({ desktopLyricsBaseColor: color });
    savePrefs({ desktopLyricsBaseColor: color });
    void get().pushLyricsPrefs();
  },

  setDesktopLyricsLineCount: (n) => {
    set({ desktopLyricsLineCount: n });
    savePrefs({ desktopLyricsLineCount: n });
    void get().pushLyricsPrefs();
  },

  resetDesktopLyricsPrefs: () => {
    // 四项作为一个 patch 一次写完：分四次 set+savePrefs+push 会连推四遍，
    // 而"恢复默认"在用户眼里是一次操作，一次推完即可。
    const patch = {
      desktopLyricsFontSize: DL_LYRICS_SIZE.def,
      desktopLyricsHighlightColor: DL_HIGHLIGHT_COLOR_DEF,
      desktopLyricsBaseColor: DL_BASE_COLOR_DEF,
      desktopLyricsLineCount: DL_LINE_COUNT.def,
    };
    set(patch);
    savePrefs(patch);
    void get().pushLyricsPrefs();
  },

  setDynamicEnabled: (on) => {
    set({ dynamicEnabled: on });
    savePrefs({ dynamicEnabled: on });
  },

  setDiscMode: (on) => {
    set({ discMode: on });
    savePrefs({ discMode: on });
  },

  setVinylColorMode: (mode) => {
    set({ vinylColorMode: mode });
    savePrefs({ vinylColorMode: mode });
  },

  setVinylCustomColor: (color) => {
    set({ vinylCustomColor: color });
    savePrefs({ vinylCustomColor: color });
  },

  setIslandView: (v) => {
    // 与其它偏好 setter 同形：改内存 → 写偏好。少了 savePrefs 这一步，
    // 用户切到歌词卡后重开应用会回到播放卡（"切了没记住"）。
    set({ islandView: v });
    savePrefs({ islandView: v });
  },

  /**
   * 逐帧推进播放进度（由 `<audio>.timeupdate` 驱动，**每秒数次**）。
   *
   * ⚠️⚠️ **这里绝对不要加 `pushLyricsState()`** —— 请先读下面这段再改：
   *
   * 桌面歌词窗收到一次 payload 后，会按 `startedAtMs` + 自己的单调钟**继续往前走**，
   * 所以它不需要主窗逐帧喂进度。真正的风险在另一头：`timeupdate` 是每秒数次的事件，
   * 在这里推意味着每秒数次跨进程序列化 + emit，事件通道会被打满，症状是
   * **主窗整体操作发涩、歌词窗反而卡顿**（一个为省事加的推送，同时毁掉两个窗口）。
   *
   * 「用户拖了进度条怎么办」不构成在这里推的理由 —— 拖动是**不连续跳变**，
   * 已经在 `seek` 里推了一次（那里才是它该待的地方）。
   * 需要桌面歌词跟着走的"状态跳变"清单，见 `pushLyricsState` 的注释。
   */
  setProgress: (ms) => set({ progressMs: ms }),
  setDuration: (ms) => set({ durationMs: ms }),
});
