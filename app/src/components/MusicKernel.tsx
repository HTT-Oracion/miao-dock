import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useMusicHotkeys } from '@hooks/useMusicHotkeys';
import { ensureAudioContextActive, isGraphAttached, markNotWirable, setGraphVolume } from '@music/audioGraph';
import type { LyricsControlPayload } from '@music/ipc';
import { registerAudioElement, useMusicStore } from '@music/store';
import { SNAPSHOT_PERSIST_INTERVAL_MS } from '@music/persist';

/**
 * 音乐播放内核 —— **应用级常驻组件**。
 *
 * ## 为什么必须住在应用层，而不是音乐屏里
 *
 * `<audio>` 元素一旦随宿主组件卸载就会被销毁，播放随之中断。
 * 它原先挂在 `MusicScreen` 内，于是「播放中切到设置页」= 音乐当场停掉 ——
 * 而"播放不该随页面切换中断"是后面一切播放能力的前提。
 *
 * 参考实现把内核放在应用根的 Context Provider 里，所以切页不断播。
 * 本移植按项目规则**不用 Context**（《09》§2.3.3：共享状态统一 zustand），
 * 做法是把两者分开摆：**状态在 store，DOM 在这个常驻组件里**，
 * 中间靠 `registerAudioElement` 一条通道打通（见 store.ts 该函数的注释）。
 *
 * ## 这不是"顺带把 audio 挪个位置"
 *
 * 它是同一段逻辑的**整体搬家** —— 音量/静音同步、播放与暂停、换音质续播、
 * timeupdate / loadedmetadata / ended / error 全在这里。音乐屏从此只做 UI 组合，
 * 不再持有任何播放副作用；两边各留一半，正是"切屏断播"这类 bug 的温床。
 *
 * ## ⚠️ `crossOrigin="anonymous"` 不是可选的
 *
 * 波形 / 频谱要读音频电平，就得把 `<audio>` 交给 `createMediaElementSource` 接管。
 * 而 Web Audio 的安全规则是：元素**未以 CORS 模式**加载时，跨域媒体的输出**恒为静音**。
 *
 * 症状极容易误判成"播放器坏了"：**本地歌曲有声、网络歌曲一点声音都没有**
 *（本地走 `asset://`，Tauri 的 asset 协议带 CORS 头；网络歌曲是第三方 CDN）。
 *
 * 所以这里显式声明 CORS 模式 —— 与参考实现的做法一致。
 *
 * ## 但 CORS 模式有代价，所以必须有回退
 *
 * 声明 `crossOrigin="anonymous"` 后，**不带 `Access-Control-Allow-Origin` 的音源会加载失败**
 *（不是静音，是彻底加载不出来）。宁可少一个波形也不能让歌播不了，因此：
 * 一旦加载报错且当前是 CORS 模式 → **摘掉 `crossOrigin` 重载，并把该元素标记为不可接管**
 *（`markNotWirable`）。标记是必须的：非 CORS 模式下若能加载，说明该资源跨域且无 CORS 头，
 * 此时**接管即静音** —— 那个波形永远不该出现。
 *
 * 回退结果按**域名**记住：同一平台的后续歌曲直接走兼容模式，不必每首失败一次。
 *
 * ## 归属说明
 *
 * 它依赖 store，因此**不进 `components/units/`**（units 的判据是不依赖业务层），
 * 而是应用级组件（同 Sidebar / Toolbar / QuitConfirm）。
 *
 * ## 为什么键盘快捷键也挂在**这里**（而不是 MusicScreen）
 *
 * 判据与 `<audio>` 同源，但**理由不同**，别混为一谈：
 * `<audio>` 挂这里是因为"元素随宿主卸载即销毁"；
 * 快捷键挂这里是因为**需求本身就是"跨屏常驻"** ——
 * 用户离开音乐屏去设置页/漫画页，音乐仍在放，快捷键也必须照样能暂停、切歌。
 *
 * ⚠️ 对照 `MusicScreen.tsx` 里那条**刻意留在本屏**的 Esc 监听：
 * 那个之所以不住常驻层，是因为 Esc 的语义**只在音乐屏成立**
 * （收起展开播放器 / 关队列抽屉，在别的屏按 Esc 没有意义）。
 * 两者判断标准是同一条：**「离开音乐屏之后还该继续生效的，就不能住在音乐屏里」**。
 * MusicScreen 是条件渲染（切屏即卸载），快捷键挂那里 ⇒ 一离开音乐屏就失效，
 * 直接违背"打开过就一直生效"。
 */
export function MusicKernel() {
  const audioRef = useRef<HTMLAudioElement>(null);

  /**
   * 键盘快捷键（`Space` / `⌘←` / `⌘→` / `↑` / `↓`）。
   * 挂载点理由见文件头；键位与让位判据见 `hooks/useMusicHotkeys.ts`。
   * 它自己取 store（`getState()`），所以这里不需要额外订阅任何状态。
   */
  useMusicHotkeys();

  const playUrl = useMusicStore((s) => s.playUrl);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const volume = useMusicStore((s) => s.volume);
  const muted = useMusicStore((s) => s.muted);
  /** 换音质后的续播位置（毫秒，0=无）；消费后清零 */
  const resumeAtMs = useMusicStore((s) => s.resumeAtMs);

  const clearResumeAt = useMusicStore((s) => s.clearResumeAt);
  const setProgress = useMusicStore((s) => s.setProgress);
  const setDuration = useMusicStore((s) => s.setDuration);
  /** 启动恢复态：这一首真的加载出来了就关掉（见 store 的 finishRestore） */
  const finishRestore = useMusicStore((s) => s.finishRestore);
  /** 恢复态下这首歌加载失败 → 换下一首（Q4） */
  const handleRestoreFailed = useMusicStore((s) => s.handleRestoreFailed);
  /**
   * 播完分流 —— **不要改回 `onEnded={() => next()}`**：
   * 那样「单曲循环」会在播完时切歌（`next()` 的 `one` 分支就是"顺序下一首"），
   * 于是这个档位形同虚设。分流逻辑在 store 的 `handleTrackEnded` 里。
   */
  const handleTrackEnded = useMusicStore((s) => s.handleTrackEnded);
  const toast = useMusicStore((s) => s.toast);

  /**
   * 是否以 CORS 模式加载。默认**是**（这样音频图才能接管、波形才是真的）。
   * 仅在加载失败时降级为 `false`。
   */
  const [corsMode, setCorsMode] = useState(true);

  /**
   * 已知**不接受 CORS** 的域名。内存态即可（重启后重新试探一次，代价很小）；
   * 存在它的意义是：同一平台的第二首歌不再重复"失败→回退"这一轮。
   */
  const corsBlockedHosts = useRef<Set<string>>(new Set());

  /** 拿 URL 的 host（`asset://` 等非标准协议解析失败时返空串，视为本地、天然同源） */
  const hostOf = (url: string): string => {
    try {
      return new URL(url, window.location.href).host;
    } catch {
      return '';
    }
  };

  // 换曲目：重判 CORS 模式（不同平台可能一个带 CORS 头、一个不带）
  useEffect(() => {
    if (!playUrl) return;
    const host = hostOf(playUrl);
    setCorsMode(!(host && corsBlockedHosts.current.has(host)));
    // hostOf 是纯函数（依赖 location），无需进依赖表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playUrl]);

  // 登记 audio 元素：`seek` 要在同一处改 state 与 currentTime（store 拿不到组件里的 ref）
  useEffect(() => {
    registerAudioElement(audioRef.current);
    return () => registerAudioElement(null);
  }, []);

  /**
   * 兜底存「启动恢复快照」，30 秒一次。
   *
   * ## 为什么需要它（切歌 / 暂停已经写过了）
   * 那两个时机覆盖的是"换歌后退出""暂停后退出"，剩下的是**正听着直接退出应用**——
   * Tauri 没有可靠的 `beforeunload`，所以只能靠低频轮询把进度落盘。
   *
   * ## 为什么 30 秒而不是更短
   * 快照序列化 200 首歌约几十 KB（`sanitizeForStorage` 已清掉 base64 封面）。
   * 更短的间隔是为了几秒的进度精度去付持续的 JSON 序列化 + localStorage 写入，
   * 不划算；而**用户听 30 秒以上再关掉的场景本来就覆盖了绝大多数**。
   *
   * 只在"有歌且正在播"时才写：暂停态的进度不会再变（暂停时已写过），
   * 空转只是白费 I/O。
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useMusicStore.getState();
      if (!s.isPlaying || !s.currentSong) return;
      s.persistSnapshot();
    }, SNAPSHOT_PERSIST_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // 音量与静音同步。
  //
  // ⚠️ **接管前后走两条不同的路**（见 `audioGraph` 的搬运注释）：
  // 音频图接管 `<audio>` 后，元素的 `volume` 是否还生效**取决于平台实现**
  //（WKWebView 上有失灵的情况，表现就是"拖音量滑块没反应"）。
  // 所以接管后音量归图上的 gain 管，元素归一到 1 —— 否则元素与 gain 双重作用会变成 v²。
  // 两个分支互斥且各自自洽；接管那一刻 `audioGraph` 自己会把元素当时的音量搬进 gain，
  // 所以这里不需要感知"attach 何时完成"。
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isGraphAttached()) {
      a.volume = 1;
      a.muted = false;
      setGraphVolume(muted ? 0 : volume);
    } else {
      a.volume = volume;
      a.muted = muted;
    }
  }, [volume, muted]);

  // 播放/暂停同步（playUrl 变化时也要重试 play —— 新音频需重新触发播放）
  // 播放/暂停同步（playUrl 变化时也要重试 play —— 新音频需重新触发播放）
  //
  // ⚠️ **这里不再设 currentTime**，seek 已挪到 `onLoadedMetadata`（见那里注释）。
  // 冷启动恢复是**全新加载**（`src` 刚变），此刻元数据还没到，
  // 设 `currentTime` 会被浏览器**静默忽略**（表现为"定位没生效、从 0 开始"）。
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      /**
       * 播放动作是**用户手势链**上的一环，是唯一可靠的 resume 时机。
       * AudioContext 处于 suspended 时音频图会整体静音（而且不会报错），
       * 所以每次起播都顺手把上下文激活一遍（已在 running 时是空操作）。
       */
      void ensureAudioContextActive();
      void a.play().catch(() => undefined);
    } else {
      a.pause();
    }
  }, [clearResumeAt, isPlaying, playUrl, resumeAtMs]);

  /**
   * CORS 模式变化后必须**重新加载**：`crossOrigin` 只在加载时生效，
   * 单纯改属性不会重取资源（会留下一个"属性已改、行为没变"的假状态）。
   * 首次不跑（挂载时那次加载由 React 完成）。
   */
  const corsSettled = useRef(false);
  useEffect(() => {
    if (!corsSettled.current) {
      corsSettled.current = true;
      return;
    }
    const a = audioRef.current;
    if (!a || !playUrl) return;
    a.load();
    if (useMusicStore.getState().isPlaying) void a.play().catch(() => undefined);
  }, [corsMode, playUrl]);

  /**
   * 接收**桌面歌词窗**发来的播放控制。
   *
   * 为什么必须在这里监听、而不是歌词窗自己处理：两个窗口是独立的 WebView，
   * 各自的 JS 堆互不可见 —— 歌词窗里的 store 是另一个实例（只有 localStorage 共享，
   * 那是磁盘态不是内存态）。所以那边点"下一首"只能经 Rust 的 `lyrics://control`
   * 转发过来，由主窗真正执行。
   *
   * 挂在 MusicKernel（应用级常驻组件）上：它本来就管"播放"这件事，
   * 且生命周期与 App 一致，不会因为切屏而漏掉事件。
   */
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    void (async () => {
      try {
        const off = await listen<LyricsControlPayload>('lyrics://control', (e) => {
          if (disposed) return;
          const s = useMusicStore.getState();
          switch (e.payload?.action) {
            case 'toggle-play':
              s.togglePlay();
              break;
            case 'prev':
              s.prev();
              break;
            case 'next':
              s.next();
              break;
            case 'cycle-mode':
              s.cycleMode();
              /**
               * ⚠️ `cycleMode` 自己**不推送**（它原本只服务主窗 UI）——
               * 这里必须补一次，否则歌词窗的播放模式图标会停在旧值，
               * 用户看到的现象是"点了没反应"。
               */
              void s.pushLyricsState();
              break;
            case 'volume':
              if (typeof e.payload.value === 'number') s.setVolume(e.payload.value);
              break;
            default:
              break;
          }
        });
        if (disposed) off();
        else un = off;
      } catch {
        /* 无 Tauri 桥（浏览器里直开主窗）：忽略 */
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  /* playUrl 为空时不设 src（否则 WebView 会对空地址报错） */
  return (
    <audio
      ref={audioRef}
      className="music-audio"
      /**
       * CORS 模式。见文件头：不设的话音频图接管后跨域资源会被静音。
       * 降级为兼容模式时传 `undefined`（React 会移除该属性）。
       */
      crossOrigin={corsMode ? 'anonymous' : undefined}
      src={playUrl || undefined}
      onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime * 1000)}
      onLoadedMetadata={(e) => {
        const a = e.currentTarget;
        const d = a.duration;
        setDuration(Number.isFinite(d) ? d * 1000 : 0);
        /**
         * 续播 / 恢复定位：**必须等元数据就绪**才能设 `currentTime`。
         *
         * 冷启动恢复是全新加载（`src` 刚变、readyState 还是 0），
         * 此刻设 currentTime 会被浏览器**静默忽略** —— 症状是"定位没生效、
         * 从 0 开始"，而且不报错。换音质那条路以前能用，只是因为同一首歌的
         * 音频**已经加载过**；放在这里对两者都正确。
         *
         * 顺带在这关掉恢复态：这首歌能读到元数据 = 真的能播，
         * 之后的失败就该走正常逻辑（提示 + 停），不该再遍历整个队列。
         */
        if (resumeAtMs > 0) {
          a.currentTime = resumeAtMs / 1000;
          clearResumeAt();
        }
        finishRestore();
      }}
      onEnded={() => handleTrackEnded()}
      onError={() => {
        if (!playUrl) return;
        const a = audioRef.current;
        /**
         * **本地文件不走 CORS 降级**（这是恢复态能收敛的前提）。
         *
         * 本地歌的地址是 `asset://`（Tauri 的 asset 协议**带 CORS 头**），
         * 它加载失败只有一个原因：**文件被移动/删除**。走降级路径会有两个坏处：
         *   ① 白白多一轮 `load()` 重载 —— 而重载同样会失败；
         *   ② 更糟：降级路径会 `markNotWirable(a)`，把当前 audio 元素**永久**
         *      标记为不可接管（音量随即改由 gain 失效、真实波形消失）。
         *      那个元素是常驻的，标记一次就再也回不来。
         * 判据用 `currentSong._localPath` 而不是 URL 前缀 —— 语义更准，
         * 不依赖地址格式（网络歌走的是本地代理 `http://127.0.0.1:…`，不是 asset）。
         */
        const isLocalFile = !!useMusicStore.getState().currentSong?._localPath;
        if (corsMode && a && !isLocalFile) {
          /**
           * 首轮失败：判为"该音源不接受 CORS" → 降级重载。
           *
           * ⚠️ 顺序要紧：**先标记不可接管，再切模式**。反过来的话，
           * 新的一轮加载与 `setCorsMode` 触发的 effect 之间可能出现一帧窗口，
           * 让音频图在非 CORS 模式下接管 —— 那一帧就足以让这首歌彻底没声。
           */
          markNotWirable(a);
          corsBlockedHosts.current.add(hostOf(playUrl));
          setCorsMode(false);
          return;
        }
        // 兼容模式下仍失败：这次是真失败了（链接失效 / 网络异常 / 本地文件被移走）
        if (useMusicStore.getState().restoring) {
          // 恢复态（Q4）：换下一首继续试，直到有一首能播；整条队列都试完由
          // handleRestoreFailed 负责清空。静默，不弹 toast。
          handleRestoreFailed();
          return;
        }
        toast('音频加载失败：链接可能已失效或网络异常');
      }}
    />
  );
}
