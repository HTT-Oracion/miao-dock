import { useCallback, useEffect } from 'react';
import { useMusicStore } from '@music/store';
import { LeftPanel } from '@screens/music/LeftPanel';
import { LoginModal } from '@screens/music/LoginModal';
import { NowPlaying } from '@screens/music/NowPlaying';
import { PlayerBar } from '@screens/music/PlayerBar';
import { QueueDrawer } from '@screens/music/QueueDrawer';
import { RightPanel } from '@screens/music/RightPanel';
import { Toast } from '@screens/music/Toast';
import { TopBar } from '@screens/music/TopBar';

/**
 * 音乐屏 —— 只做**组合**，各区域实现在 `./music/` 下：
 *   TopBar（顶栏 + 平台弹窗）/ LeftPanel（我的音乐四视图）/ RightPanel（发现 + 搜索）/
 *   NowPlaying（右栏正在播放）/ PlayerBar（底部播放条）/ QueueDrawer / LoginModal / Toast
 *
 * ## 结构（设计稿 `screen-music`）
 * ```
 * .music-layout   grid: 234px | minmax(0,1fr) | 252px
 *   .music-side   左资料库（TopBar + LeftPanel）
 *   .music-center 中内容（RightPanel：发现 / 搜索 / 曲目）
 *   .music-now    右「正在播放」（NowPlaying）
 * .player-bar     底部播放条
 * ```
 * 旧结构是「顶行 + 左右 50/50 双卡」，与设计稿的三栏不是同一件事 ——
 * 三栏把"浏览"与"当前播放"分开：播放态在右栏常驻，不再与列表挤在同一张卡里。
 *
 * ## 播放内核与展开播放器都**不在这里**（2026-10-04 / 2026-10-12 移出）
 * 唯一的 `<audio>` 挂在应用层常驻的 `components/MusicKernel.tsx`；
 * `ExpandedPlayer` 同样搬去了应用根（App.tsx）。判据很简单：
 * **离开本屏之后还该继续存在的，就不能住在本屏里。**
 */
export function MusicScreen() {
  // 播放队列为空时整条播放条不出现（没有内容可播时它只是一条占位）
  const queueLength = useMusicStore((s) => s.queue.length);

  const init = useMusicStore((s) => s.init);
  const restoreSession = useMusicStore((s) => s.restoreSession);
  const seek = useMusicStore((s) => s.seek);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  /*
   * 启动恢复上次播放（进音乐模块时跑，见 store 的 restoreSession）。
   *
   * ① 为什么**串在 init 之后**而不是并行：init 里的 `loadAllLoginStatuses` 会探四个平台
   *    的登录态。串行能复用它探到的结果；并行等于同一时间发两次同样的探测请求。
   * ② 为什么**不在** main.tsx 里做：恢复要显示播放条，而播放条属于音乐屏。
   * ③ `restoreSession` 自带只跑一次的门，所以切走再切回不会重复恢复。
   */
  useEffect(() => {
    void (async () => {
      await init();
      await restoreSession();
    })();
  }, [init, restoreSession]);

  // Esc 关闭队列抽屉（只在本屏存在时有意义，故留在本屏）。
  // ⚠️ 展开播放器的 Esc 已搬去 App 根 —— 这里只管队列，否则两处都监听会互相把对方的收起动作重复触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setQueueOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setQueueOpen]);

  /** 进度条定位：`seek` 的转发（store 内已收拢进度与 `<audio>.currentTime`）。 */
  const onSeek = useCallback((ms: number) => seek(ms), [seek]);

  return (
    <div className="music">
      <div className="music-layout">
        <aside className="music-side">
          <TopBar />
          <LeftPanel />
        </aside>

        <div className="music-center">
          <RightPanel />
        </div>

        <aside className="music-now">
          <NowPlaying />
        </aside>
      </div>

      <PlayerBar onSeek={onSeek} hidden={queueLength === 0} />

      <QueueDrawer />
      <LoginModal />
      <Toast />
    </div>
  );
}
