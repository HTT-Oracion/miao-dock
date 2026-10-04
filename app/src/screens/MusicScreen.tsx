import { useCallback, useEffect } from 'react';
import { useMusicStore } from '@music/store';
import { ExpandedPlayer } from '@screens/music/ExpandedPlayer';
import { LeftPanel } from '@screens/music/LeftPanel';
import { LoginModal } from '@screens/music/LoginModal';
import { PlayerBar } from '@screens/music/PlayerBar';
import { QueueDrawer } from '@screens/music/QueueDrawer';
import { RightPanel } from '@screens/music/RightPanel';
import { Toast } from '@screens/music/Toast';
import { TopBar } from '@screens/music/TopBar';

/**
 * 音乐屏 —— 只做**组合**，各区域实现在 ./music/ 下：
 *   TopBar（顶行+平台弹窗）/ LeftPanel（我的音乐四视图）/ RightPanel（发现+搜索）
 *   PlayerBar（底部播放条）/ QueueDrawer（队列）/ ExpandedPlayer（展开播放器）
 *   LoginModal（登录）/ Toast（轻提示）
 *
 * ## 播放内核**不在这里**（2026-10-04 移出）
 *
 * 唯一一个 `<audio>` 挂在应用层常驻的 `components/MusicKernel.tsx`。
 * 原先它挂在本屏内 —— 本屏会在切到设置页时卸载，`<audio>` 随之销毁，**播放当场中断**。
 * 所以本屏现在只剩 UI 组合，以及两条**本屏级**副作用（首屏数据 init、Esc 关闭浮层）。
 *
 * 判据很简单：**离开本屏之后还该继续存在的，就不能住在本屏里。**
 */
export function MusicScreen() {
  // 播放队列为空时整条播放条不出现（没有内容可播时它只是一条占位）；
  // 有歌时它是 .music 的最后一个 flex 子项 + flex:0 0 auto，恒贴在本屏底部
  // （外层的 .content 不再滚动，见 app.css 的 .music height:100%）。
  const queueLength = useMusicStore((s) => s.queue.length);

  const init = useMusicStore((s) => s.init);
  const restoreSession = useMusicStore((s) => s.restoreSession);
  const seek = useMusicStore((s) => s.seek);
  const closeExpanded = useMusicStore((s) => s.closeExpanded);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  /*
   * 启动恢复上次播放（进音乐模块时跑，见《09》§5.6 拍板口径与 store 的 restoreSession）。
   *
   * ① 为什么**串在 init 之后**而不是并行：init 里的 `loadAllLoginStatuses` 会探四个平台
   *    的登录态。串行能复用它探到的结果；并行等于同一时间发两次同样的探测请求。
   * ② 为什么**不在** main.tsx 里做：恢复要显示播放条，而播放条属于音乐屏。
   *    放 main.tsx 会在用户还没进音乐屏时就发网络请求、动播放内核。
   * ③ `restoreSession` 自带只跑一次的闸（Q6），所以切走再切回不会重复恢复。
   */
  useEffect(() => {
    void (async () => {
      await init();
      await restoreSession();
    })();
  }, [init, restoreSession]);

  // Esc 关闭展开播放器 / 队列抽屉（只在本屏存在时有意义，故留在本屏）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 收起走 closeExpanded（带动画）—— 与点「收起」按钮是同一条路径，
        // 否则 Esc 会绕过退场动画，两处手感不一致
        closeExpanded();
        setQueueOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeExpanded, setQueueOpen]);

  /**
   * 进度条定位。
   * 现在只是 `seek` 的转发：改 store 进度与挪 `<audio>.currentTime` 两件事
   * 已收进 store action 内（它通过 `registerAudioElement` 拿得到元素）。
   * 保留这条 prop 是为了不让三个调用点各自去认 store。
   */
  const onSeek = useCallback((ms: number) => seek(ms), [seek]);

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
    </div>
  );
}
