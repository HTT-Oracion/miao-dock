/**
 * 壳层偏好 —— 目前只有一件：**侧栏要不要显示文字标签**（台账 D-84）。
 *
 * ## 为什么单独一个文件，而不是塞进 `theme/apply.ts` 或 music store
 *
 * · `theme/apply.ts` 管的是**颜色令牌**（深色模式）。把一个与主题无关的布局偏好塞进去，
 *   会让"换主题只走这一条路径"这条纪律变得含糊（《01》§9）。
 * · music store 是**音乐域**的偏好的家（音质/皮肤/歌词…）。侧栏属于壳层，
 *   和音乐毫无关系，写进去等于给音乐模块加一个它不该知道的键。
 *
 * 两者的共同点只有"都是一个布尔偏好" —— 这个共同点不足以共享一个文件。
 * 所以它是平级的第三个：外观类壳层偏好。
 *
 * ## 存储格式刻意用 `'1'` / `'0'`，不用 JSON、不用 `'true'`
 *
 * `localStorage` 是**外部可改且跨版本存活**的边界（用户手改、旧版本残留）。
 * 用窄枚举 + 明确回落，取值只有三种可能："开 / 关 / 没写过"，
 * 而"没写过"必须回落到**当前界面的既有形态**（显示标签），否则老用户升级后
 * 侧栏会凭空少一行字 —— 那是"改了个默认值"却不告诉任何人。
 */

const STORAGE_KEY = 'miao.sidebar-labels';

/**
 * 侧栏是否显示文字标签。**默认 true**（显示）—— 与升级前的界面完全一致。
 *
 * 只有明确写过 `'0'` 才是关（用户主动去过设置页关掉它）。其余一切（缺键、
 * 空串、旧版本残留的别的写法）都当"没写过"，回落到显示。
 */
export function initialSidebarLabels(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== '0';
}

export function persistSidebarLabels(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
}
