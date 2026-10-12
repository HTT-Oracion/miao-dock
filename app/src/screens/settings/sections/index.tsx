// 设置页的 5 个 Section —— D-150 从单文件 `sections.tsx`（1225 行）按组件拆出。
//
// 桶文件让外部引用路径（`@screens/settings/sections`）**保持不变**：`SettingsScreen.tsx` 无需改动。
// `shared.tsx` 收 `itemOf` / `Group`（各 Section 共用），不对外导出。
export { GeneralSection } from './GeneralSection';
export { TranslateSection } from './TranslateSection';
export { MediaSection } from './MediaSection';
export { ResourceSection } from './ResourceSection';
export { AboutSection } from './AboutSection';
