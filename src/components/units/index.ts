/**
 * 公共单元（units）的统一出口。
 *
 * ## 这里放什么
 * **不依赖业务数据层**的 UI 单元 —— 判据是「本目录下的文件不 import
 * `music/store`、`music/ipc`、`music/types`、`music/platform`、根 `hooks`、`ipc`、`types`」，
 * 与"被几个地方用到"无关：后者决定**收益**，前者决定**归属**。
 *
 * 规则与判据见《09-技术方案-ver2.0-最终版》§2.2；这条"不得 import 业务层"
 * 由 `npm run task -- check:units` 机器核查（不是靠自觉）。
 *
 * ## 为什么用桶文件
 * 调用方只记一个路径（`components/units`），组件在 units 内部怎么拆分是内部事
 * —— 把 `Select.tsx` 拆成 `Select/Trigger.tsx` 时，二十个调用点一行都不用改。
 *
 * ## 什么不放这里
 * - 有业务语义的组件（`Sidebar` / `Toolbar` / `ViewTabs` / `QuitConfirm`）→ `components/`
 * - 只在单一屏内成立的排版件（设置页的 `Row` / `SubTitle` / `PendingRow`）→ 留在该屏目录
 * - 音乐语义的行（`SongRow` / `Cover`）→ 留在 `screens/music/shared.tsx`
 */
export { Badge, Btn, Dot, MagicCircle, Pill } from '@components/units/atoms';
export { ContextMenu, MenuSeparator } from '@components/units/ContextMenu';
export { ColorPicker } from '@components/units/ColorPicker';
export { Empty } from '@components/units/Empty';
export { ErrorState } from '@components/units/ErrorState';
export { IconButton } from '@components/units/IconButton';
export { MenuButton, MenuItem } from '@components/units/MenuButton';
export { Modal } from '@components/units/Modal';
export { Notice } from '@components/units/Notice';
export { NumberInput } from '@components/units/NumberInput';
export { PlayModeButton } from '@components/units/PlayModeButton';
export { ProgressRing } from '@components/units/ProgressRing';
export { Range } from '@components/units/Range';
export { Select } from '@components/units/Select';
export { Skeleton } from '@components/units/Skeleton';
export { Swatches } from '@components/units/Swatches';
export { Switch } from '@components/units/Switch';
export { Tooltip } from '@components/units/Tooltip';
export { ROW_GAP, ROW_H, VirtualList } from '@components/units/VirtualList';
