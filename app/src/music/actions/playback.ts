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

export const createPlaybackSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'playSong' | 'playQueue' | 'togglePlay' | 'next' | 'handleTrackEnded' | 'fallbackNext' | 'prev' | 'seek' | 'setVolume' | 'toggleMute' | 'stepVolume' | 'closePlayback' | 'cycleMode' | 'setPlaybackQuality' | 'clearResumeAt' | 'setLyricsFontSize' | 'setLyricsHighlightColor' | 'setLyricsMode' | 'setDesktopLyricsFontSize' | 'setDesktopLyricsHighlightColor' | 'setDesktopLyricsBaseColor' | 'setDesktopLyricsLineCount' | 'resetDesktopLyricsPrefs' | 'setDynamicEnabled' | 'setDiscMode' | 'setVinylColorMode' | 'setVinylCustomColor' | 'setIslandView' | 'setProgress' | 'setDuration'> => ({
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
    await get().playSong(song, songs, opts);
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

    // 心动模式：播完当前这首后，按它找相似歌曲续播，**并把相似结果替换成新队列**。
    // 为什么替换而不是追加：心动模式是"顺着当前这首歌往下听"，队列会越滚越杂；
    // 而每次替换都让队列变成"这一串都是相似歌"，语义与体验都更稳。
    // 降级：非网易云无"按 songid 找相似"接口 → 退化为随机（与 shuffle 同语义），
    // **不拿同歌手/同歌单冒充相似**。切换该档时已提示过用户，这里不再重复弹提示。
    if (playMode === 'heartbeat' && platform.supportsSimilar(get().playbackSource)) {
      const cur = queue[currentIndex];
      if (!cur) {
        get().toast('心动模式需要先有一首歌在播');
        return;
      }
      void (async () => {
        try {
          const similar = await platform.similarSongs(get().playbackSource, cur.id, 20);
          // 排除当前这首与空结果：接口可能把它自己也算进"相似"里
          const pick = similar.filter((s) => songKey(s) !== songKey(cur));
          if (pick.length === 0) {
            get().toast('没有找到相似歌曲，已切回队列下一首');
            get().fallbackNext();
            return;
          }
          const nextSong = pick[0];
          // 用相似列表当新队列，并跳到第一首；expand:false —— 自动续播不该弹开播放器
          await get().playSong(nextSong, pick, { expand: false });
        } catch (e) {
          get().toast(`找相似歌曲失败：${String(e)}`);
          get().fallbackNext();
        }
      })();
      return;
    }

    let idx = currentIndex;
    if (playMode === 'shuffle' || playMode === 'heartbeat') {
      // heartbeat 走到这里 = 平台不支持相似（已提示过），按随机处理
      idx = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length);
    } else {
      idx = (currentIndex + 1) % queue.length;
    }
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

  /**
   * 按现有队列顺序取下一首 —— 供"心动模式拿不到相似歌曲"时降级调用。
   * 单独成 action 而不是给 next 加参数：调用点（相似接口失败）需要明确表达
   * "我不是要随机，我要队列的下一首"，让降级路径在代码里一眼可辨。
   */
  fallbackNext: () => {
    const { queue, currentIndex } = get();
    if (queue.length === 0) return;
    const idx = (currentIndex + 1) % queue.length;
    void get().playSong(queue[idx], undefined, { expand: false });
  },

  prev: () => {
    const { queue, currentIndex, playMode } = get();
    if (queue.length === 0) return;
    const idx =
      playMode === 'shuffle'
        ? queue.length === 1
          ? 0
          : Math.floor(Math.random() * queue.length)
        : (currentIndex - 1 + queue.length) % queue.length;
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

  cycleMode: () => {
    // 四档循环：列表 → 随机 → 单曲 → 心动 → 列表
    // ⚠️ 心动模式（heartbeat）的语义是"按当前歌曲找相似续播"，**仅网易云可得**。
    // 其余平台会降级为随机（见 next 的 heartbeat 分支），所以切换到心动档时
    // 必须提示用户，否则他会以为在听"相似歌曲"、实际听的是随机 —— 这与假控件同级的问题。
    const order: PlayMode[] = ['list', 'shuffle', 'one', 'heartbeat'];
    const nextMode = order[(order.indexOf(get().playMode) + 1) % order.length];
    set({ playMode: nextMode });
    savePrefs({ playMode: nextMode });
    if (nextMode === 'heartbeat' && !platform.supportsSimilar(get().playbackSource)) {
      get().toast(
        `${platform.providerLabel(get().playbackSource)} 没有"按歌曲找相似"的能力，已降级为随机播放`,
      );
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
