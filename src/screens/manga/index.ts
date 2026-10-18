/**
 * 漫画翻译应用的屏层出口 —— 三视图屏 + 服务未就绪屏。
 *
 * ## 为什么三屏收在一个目录
 * `drop` / `queue` / `library` 是**同一个应用**的三个视图（`TRANSLATE_VIEWS`），
 * 屏内件本来就跨视图共用：`NotReadyScreen` 是投放视图的未就绪形态，
 * `assembly` / `AssemblyTimeline` 是装配阶段的共享件。按视图各立一目录会让这些
 * 共用件无处安放，也与 `screens/anime/` 这类「一应用一目录」的形态错位。
 *
 * ⚠️ 屏文件名与视图 id（`drop` / `queue` / `library`）**刻意保持同名**：它们是深链值
 * 与 `check:ia` 的断言对象，改名等于改 URL。
 */
export { DropScreen } from './DropScreen';
export { LibraryScreen } from './LibraryScreen';
export { NotReadyScreen } from './NotReadyScreen';
export { QueueEmpty, QueueTable } from './QueueScreen';
