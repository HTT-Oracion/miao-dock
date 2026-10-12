// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import type { LibraryResponse } from '@/types';
import { GroupNote } from '@screens/settings/parts';
import { RESOURCE } from '@screens/settings/catalog';
import type { SettingItem } from '@screens/settings/catalog';
import { StorageBlock } from '@screens/settings/StorageBlock';
import { Group } from './shared';

/**
 * ④ 资源与投放 —— 2 项。
 *
 * live：存储占用（三行分列，**不合计**）· pending：临时文件（等服务侧两条接口）。
 *
 * `render` 用 `switch` 而不是"给谁都渲染同一个块"：将来这一组再加一个 live 项时，
 * 忘记接线会**抛错**，而不是静默渲染成一块长得像那么回事的东西。
 */
export function ResourceSection({ lib }: { lib: LibraryResponse | null }) {
  const render = (item: SettingItem) => {
    switch (item.id) {
      case 'storage-usage':
        return <StorageBlock item={item} lib={lib} />;
      default:
        throw new Error(`[settings] ④ 资源与投放 有未接线的项：${item.id} —— catalog 与本组件不同步`);
    }
  };
  return (
    <>
      {/* 组说明缺省即不渲染（GroupNote 自守）：catalog 未给 RESOURCE.note 时这一行自动消失 */}
      <GroupNote summary={RESOURCE.noteSummary}>{RESOURCE.note as string}</GroupNote>
      <Group group={RESOURCE.groups[0]} render={render} />
    </>
  );
}

