// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import type { ReactNode } from 'react';
import { PendingRow, Row, SubTitle } from '@screens/settings/parts';
import type { SettingGroup, SettingItem } from '@screens/settings/catalog';

/** 按 id 从小节里取项。id 写错是编程错误，宁可崩也不要静默渲染成空行 */
export function itemOf(g: SettingGroup, id: string): SettingItem {
  const hit = g.items.find((i) => i.id === id);
  if (!hit) throw new Error(`[settings] 小节 ${g.id} 里没有项 ${id} —— catalog 与本组件不同步`);
  return hit;
}

/** 整组小节按 catalog 顺序渲染；`live` 的项走 `render`，其余一律 PendingRow */
export function Group({
  group,
  render,
}: {
  group: SettingGroup;
  render?: (item: SettingItem) => ReactNode;
}) {
  return (
    <div className="set-group">
      {group.title ? <SubTitle>{group.title}</SubTitle> : null}
      {group.items.map((item) => {
        // 没给 render 的组就是"整组待接入"（③/④）。这里不做兜底渲染控件 ——
        // 想要控件就在 render 里显式写，写漏了只会看到 PendingRow，不会静默出假控件。
        if (item.state === 'pending' || !render) return <PendingRow key={item.id} item={item} />;
        /*
         * `layout: 'block'` 的项走通栏：内容自带完整布局（如「音乐缓存」的四格），
         * 再套一层 `Row` 就会多出一截标题 + 一个窄控件列，把它压成一条细缝。
         *
         * 这里仍然要求它有 `label` —— 由渲染方自己画（`CacheBlock` 的第一格就是它）。
         * 之所以不在 `Row` 里复用 `label`，是因为 `Row` 的语义是"标题左 / 控件右"，
         * 而通栏块里标题的位置由内容自己定，强行塞进去只会多一层嵌套。
         */
        if (item.layout === 'block') return <div key={item.id}>{render(item)}</div>;
        return <Row key={item.id} item={item}>{render(item)}</Row>;
      })}
    </div>
  );
}
