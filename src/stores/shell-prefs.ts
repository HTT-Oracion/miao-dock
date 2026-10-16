/**
 * 壳层偏好 —— 两件：**侧栏要不要显示文字标签**（台账 D-84）、
 * **翻译服务要不要随应用自动启动**（台账 D-94）。
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
 * ⚠️ 「自动启动翻译服务」看着更像"翻译域"的偏好，但它**没有**独立的翻译偏好模块：
 * 翻译侧的配置全在**服务端**（`/engine/options` 那一套，改完要重启引擎），
 * 唯独这一项是**客户端的启动策略**、由 Rust 的 `ServiceManager` 执行 ——
 * 它是壳层行为，不是服务端配置。所以归这里，与侧栏标签并列。
 *
 * ## 存储格式刻意用 `'1'` / `'0'`，不用 JSON、不用 `'true'`
 *
 * `localStorage` 是**外部可改且跨版本存活**的边界（用户手改、旧版本残留）。
 * 用窄枚举 + 明确回落，取值只有三种可能："开 / 关 / 没写过"，
 * 而"没写过"必须回落到**当前界面的既有形态**（显示标签 / 自动启动），
 * 否则老用户升级后侧栏会凭空少一行字、或者服务不再自动起来 ——
 * 那是"改了个默认值"却不告诉任何人。
 */

const SIDEBAR_KEY = 'miao.sidebar-labels';
const AUTO_START_KEY = 'miao.service-auto-start';

/**
 * 侧栏是否显示文字标签。**默认 true**（显示）—— 与升级前的界面完全一致。
 *
 * 只有明确写过 `'0'` 才是关（用户主动去过设置页关掉它）。其余一切（缺键、
 * 空串、旧版本残留的别的写法）都当"没写过"，回落到显示。
 */
export function initialSidebarLabels(): boolean {
  return localStorage.getItem(SIDEBAR_KEY) !== '0';
}

export function persistSidebarLabels(on: boolean): void {
  localStorage.setItem(SIDEBAR_KEY, on ? '1' : '0');
}

/**
 * 翻译服务是否**随应用自动启动**。**默认 true**（自动启动）—— 与升级前的行为完全一致。
 *
 * 只有明确写过 `'0'` 才是关。判据同 `initialSidebarLabels`。
 *
 * 语义（谁读它、什么时候读到，都在这两处）：
 *   · `App.tsx` 的 `autoStart` —— 进入「漫画翻译」应用时据此决定要不要拉服务；
 *   · `catalog.ts` 的「自动启动翻译服务」项 —— 设置页据此渲染开关。
 * 值本身只住在这里，两处读的是**同一份**，不存在两个真值来源。
 */
export function initialServiceAutoStart(): boolean {
  return localStorage.getItem(AUTO_START_KEY) !== '0';
}

export function persistServiceAutoStart(on: boolean): void {
  localStorage.setItem(AUTO_START_KEY, on ? '1' : '0');
}
