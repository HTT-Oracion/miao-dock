// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import { Info } from 'lucide-react';
import type { LibraryResponse } from '@/types';
import { GroupNote, PendingRow, SubTitle } from '@screens/settings/parts';
import { RESOURCE } from '@screens/settings/catalog';
import type { SettingItem } from '@screens/settings/catalog';
import { StorageBlock } from '@screens/settings/StorageBlock';
import { itemOf } from './shared';

/**
 * ④ 资源与投放 —— 2 项，两张卡。
 *
 * live：存储占用（三行分列，**不合计**）· pending：临时文件（等服务侧两条接口）。
 *
 * ## 为什么拆成两张卡而不是一张两行
 *
 * 设计稿把「存储占用」与「清理」分成两张卡：前者是**读数**（占了多少、在哪儿），
 * 后者是**动作**（能清什么）。合在一张卡里，那个「待接入」的临时文件行会读成
 * "存储占用的第四行"，而它其实属于另一件事。
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
      {/* 组说明缺省即不渲染（GroupNote 自守）：catalog 未给 RESOURCE.note 时这一行自动消失 */}
      <GroupNote summary={RESOURCE.noteSummary}>{RESOURCE.note as string}</GroupNote>

      {/* 卡一：存储占用（三行分列） */}
      <div className="set-group">{render(storage)}</div>

      {/* 卡二：清理（只放"能安全重建"的动作，缺接口的如实标待接入） */}
      <div className="set-group">
        <SubTitle head="只处理可以安全重建的数据">清理</SubTitle>
        <PendingRow item={itemOf(g, 'temp-files')} />
      </div>

      {/* 收尾说明：投放规则不在设置里，免得用户翻遍设置找"每批多少张" */}
      <div className="set-note-inline">
        <Info size={13} />
        <span>投放规则（每批 20 张、其余自动排队）不在设置里 —— 那是规则，不是参数。</span>
      </div>
    </>
  );
}
