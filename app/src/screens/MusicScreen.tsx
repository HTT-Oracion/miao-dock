import { useCallback, useEffect, useRef } from 'react';
import { useMusicStore } from '../music/store';
import { ExpandedPlayer } from './music/ExpandedPlayer';
import { LeftPanel } from './music/LeftPanel';
import { LoginModal } from './music/LoginModal';
import { PlayerBar } from './music/PlayerBar';
import { QueueDrawer } from './music/QueueDrawer';
import { RightPanel } from './music/RightPanel';
import { Toast } from './music/Toast';
import { TopBar } from './music/TopBar';

/**
 * 音乐屏 —— 只做**组合**与**播放内核挂载**，各区域实现在 ./music/ 下：
 *   TopBar（顶行+平台弹窗）/ LeftPanel（我的音乐四视图）/ RightPanel（发现+搜索）
 *   PlayerBar（底部播放条）/ QueueDrawer（队列）/ ExpandedPlayer（展开播放器）
 *   LoginModal（登录）/ Toast（轻提示）
 *
 * 播放内核：唯一一个 <audio> 挂在这里，store 持有状态（playUrl/isPlaying/progress）。
 * 进度条拖动的落点必须同时改 store 与 audio.currentTime —— 只改 store 不会真的定位，
 * 所以通过 onSeek 一路传给 PlayerBar / ExpandedPlayer。
 */
export function MusicScreen() {
  const audioRef = useRef<HTMLAudioElement>(null);

  const playUrl = useMusicStore((s) => s.playUrl);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const volume = useMusicStore((s) => s.volume);
  // 播放队列为空时整条播放条不出现（没有内容可播时它只是一条占位）；
  // 有歌时它是 .music 的最后一个 flex 子项 + flex:0 0 auto，恒贴在本屏底部
  // （外层的 .content 不再滚动，见 app.css 的 .music height:100%）。
  const queueLength = useMusicStore((s) => s.queue.length);

  const init = useMusicStore((s) => s.init);
  const setProgress = useMusicStore((s) => s.setProgress);
  const setDuration = useMusicStore((s) => s.setDuration);
  const next = useMusicStore((s) => s.next);
  const seek = useMusicStore((s) => s.seek);
  const toast = useMusicStore((s) => s.toast);
  const setExpanded = useMusicStore((s) => s.setExpanded);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  // 只挂载一次：init 内部恢复偏好、拉四平台登录态与首屏发现数据
  useEffect(() => {
    void init();
  }, [init]);

  // 音量同步
  useEffect(() => {
    const a = audioRef.current;
    if (a) a.volume = volume;
  }, [volume]);

  // 播放/暂停同步（playUrl 变化时也要重试 play —— 新音频需重新触发播放）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) void a.play().catch(() => undefined);
    else a.pause();
  }, [isPlaying, playUrl]);

  // Esc 关闭展开播放器 / 队列抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
        setQueueOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setExpanded, setQueueOpen]);

  const onSeek = useCallback(
    (ms: number) => {
      seek(ms);
      const a = audioRef.current;
      if (a) a.currentTime = ms / 1000;
    },
    [seek],
  );

  return (
    <div className="music">
      <TopBar />

      <div className="music-cols">
        <LeftPanel />
        <RightPanel />
      </div>

      <PlayerBar onSeek={onSeek} hidden={queueLength === 0} />

      <QueueDrawer />
      <ExpandedPlayer onSeek={onSeek} />
      <LoginModal />
      <Toast />

      {/* 播放内核：playUrl 为空时不设 src（否则 WebView 会对空地址报错） */}
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
    </div>
  );
}
