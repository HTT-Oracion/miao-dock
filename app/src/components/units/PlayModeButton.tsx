import { Heart, ListEnd, Repeat, Repeat1, Shuffle } from 'lucide-react';
import { IconButton } from '@components/units/IconButton';

/**
 * 播放模式循环按钮（五档，点击即切下一档）。
 *
 * 档位顺序与图标：列表循环（Repeat）→ 单曲循环（Repeat1）→ 随机播放（Shuffle）
 * → 顺序播放（ListEnd）→ 心动模式（Heart）。
 *
 * ## 为什么抽到 units
 * 播放条与展开播放器此前各写一份完全相同的 modeIcon 三元表达式 —— 改一个档位要改两处，
 * 漏一处就会出现"展开播放器显示随机、播放条显示列表"的自相矛盾。
 * 判据符合《09》§2.2：不 import 业务数据层（mode 值由调用方传入，本组件不认识 store）。
 *
 * ## 为什么不接收 store
 * 传 `mode` + `onCycle` 两个 prop，而不是内部 `useMusicStore` ——
 * 那样它就会 import 业务层，units 的纯净性判据（不依赖业务数据）当场破掉。
 * 心动模式当前是否可用也**不在这里判**：本组件是"切下一档"的循环按钮，
 * 判据在 store 的 cycleMode（不可用就跳过该档并提示），UI 只负责显示当前档位。
 */
const META = {
  list: { title: '列表循环', Icon: Repeat },
  one: { title: '单曲循环', Icon: Repeat1 },
  shuffle: { title: '随机播放', Icon: Shuffle },
  // 顺序播放用 ListEnd（"播到列表末尾就停"），与列表循环的 Repeat 在视觉上区分开：
  // 两者中间部分行为完全相同，差别只在末尾 —— 图标必须能表达"会不会回到开头"
  order: { title: '顺序播放', Icon: ListEnd },
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
  const { title, Icon } = META[mode] ?? META.order;
  return (
    <IconButton title={title} onClick={onCycle}>
      <Icon size={size} />
    </IconButton>
  );
}
