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
 * 心动模式当前是否可用由调用方按 `heartbeatAvailable` 传进来（判据仍在 store 的
 * `canUseHeartbeat` 这一个出口），UI 只负责"不可用时别把这一档显示出来"。
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

/** 可选的循环顺序（与 store.cycleMode 的 order 数组同序） */
const CYCLE_ORDER = ['list', 'one', 'shuffle', 'order', 'heartbeat'] as const;

export function PlayModeButton({
  mode,
  onCycle,
  size = 16,
  heartbeatAvailable = true,
}: {
  mode: keyof typeof META;
  onCycle: () => void;
  size?: number;
  /**
   * 心动模式当前是否可用（默认真 = 无条件显示，仅供不关心该门禁的调用方）。
   *
   * 不可用时**不显示**这一档 —— 不是"显示了但点了没反应"、也不是"按一下弹提示"。
   * 后两者都是假控件：用户看到心跳图标会以为当前在心动模式，
   * 而实际行为是另一档，界面与行为自相矛盾且不报错。
   */
  heartbeatAvailable?: boolean;
}) {
  // 当前档不可用时的回落目标：跳过心动，取它在循环顺序里的**前一档**
  // （'heartbeat' 的前一档是 'order'）—— 与 cycleMode 跳过它的落点保持一致，
  // 免得"按钮显示 order、点一下却到 shuffle"这种对不上的状态。
  const shownMode =
    mode === 'heartbeat' && !heartbeatAvailable ? CYCLE_ORDER[CYCLE_ORDER.indexOf('heartbeat') - 1] : mode;
  const { title, Icon } = META[shownMode] ?? META.order;
  return (
    <IconButton title={title} onClick={onCycle}>
      <Icon size={size} />
    </IconButton>
  );
}
