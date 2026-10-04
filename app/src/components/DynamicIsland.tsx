import { Pause, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@components/units/IconButton';
import { toastBus, useToastsFromBus } from '@/toastBus';
import { useMusicStore } from '@music/store';

/**
 * 灵动岛（拍板第 4 项：方案 B = 播放态 + 承接轻提示）。
 *
 * ## 形态与行为契约取自哪里
 * 参考实现的组件本体（`@/components/ui/dynamic-island`）**没有随源码切片带过来**，
 * 能取到的只有**行为契约**（从调用点反推，证据见 spec-notes D-50）：
 * · `useDynamicIsland("music")` 返回 `toast` 函数，用法
 *   `toast({ title, description?, status, duration, isClosable? })` —— 字段名照抄不过时，
 *   但本项目的 `Toast` 是 `{ id, text, kind }`（kind 只有 info/good/bad），
 *   故这里**只借它的行为**（顶部胶囊 + 轻提示 + 播放卡片 + 打开播放器），不硬套它的字段。
 * · 它转发 `musicToast` 后**立即清空源 store** —— 同一条提示不能被渲染两次。
 *   本组件用 `dismiss(id)` 达同样效果（音乐屏那套转发进来，见 `MusicScreen` 的 effect）。
 *
 * ## 为什么接管「应用级」toast
 * 音乐屏的 `Toast` 住在 `screens/music/Toast.tsx` 读 `store.musicToast` ——
 * **切到设置页就看不见**。应用级 `useToasts` 已被 6 处业务使用，接管它才有全局可见的意义。
 *
 * ## 三种状态（互斥，按此顺序判）
 * 1. **轻提示优先**：用户刚操作完，注意力在反馈上
 * 2. **播放态**：无提示但在播放 → 封面 + 歌名/歌手 + 播放控制 + 打开播放器
 * 3. **空闲**：什么都不渲染（**不占位** —— 空气里挂个空胶囊比不显示更怪）
 */
export function DynamicIsland() {
  const toast = useToastsFromBus();

  // 播放态数据。⚠️ 订阅粒度要细：订阅 `queue` 整个数组会让每次入队/出队都重渲染这里。
  const currentSong = useMusicStore((s) => s.currentSong);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const hasQueue = useMusicStore((s) => s.queue.length > 0);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const setExpanded = useMusicStore((s) => s.setExpanded);

  // 退场动画：把"即将消失"与"已经消失"分开，否则卸载即消失、没有收尾动画。
  // 用 setTimeout 而非 transitionend —— 后者要等浏览器派事件，元素一旦被条件渲染
  // 卸载就收不到，动画会被截断。
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);

  // 有新提示进来时取消退场（否则会把刚来的提示一起关掉）
  useEffect(() => {
    if (toast && leaving) setLeaving(false);
  }, [toast, leaving]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const requestClose = () => {
    if (!toast) return;
    setLeaving(true);
    // 260ms 与 app.css 里 `.di-capsule.is-leaving` 的退场时长一致 —— 两处必须一致，
    // 否则动画被截断（早退会看不见收尾，晚退则胶囊悬着不走）
    timer.current = window.setTimeout(() => {
      toastBus.dismiss(toast.id);
      setLeaving(false);
    }, 260);
  };

  // 「打开播放器」：展开全屏播放器（对应参考实现携带 expandPlayer 标记跳转到音乐页）
  const openPlayer = () => setExpanded(true);

  if (!toast && !hasQueue) return null;
  if (leaving && !toast) return null;

  return (
    <div className="di-wrap">
      <div
        className={
          'di-capsule ' +
          (toast ? 'is-toast' : 'is-now-playing') +
          (leaving ? ' is-leaving' : '')
        }
      >
        {toast ? (
          <>
            <span className={'di-dot di-dot-' + toast.kind} aria-hidden="true" />
            <div className="di-text">
              <b className="di-title">{toast.text}</b>
            </div>
            <IconButton title="关闭提示" onClick={requestClose}>
              <X size={12} />
            </IconButton>
          </>
        ) : (
          <>
            <span className="di-cover" aria-hidden="true">
              <span className="di-eq" data-on={isPlaying ? '1' : '0'} />
            </span>
            <div className="di-text">
              <b className="di-title">{currentSong?.name ?? '未在播放'}</b>
              <span className="di-sub">{currentSong?.artist ?? ''}</span>
            </div>
            <IconButton title={isPlaying ? '暂停' : '播放'} primary onClick={() => togglePlay()}>
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
            </IconButton>
            <IconButton title="打开播放器" onClick={openPlayer}>
              <span className="di-open" aria-hidden="true" />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}
