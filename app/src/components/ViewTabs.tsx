/*
 * @Author: lvjinbin lvjinbin@skieer.com
 * @Date: 2026-10-04 03:47:27
 * @LastEditors: lvjinbin lvjinbin@skieer.com
 * @LastEditTime: 2026-10-04 13:18:16
 * @FilePath: /miao-dock/app/src/components/ViewTabs.tsx
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { VIEW_TABS } from '../theme/tokens';
import { ListMinus, BookText, FolderUp } from 'lucide-react';
import { TRANSLATE_VIEWS, type TranslateView } from '../nav';

/** 每个视图一个图标（顺序与 `TRANSLATE_VIEWS` 一致，不在这里另定一套） */
const ICONS: Record<TranslateView, () => React.ReactElement> = {
  drop: () => <FolderUp size={16} />,
  queue: () => <ListMinus size={16} />,
  library: () => <BookText size={16} />,
};

/**
 * 漫画翻译应用内的**视图 Tab 行**（《09》§3.2）—— ver2.0 新增。
 *
 * 44px 高，贴在工具条下方。三个 Tab 恒为 `TRANSLATE_VIEWS` 的顺序 ——
 * 投放（输入）→ 队列（处理）→ 漫画库（产出），即真实工作流时序。
 * ver1.0 把这三个入口平铺在侧栏且顺序与工作流逆序，本轮一并纠正。
 *
 * ⚠️ 顺序是断言对象（C9）：改这里必须同时改 `TRANSLATE_VIEWS`，
 * 且 C9 会变红。不要为了"看起来更合理"在本组件里重排。
 */
export function ViewTabs({
  view,
  onView,
}: {
  view: TranslateView;
  onView: (v: TranslateView) => void;
}) {
  return (
    <div className="viewtabs" style={{ height: VIEW_TABS.height }} role="tablist" aria-label="漫画翻译视图">
      {TRANSLATE_VIEWS.map((v) => {
        const Icon = ICONS[v.id];
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            title={v.hint}
            className={view === v.id ? 'viewtab is-active' : 'viewtab'}
            style={{ minWidth: VIEW_TABS.itemMinWidth, padding: `0 ${VIEW_TABS.itemPaddingX}px` }}
            onClick={() => onView(v.id)}
          >
            <Icon />
            <span>{v.label}</span>
          </button>
        );
      })}
    </div>
  );
}
