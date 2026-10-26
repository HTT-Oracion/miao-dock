import type { ReactNode } from 'react';
import { Btn } from '@components/units/Btn';

/** 一个视图页签：`id` 是写回的值，`label` 是页签上的字。 */
export interface ViewTabItem<T extends string> {
  id: T;
  label: string;
  /** 悬停提示（可选）；不传则不加 `title` */
  hint?: string;
}

/**
 * 视图页签组（设计稿 `.view-tabs` / `.ms-tabs` 的**同一套**形态）。
 *
 * ## 为什么是公用单元
 *
 * 漫画翻译的「投放 / 队列 / 漫画库」与音乐左栏的「歌单 / 本地 / 历史」是**同一个控件**：
 * 一排互斥页签、当前项浮起、点一下换视图。此前两处各写一套
 * （`.viewtab` / `.ms-tab`），于是圆角、内衬、选中态各自漂移 ——
 * 设计稿里它们本来就同形（`theme.css:152-176` 一套选择器管两处）。
 *
 * ## 与 `Segmented` 的分工（别互相顶替）
 *
 * | | `Segmented` | `ViewTabs` |
 * |---|---|---|
 * | 语义 | `role="group"` + `aria-pressed` | `role="tablist"` + `role="tab"` + `aria-selected` |
 * | 场合 | **选项**（歌词高亮方式、配色…） | **视图切换**（换掉下面一整块内容） |
 * | 尺寸 | `.ui-seg`（紧凑） | `.ui-vtabs`（成条，可带计数徽标） |
 *
 * 判据是「点它之后**下面那一整块**会不会换」：会换就是页签，不换就是选项。
 * 用 `Segmented` 做视图切换，读屏听到的是"一组按下的按钮"，而不是"当前在第几个页签"。
 *
 * ## 形态要点（设计稿 `theme.css:152-176` 的生效值）
 *
 * - 外壳是**白面 + 1px 描边 + 轻投影**，圆角 `--miao-r-full`（整条读作一枚胶囊）；
 * - 内衬 4px、`gap: 2px`、每格 `height: 32px`；
 * - 选中格 `primary-soft` 底 + `primary-ink` 字（**不是**白面 + 阴影 —— 白面会在白外壳上消失）；
 * - 悬停换 `surface-2` 底，按下 `scale(0.96)`。
 *
 * 类名走 `ui-` 前缀（`components/units/` 的硬规则）。
 */
export function ViewTabs<T extends string>({
  value,
  items,
  onChange,
  label,
  /** 页签右侧的说明条（可选）：漫画屏放"每批 20 张"、库根目录这类上下文 */
  aside,
  /** 按页签 id 给的计数徽标（可选）：如队列的待办条数 */
  countOf,
}: {
  value: T;
  items: readonly ViewTabItem<T>[];
  onChange: (v: T) => void;
  /** 这一组的可及性名字（`role="tablist"` 的 label） */
  label: string;
  aside?: ReactNode;
  countOf?: (id: T) => number | undefined;
}) {
  return (
    <div className="ui-vtabbar">
      <div className="ui-vtabs" role="tablist" aria-label={label}>
        {items.map((it) => {
          const on = it.id === value;
          const n = countOf?.(it.id);
          return (
            <Btn
              key={it.id}
              kind="bare"
              role="tab"
              ariaSelected={on}
              title={it.hint}
              className={on ? 'ui-vtab is-active' : 'ui-vtab'}
              onClick={() => onChange(it.id)}
            >
              <span>{it.label}</span>
              {/* 计数徽标嵌在页签内（不是丢到说明条）：它是这一页自己的待办量 */}
              {n != null && n > 0 ? (
                <span className="ui-vtab-count" title={`${n} 个待办`}>
                  {n}
                </span>
              ) : null}
            </Btn>
          );
        })}
      </div>
      {aside ? <div className="ui-vtab-aside">{aside}</div> : null}
    </div>
  );
}
