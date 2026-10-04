/**
 * 左栏 5 个分组导航项的图标 —— 18px（《09》§4.1 `navItemIcon`）。
 *
 * 刻意**不复用侧栏应用层入口那批 20px 图标**：那批是
 * 58×52 命中区的规格配套，放大/缩小到 18 会让描边粗细看起来与侧栏不一致，
 * 而两处挨得很近。同一份视觉语言里出现两种描边粗细，比统一放大更刺眼。
 *
 * 沿用同一套 24×24 网格 + 1.6 描边，只改画布尺寸 —— 于是同一枚图标在
 * 两个层级里形状完全一致，读者只会读到"大小不同"这个刻意的层级差。
 */
import type { SectionId } from '@screens/settings/catalog';
import { FolderKanban, Info, Languages, Activity, SlidersHorizontal } from 'lucide-react';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const S = 18;

const wrap = (children: React.ReactNode) => (
  <svg width={S} height={S} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    {children}
  </svg>
);

/** ① 通用：齿轮外的圆 + 一支指针 —— 「全局偏好」而非某个具体功能 */
export const IconSectionGeneral = () =>
  wrap(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M17.3 6.7l-1.4 1.4M8.1 15.9l-1.4 1.4" />
    </>,
  );

/** ② 翻译服务：书页 + 箭头 —— 与侧栏 `IconTranslate` 同一母题，缩到 18 */
export const IconSectionTranslate = () =>
  wrap(
    <>
      <path d="M4.5 5.5h9v13h-9z" />
      <path d="M16.5 9.5L20 13l-3.5 3.5" />
    </>,
  );

/** ③ 播放·媒体：音符 —— 音乐屏的最小记号 */
export const IconSectionMedia = () =>
  wrap(
    <>
      <path d="M9.5 17.5V7l9-1.8V15" />
      <circle cx="7" cy="17.5" r="2.5" />
      <circle cx="16" cy="15" r="2.5" />
    </>,
  );

/** ④ 资源与投放：文件夹 —— 磁盘上那些东西 */
export const IconSectionResource = () =>
  wrap(
    <>
      <path d="M3.5 8.5A1.5 1.5 0 015 7h4l2 2.2h7A1.5 1.5 0 0119.5 10.7V17A1.5 1.5 0 0118 18.5H6A1.5 1.5 0 014.5 17z" />
    </>,
  );

/** ⑤ 关于：圆 + i —— 唯一不需要图形语义的一组 */
export const IconSectionAbout = () =>
  wrap(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none" />
    </>,
  );

export const SECTION_ICON: Record<SectionId, (props?: any) => React.ReactElement> = {
  general: (props) => <SlidersHorizontal {...(props || {}) } />,
  translate: (props) => <Languages {...(props || {}) } />,
  media: (props) => <Activity {...(props || {}) } />,
  resource: (props) => <FolderKanban {...(props || {}) } />,
  about: (props) => <Info {...(props || {}) } />,
};
