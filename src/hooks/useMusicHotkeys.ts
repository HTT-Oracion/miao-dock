import { useEffect, useRef } from 'react';
import { useMusicStore } from '@music/store';

/**
 * 音乐模块键盘快捷键（应用内全局，**纯键盘入口，不含任何业务判断**）。
 *
 * ## 键位（拍板口径，不做增减）
 *
 * | 键 | 动作 |
 * |---|---|
 * | `Space` | 播放 / 暂停（`togglePlay`） |
 * | `⌘/Ctrl + ←` | 上一首（`prev`） |
 * | `⌘/Ctrl + →` | 下一首（`next`） |
 * | `↑` | 音量 + |
 * | `↓` | 音量 − |
 *
 * ## 为什么切歌方向键**必须带 ⌘/Ctrl**，裸方向键不调进度
 *
 * 裸 `←/→` 在本项目里有既有归属：漫画对照视图用它们翻页
 * （`screens/LibraryScreen.tsx` 的 `Compare`，监听裸 `ArrowLeft/ArrowRight`）。
 * 快捷键若认裸方向键，就是**在别的屏抢别人的键**——用户翻页翻不动了，
 * 而音乐那边什么也没发生。所以本 hook 只认带 ⌘/Ctrl 的组合，
 * 裸方向键一律不碰（也因此：本 hook 不实现"方向键调进度"）。
 *
 * ## 为什么这里只有"转发"，没有 if 业务分支
 *
 * 用户拍板「快捷键 = 与播放条按钮完全一致」，所以：
 *   - `⌘/Ctrl + →` 直接 `next()`，含心动模式"找相似续播"的行为；
 *   - `⌘/Ctrl + ←` 直接 `prev()`，沿用"第一首的上一首 = 最后一首"的循环语义。
 * 因此**不在快捷键层复刻任何 store 判断**（不判队列空、不判播放模式、不判平台）。
 * 判据只有一条：焦点是否该让位（见下）。这样"按钮与快捷键行为分叉"这条路被从结构上堵死——
 * 两边调用的是同一个 store action，谁改语义两边一起变。
 *
 * ## 归属：为什么是独立文件而不是塞进 MusicKernel
 *
 * D-41 规矩「`use*` 一律住 `src/hooks/`」（`check:units` 的 `HOOKS.noMisplacedUse` 按文件名守着），
 * 而本 hook 只依赖 store、不渲染任何东西，与 `useEsc` 同属「键盘/DOM 行为」一类，
 * 故单放同目录、经 `@hooks/useMusicHotkeys` 引入（同 `useEsc` / `useCoverColor` 的先例）。
 * 顺带的好处：MusicKernel 已经因为"整体搬家"扛了很重的说明性注释，
 * 再塞进一块与播放无关的键盘逻辑，会让那文件的职责边界糊掉。
 */

/**
 * 切歌连点的合并窗口（毫秒）。
 *
 * ## 只合并「手动连点」，不合并「按住不放」
 *
 * 拍板口径是"快捷键与播放条按钮完全一致"，而 `next()` 在**心动模式**下会去发网络请求
 * （`platform.similarSongs`，见 store 里 `next` 的 heartbeat 分支）。
 * 连按 `⌘+→` 就是连发请求 —— 用户以为在快速跳歌，实际是在刷接口。
 *
 * ⚠️ **只拦 `e.repeat === true`（按住不放产生的自动重复），手动连点全放行。**
 * 这两者必须分开，否则窗口大小怎么取都是错的：
 *   · 若一律去抖：手速 150ms 连点 3 下（想跳 3 首）会被吃掉 1 次 → **少跳一首**，
 *     用户会觉得"按了没反应"，比连发请求更糟；
 *   · 若一律放行：按住不放会以系统 repeat 速率（通常 30 次/秒）连发请求。
 * 所以窗口**只作用于系统自动重复**，且取 250ms（≈ 4 次/秒上限，够用又不至于刷爆）。
 *
 * ## 为什么音量**完全不去抖、也不看 `e.repeat`**
 *
 * 去抖是为了压住"一次意图触发多次副作用"，而音量恰恰相反：
 * `↑` 是**连续动作**（把音量从 20% 调到 60% 就是按 8 次），
 * 任何形式的合并都会让"快速连按 ↑"只生效一次，音量爬不上去。
 * `stepVolume` 本身幂等且无网络开销（只 `set` + `savePrefs`），
 * 连续执行不产生放大效应，所以手动连点与按住不放**都要放行**。
 *
 * ## 为什么用 `lastAt` 按键独立计时，不做"两次不同键互相取消"
 *
 * 用 `⌘+→` 连点两下再立刻 `⌘+←`，如果共用一个时间戳，
 * 第二次 `⌘+←` 会被上一串 `⌘+→` 的窗口吃掉 —— 那就变成"上一首按不动"，
 * 比原来的连发问题更糟。所以每个键各记各的（见下方 `lastAt`）。
 */
const TRACK_SWITCH_REPEAT_GUARD_MS = 250;

/**
 * 让位判据：命中任一即认为"焦点在可交互元素上"，本次按键**完全交给浏览器**。
 *
 * 逐类理由（哪一类都对应一种真实存在、且有用的原生行为）：
 *
 * ① `input` / `textarea` / `select` —— 打字与下拉选择。
 *    ⚠️ 音量滑块本身就是 `input[type=range]`：焦点停在滑块上时按 `↑/↓`，
 *    原生行为是按 `step` 微调（`PlayerBar` 里 `step={0.01}`）并触发 `onChange`。
 *    抢过来只会让"调音量"在同一个控件上有两套步长与两套口径。
 * ② `[contenteditable]` —— 可编辑区域（歌词/备注类就地编辑）。
 *    ⚠️ **排除 `contenteditable="false"`**：那恰恰是"不可编辑"的显式声明。
 * ③ `button` —— 空格在按钮上的原生行为是**点击该按钮**，这是无障碍与
 *    键盘用户的核心路径。播放条上排着一排 `IconButton`（`units/IconButton.tsx`，
 *    它就是真`<button>`）：不判断的话，用户会看到"我按了空格想暂停，
 *    结果播放/静音/切歌被点了一轮"。同理 `a[href]`（回车/空格激活链接）。
 * ④ ARIA 角色控件 —— `role="slider"` / `option` / `listbox` / `menuitem` / `tab` 等，
 *    它们**不是**原生可聚焦标签，判 `tagName` 抓不到，但键盘行为是真的。
 *    最要紧的是 `units/Select.tsx`（Radix Select）：弹层打开后
 *    `↑/↓` 是**在选项间移动焦点**（该组件注释里明写了"键盘 ↑↓ 是 Radix 的职责"）。
 *    抢过来就会在"选音质"时把音量一起调了。
 *
 * 为什么用 `closest` 而不是只读 `e.target.tagName`：
 * **焦点极可能落在控件内部的子元素上**，`e.target` 未必是那个控件本身。
 * 最典型的就是 `IconButton` —— 它把 lucide 的 `<svg>`（甚至 `<path>`）包在按钮里，
 * 事件 target 就是那个 `svg`/`path`，只比 `tagName` 的话会判成"不在按钮上"而**误劫持**。
 * 所以两者一起判：`tagName` 兜住裸标签，`closest` 兜住嵌套与 ARIA 角色。
 *
 * ⚠️ `closest` 走的是**祖先链**，所以 Radix 弹层那种 `Portal` 渲染到 `body` 下的
 * 结构同样能被它抓到（DOM 上是真实祖先），不依赖组件实现细节。
 */
const INTERACTIVE_SELECTOR = [
  // ① 可输入 / 可选择
  'input',
  'textarea',
  'select',
  // ② 可编辑区域。`contenteditable=""` / `"true"` / `"plaintext-only"` 都算可编辑，
  //    只有显式的 `"false"` 不可编辑，所以用 `:not()` 精确排除那一种。
  '[contenteditable]:not([contenteditable="false"])',
  // ③ 原生可激活控件
  'button',
  'a[href]',
  // ④ ARIA 角色控件（不是原生标签，只能靠属性判）
  '[role="button"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="option"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="menu"]',
  '[role="tab"]',
  '[role="tablist"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="scrollbar"]',
].join(',');

/** `e.target` 是否落在"该让位给原生行为"的元素里 */
function shouldYieldToNative(target: EventTarget | null): boolean {
  // 判据只对 Element 有意义（事件目标理论上可能是文本节点等）
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * 把快捷键挂到 `window` 上。
 *
 * ## 为什么监听 `window` 而不是 `document`
 *
 * 事件在冒泡阶段到达 `window`，而焦点元素是我们自己渲染出来的
 * （`IconButton`、`Select` 弹层…），挂 `window` 才不依赖"焦点恰好在哪棵子树上"。
 * 捕获阶段（`capture: true`）不必要：本 hook 只读事件、不消费，
 * 真正要 `preventDefault` 的那些键都在这里处理，不存在被别人抢先的问题。
 */
export function useMusicHotkeys() {
  /**
   * 每个切歌键的**上次被系统自动重复触发**的时刻（`performance.now()`）。
   * 用 ref 而不是 state：这是纯副作用，不需要触发重渲染。
   * 键独立计时，见 `TRACK_SWITCH_REPEAT_GUARD_MS` 的说明。
   */
  const lastAt = useRef<Record<string, number>>({});

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      /**
       * 让位判定**放在最前面**，且先于任何业务转发：
       * 焦点在可交互元素上时，本次按键原样交给浏览器
       * （`⌘/Ctrl + ←/→` 在输入框里是"按词跳转"，是**有用**的原生行为，不抢）。
       */
      if (shouldYieldToNative(e.target)) return;

      const s = useMusicStore.getState();
      // ⌘（mac）与 Ctrl（win/linux）在本 hook 里等价，不需要按平台分叉
      const mod = e.metaKey || e.ctrlKey;
      // 带 Shift 的组合键（`Shift+↑/↓` 之类）留给系统与窗口管理器。
      // ⚠️ 与裸键的收窄条件保持一致：注释说"带修饰键不抢"，判据就得真的把 Shift 算进去，
      // 否则 `Shift+↑` 会一边被系统处理、一边又把音量调了。
      const shift = e.shiftKey;

      /**
       * 合并**系统自动重复**：返回 true 表示"距上次 repeat 太近，本次丢弃"。
       *
       * ⚠️ **手动连点（`e.repeat === false`）一律放行**，只拦按住不放产生的自动重复。
       * 见 `TRACK_SWITCH_REPEAT_GUARD_MS` 的说明：一律去抖会让"手速快点 3 下"少跳一首，
       * 那比多发几次请求更糟。
       *
       * 只对**切歌**两个键调用 —— 音量必须每次都生效。
       */
      const autoRepeatBlocked = (key: string): boolean => {
        // 手动的一次按键：不是自动重复，直接放行且**不更新时间戳**
        // （否则长按之后紧接着的一次手动点击，会被误判成"还在自动重复"而吃掉）
        if (!e.repeat) return false;
        const now = performance.now();
        const prevAt = lastAt.current[key] ?? -Infinity;
        if (now - prevAt < TRACK_SWITCH_REPEAT_GUARD_MS) return true;
        lastAt.current[key] = now;
        return false;
      };

      /**
       * `preventDefault` 统一在"确实要处理"时才调。
       *
       * 为什么必须拦：`Space` 与方向键的原生默认行为是**滚动页面**，
       * 不拦就是"暂停的同时页面滚了一下"，观感很差。
       * 但让位的那些按键**不能拦** —— 拦了就等于把输入框/按钮的原生行为也一起废掉。
       */
      switch (e.key) {
        case ' ': {
          // 只认**裸空格**：带 ⌘/Ctrl/Alt/Shift 的空格是系统级快捷键（如 macOS 聚焦搜索、
          // 输入法切换），抢过来等于和系统打架。
          if (e.metaKey || e.ctrlKey || e.altKey || shift) return;
          e.preventDefault();
          s.togglePlay();
          return;
        }
        case 'ArrowUp': {
          // 裸 ↑ 才调音量：⌘/Ctrl/Alt/Shift + ↑ 留给系统与窗口管理器
          if (e.metaKey || e.ctrlKey || e.altKey || shift) return;
          e.preventDefault();
          /**
           * 步长与 clamp 口径**沿用既有实现**，不自己发明：
           * 播放条滚轮（`PlayerBar.tsx`）与展开播放器滚轮都用 `0.05`，
           * 边界由 store 的 `stepVolume` 统一夹到 0–1
           * （`setVolume` 另有"调到 >0 即解除静音"的语义），两条路径共用同一个 action。
           */
          s.stepVolume(0.05);
          return;
        }
        case 'ArrowDown': {
          if (e.metaKey || e.ctrlKey || e.altKey || shift) return;
          e.preventDefault();
          s.stepVolume(-0.05);
          return;
        }
        case 'ArrowLeft': {
          // ⚠️ **必须带 ⌘/Ctrl**：裸 ← 归漫画对照视图翻页（见文件头）
          if (!mod || e.altKey || shift) return;
          /**
           * ⚠️ `preventDefault` 在合并判断**之前**：
           * 被丢弃的这次按键，键位仍然属于本快捷键（不是"让位给原生"），
           * 所以照样要拦默认行为 —— 否则按住 `⌘+←` 时浏览器原生"后退"会跟着一起触发。
           * 拦的是**默认行为**，丢的只是**重复执行**，两者不是一回事。
           */
          e.preventDefault();
          if (autoRepeatBlocked('prev')) return;
          s.prev();
          return;
        }
        case 'ArrowRight': {
          if (!mod || e.altKey || shift) return;
          // 同上：先拦默认行为，再谈合并
          e.preventDefault();
          if (autoRepeatBlocked('next')) return;
          s.next();
          return;
        }
        default:
          // 其余按键一概不碰
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
