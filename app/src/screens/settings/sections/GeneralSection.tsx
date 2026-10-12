// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import type { RefObject } from 'react';
import type { ThemeMode } from '@/theme/tokens';
import { Switch } from '@components/units';
import { GroupNote, ReadOnly, Row, RowNote } from '@screens/settings/parts';
import { GENERAL } from '@screens/settings/catalog';
import { SpecCheckBlock, useSpecCheck } from '@screens/settings/SpecCheck';
import { itemOf } from './shared';

/**
 * ① 通用 —— 4 项，**全部 live**（台账 D-84）。
 *
 * 深色模式（真切换 `onMode`）· 关闭窗口行为（真行为：收起到托盘）· 规格自检（C 组断言）·
 * 侧栏图标标签（壳层偏好，真切换 `Sidebar` 的两种形态 —— 值住在 `shell-prefs.ts`）。
 */
export function GeneralSection({
  mode,
  onMode,
  sidebarLabels,
  onSidebarLabels,
  fixtureRef,
}: {
  mode: ThemeMode;
  onMode: (m: ThemeMode) => void;
  sidebarLabels: boolean;
  onSidebarLabels: (on: boolean) => void;
  fixtureRef: RefObject<HTMLDivElement>;
}) {
  const spec = useSpecCheck(fixtureRef, mode);
  const g = GENERAL.groups[0];
  const darkItem = itemOf(g, 'dark-mode');
  const specItem = itemOf(g, 'spec-check');

  return (
    <>
      <GroupNote summary={GENERAL.noteSummary}>{GENERAL.note as string}</GroupNote>
      <div className="set-group">
        <Row item={darkItem}>
          <Switch
            on={mode === 'dark'}
            onToggle={() => onMode(mode === 'dark' ? 'light' : 'dark')}
            label="深色模式"
          />
        </Row>

        <Row item={itemOf(g, 'close-window')}>
          <ReadOnly>收起到托盘</ReadOnly>
        </Row>
        <RowNote>
          关闭窗口只是把窗口收起来，托盘图标常驻。要真正退出请用托盘菜单里的「退出喵坞…」，届时会有二次确认。
        </RowNote>

        {/*
          规格自检：标题走 Row（与其它项对齐），运行器与结果走通栏。
          不塞进 Row 的右列 —— 35 条结果列表挤在控件列里没法读。
        */}
        <Row item={specItem} />
        <div className="set-row-note set-row-note-body">
          对离屏样张量取实际渲染尺寸与颜色，与设计常量逐一比对。
          CSS 里改错了数值，这里会立刻报红。
        </div>
        <SpecCheckBlock
          results={spec.results}
          revealed={spec.revealed}
          failed={spec.failed}
          onRun={spec.run}
        />

        {/*
          侧栏图标标签：**同一个 state 同时驱动两处**（`App` 的 `sidebarLabels`）——
          拨开关时侧栏同帧变，不需要重载、也不需要把偏好写进 DOM 再让 Sidebar 去读。
          这里刻意不自己读 localStorage：那样会造出第二个真值来源。
        */}
        <Row item={itemOf(g, 'sidebar-labels')}>
          <Switch
            on={sidebarLabels}
            onToggle={() => onSidebarLabels(!sidebarLabels)}
            label="侧栏图标标签"
          />
        </Row>
      </div>
    </>
  );
}

