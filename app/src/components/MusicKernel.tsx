import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ensureAudioContextActive, markNotWirable } from '@music/audioGraph';
import type { LyricsControlPayload } from '@music/ipc';
import { registerAudioElement, useMusicStore } from '@music/store';

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
 */
export function MusicKernel() {
  const audioRef = useRef<HTMLAudioElement>(null);

  const playUrl = useMusicStore((s) => s.playUrl);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const volume = useMusicStore((s) => s.volume);
  const muted = useMusicStore((s) => s.muted);
  /** 换音质后的续播位置（毫秒，0=无）；消费后清零 */
  const resumeAtMs = useMusicStore((s) => s.resumeAtMs);

  const clearResumeAt = useMusicStore((s) => s.clearResumeAt);
  const setProgress = useMusicStore((s) => s.setProgress);
  const setDuration = useMusicStore((s) => s.setDuration);
  const next = useMusicStore((s) => s.next);
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

  // 音量与静音同步。静音走 `muted` 属性、**不动 volume 值** —— 取消静音才回得到原音量
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = volume;
    a.muted = muted;
  }, [volume, muted]);

  // 播放/暂停同步（playUrl 变化时也要重试 play —— 新音频需重新触发播放）
  // resumeAtMs：换音质会重新取地址、音频从 0 起播，这里把进度补回去再播
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (resumeAtMs > 0) {
      a.currentTime = resumeAtMs / 1000;
      clearResumeAt();
    }
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
        const d = e.currentTarget.duration;
        setDuration(Number.isFinite(d) ? d * 1000 : 0);
      }}
      onEnded={() => next()}
      onError={() => {
        if (!playUrl) return;
        const a = audioRef.current;
        if (corsMode && a) {
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
        // 兼容模式下仍失败：这次是真失败了（链接失效 / 网络异常），如实告知
        toast('音频加载失败：链接可能已失效或网络异常');
      }}
    />
  );
}
