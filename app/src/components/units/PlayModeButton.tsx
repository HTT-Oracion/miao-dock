import { Heart, Repeat, Repeat1, Shuffle } from 'lucide-react';
import { IconButton } from '@components/units/IconButton';

/**
 * 播放模式循环按钮（四档：列表 → 随机 → 单曲 → 心动）。
 *
 * ## 为什么抽到 units
 * 播放条与展开播放器此前各写一份完全相同的 modeIcon 三元表达式 —— 改一个档位要改两处，
 * 漏一处就会出现"展开播放器显示随机、播放条显示列表"的自相矛盾。
 * 判据符合《09》§2.2：不 import 业务数据层（mode 值由调用方传入，本组件不认识 store）。
 *
 * ## 为什么不接收 store
 * 传 `mode` + `onCycle` 两个 prop，而不是内部 `useMusicStore` ——
 * 那样它就会 import 业务层，units 的纯净性判据（不依赖业务数据）当场破掉。
 */
const META = {
  list: { title: '列表循环', Icon: Repeat },
  shuffle: { title: '随机播放', Icon: Shuffle },
  one: { title: '单曲循环', Icon: Repeat1 },
  // 心动模式：播完按当前歌曲找相似续播（仅网易云可得，其余平台降级为随机）
  heartbeat: { title: '心动模式', Icon: Heart },
} as const;

export function PlayModeButton({
  mode,
  onCycle,
  size = 16,
}: {
  mode: keyof typeof META;
  onCycle: () => void;
  size?: number;
}) {
  const { title, Icon } = META[mode] ?? META.list;
  return (
    <IconButton title={title} onClick={onCycle}>
      <Icon size={size} />
    </IconButton>
  );
}
