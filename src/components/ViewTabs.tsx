import { VIEW_TABS } from '@/themes/tokens';
import { ListMinus, BookText, FolderUp, Folder } from 'lucide-react';
import { TRANSLATE_VIEWS, type TranslateView } from '@/stores/nav';

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
 *
 * 顺序是断言对象（C9）：改这里必须同时改 `TRANSLATE_VIEWS`，且 C9 会变红。
 * 类名同时保留 `.viewtabs .viewtab` 锚点与 ver3 的 `.view-tabs .view-tab` 结构，
 * 断言与视觉因此不需要二选一。
 *
 * 右侧说明条只展示**已存在的真实参数**：每批上限、串行策略、库根目录。
 * 不写演示数据 —— 队列数量来自壳层的真实任务统计。
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
    <div className="viewtabs" style={{ height: VIEW_TABS.height }} role="tablist" aria-label="漫画翻译视图">
      <div className="view-tabs">
        {TRANSLATE_VIEWS.map((v) => {
          const Icon = ICONS[v.id];
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              title={v.hint}
              className={view === v.id ? 'viewtab view-tab is-active' : 'viewtab view-tab'}
              style={{ minWidth: VIEW_TABS.itemMinWidth, padding: `0 ${VIEW_TABS.itemPaddingX}px` }}
              onClick={() => onView(v.id)}
            >
              <Icon />
              <span>{v.label}</span>
            </button>
          );
        })}
      </div>
      <div className="view-tab-aside">
        {view === 'queue' && queueCount > 0 ? (
          <span className="tab-count" title={`队内 ${queueCount} 个任务`}>
            {queueCount}
          </span>
        ) : null}
        {aside}
      </div>
    </div>
  );
}
