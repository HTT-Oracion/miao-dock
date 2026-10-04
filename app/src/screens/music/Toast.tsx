import { useEffect } from 'react';
import { useMusicStore } from '@music/store';

/** 音乐模块轻提示：读 musicToast，展示 2.5s 后自动清空（清空走 store action，不额外留本地态） */
export function Toast() {
  const musicToast = useMusicStore((s) => s.musicToast);
  const clearToast = useMusicStore((s) => s.clearToast);

  useEffect(() => {
    if (!musicToast) return;
    const t = setTimeout(clearToast, 2500);
    return () => clearTimeout(t);
  }, [musicToast, clearToast]);

  if (!musicToast) return null;

  return (
    <div className={musicToast.type === 'success' ? 'music-toast is-success' : 'music-toast is-warning'}>
      {musicToast.message}
    </div>
  );
}
