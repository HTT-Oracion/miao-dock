/**
 * 屏装配件的分派（B1 改造的产物）。
 *
 * `routes.ts` 只回答"这个路径属于哪一屏"，这里回答"那一屏渲染哪个组件"。
 * 两者分开：加一屏要改的是这张表与路由表两处，而不是散在渲染分支里。
 */
import type { ReactElement } from 'react';
import type { Screen } from '@/stores/nav';
import { TranslatePane } from '@/router/panes/TranslatePane';
import { MusicPane } from '@/router/panes/MusicPane';
import { AnimePane } from '@/router/panes/AnimePane';
import { SettingsPane } from '@/router/panes/SettingsPane';

/** 壳层屏 → 屏装配件（键 = `Screen`，即 `stores/nav.ts` 的 IA 事实源） */
export const SCREEN_PANES: Record<Screen, () => ReactElement> = {
  translate: TranslatePane,
  music: MusicPane,
  anime: AnimePane,
  settings: SettingsPane,
};

/** 路由元素用：按屏取装配件。`pane` 与 `screen` 同名同义，只是这里强调"渲染"这一面 */
export function ScreenPane({ pane }: { pane: Screen }) {
  const Pane = SCREEN_PANES[pane];
  return <Pane />;
}
