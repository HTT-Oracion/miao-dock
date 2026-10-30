// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import type { LibraryResponse } from '@/types';
import { GroupNote } from '@screens/settings/parts';
import { RESOURCE } from '@screens/settings/catalog';
import type { SettingItem } from '@screens/settings/catalog';
import { StorageBlock } from '@screens/settings/StorageBlock';
import { itemOf } from './shared';

/**
 * ④ 资源与投放 —— 1 项，1 张卡。
 *
 * live：存储占用（三行分列，**不合计**）。
 *
 * ## 2026-10-25 两次收缩（都源于"这一组在回答什么问题"）
 *
 * **「音乐缓存」不再单独成卡**：它原先是独立的一张通栏卡（合计 + 逐平台明细 +
 * 两个动作按钮）。问题是用户来这一组**先看到的是"占了多少"**，清理是顺带做的事 ——
 * 而独立卡把"怎么清"铺得比"占了多少"还大，读起来像两张同级的内容。
 * 现在收进「存储占用」的音乐缓存行内：行内只留总量与目录地址两个读数、
 * 加一个「删除」下拉（逐平台明细 + 删除全部），那正是"决定清哪个"时才需要的信息。
 *
 * **「清理」卡与投放规则脚注一并去掉**：临时文件那一行至今 `pending`
 * （服务侧没有列举与清理接口），放在这里只是占一个位置；投放规则那句是
 * "规则不在设置里"的自我说明，对用户没有信息量。两组都不再产生内容。
 * `temp-files` 项仍留在 catalog 里（`state: 'pending'` 是它的记账），
 * 但**不再渲染** —— 需要时把那张卡加回来即可。
 *
 * `render` 用 `switch` 而不是"给谁都渲染同一个块"：将来这一组再加一个 live 项时，
 * 忘记接线会**抛错**，而不是静默渲染成一块长得像那么回事的东西。
 */
export function ResourceSection({ lib }: { lib: LibraryResponse | null }) {
  const g = RESOURCE.groups[0];
  const storage = itemOf(g, 'storage-usage');

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
      {/* 存储占用（三行分列，音乐缓存的清理入口收在行内） */}
      <div className="set-group">{render(storage)}</div>
      {/* 组说明缺省即不渲染（GroupNote 自守）：catalog 未给 RESOURCE.note 时这一行自动消失 */}
      <GroupNote>{RESOURCE.note as string}</GroupNote>
    </>
  );
}
