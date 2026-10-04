import { useEffect, useRef } from 'react';
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
    if (isPlaying) void a.play().catch(() => undefined);
    else a.pause();
  }, [clearResumeAt, isPlaying, playUrl, resumeAtMs]);

  return (
    /* playUrl 为空时不设 src（否则 WebView 会对空地址报错） */
    <audio
      ref={audioRef}
      className="music-audio"
      src={playUrl || undefined}
      onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime * 1000)}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        setDuration(Number.isFinite(d) ? d * 1000 : 0);
      }}
      onEnded={() => next()}
      onError={() => {
        if (playUrl) toast('音频加载失败：链接可能已失效或网络异常');
      }}
    />
  );
}
