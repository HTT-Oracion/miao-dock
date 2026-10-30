import { Folder } from 'lucide-react';
import { TRANSLATE_VIEWS, type TranslateView } from '@/stores/nav';
import { ViewTabs as ViewTabsUnit, type ViewTabItem } from '@components/units';

/**
 * 页签清单：直接从 `TRANSLATE_VIEWS` 派生（顺序是断言对象 C9），
 * 这里不再维护第二份"哪个视图叫什么"。
 */
const ITEMS: readonly ViewTabItem<TranslateView>[] = TRANSLATE_VIEWS.map((v) => ({
  id: v.id,
  label: v.label,
  hint: v.hint,
}));

/**
 * 漫画翻译应用内的**视图 Tab 行**（《09》§3.2）。
 *
 * 2026-10-26：本体下沉成通用单元 `components/units/ViewTabs.tsx`
 * —— 音乐左栏的 `.ms-tabs` 是同一个控件，两处各写一套必然漂移
 * （设计稿 `theme.css:152-176` 本来就用同一套选择器管两处）。
 *
 * 本文件只保留**漫画屏特有的接线**：
 *   · 页签清单来自 `TRANSLATE_VIEWS`（顺序即工作流时序）；
 *   · 右侧说明条显示该视图的真实参数（每批上限 / 串行策略 / 库根目录）；
 *   · 队列页签带待办计数徽标。
 *
 * 说明条只展示**已存在的真实参数**，不写演示数据。
 */
export function ViewTabs({
  view,
  onView,
  queueCount = 0,
  rootDir = '',
}: {
  view: TranslateView;
  onView: (v: TranslateView) => void;
  /** 当前排队 + 翻译中的任务数（来自壳层任务列表） */
  queueCount?: number;
  /** 漫画库根目录（来自库接口或服务状态） */
  rootDir?: string;
}) {
  const aside =
    view === 'drop' ? (
      <span className="chip">每批 20 张 · 自动排队</span>
    ) : view === 'queue' ? (
      <span className="chip chip-accent">同一时刻只跑 1 个</span>
    ) : rootDir ? (
      <span className="chip" title={rootDir}>
        <Folder size={12} />
        <span className="truncate">{rootDir}</span>
      </span>
    ) : null;

  return (
    <div className="viewtabs">
      <ViewTabsUnit
        value={view}
        items={ITEMS}
        onChange={onView}
        label="漫画翻译视图"
        aside={aside}
        countOf={(id) => (id === 'queue' ? queueCount : undefined)}
      />
    </div>
  );
}
