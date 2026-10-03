import { Badge } from '../components/atoms';

/**
 * 音乐应用占位屏 —— ver2.0 新增，**当前不实现播放功能**。
 *
 * ## 为什么先立一个诚实的占位屏
 *
 * 侧栏加了「音乐」入口后，它必须**立刻有落点**。若做成空按钮或点了没反应，
 * 用户会以为应用坏了 —— 一个坏掉的入口比没有入口更伤。占位屏把三件事说清楚：
 * 做什么、现在到哪了、什么时候能听。
 *
 * ## 刻意不做的事
 *
 * - **不加 Tab**：音乐 1:1 还原参考实现，内部本就是「顶行 + 左右 50/50 + 底部播放条」
 *   自成一个工作区（《09》§3.3）。加 Tab 会与左栏 4 视图 / 右栏 3 视图的层级打架。
 * - **不预置假数据**：不放假的歌曲列表。占位就是占位，列一堆假歌比空页更像在开发。
 * - **不接服务**：音乐走 Rust 音乐模块（网易云/酷狗/QQ/咪咕 + 本地代理），
 *   那是 M1 之后的事。此屏不发起任何网络请求。
 *
 * ## 重要：不受服务未就绪拦截
 *
 * 翻译引擎未就绪时，音乐屏**照常可用**（`isBlockedWhenNotReady` 里音乐屏开例外）。
 * 引擎是翻译的专属依赖，与音乐无关 —— 这正是把 IA 拆成两级要换来的独立性。
 */
export function MusicScreen() {
  return (
    <div className="music-placeholder">
      <div className="card section">
        <div className="section-title">音乐 · ver2.0 新增应用</div>
        <div className="notice">
          这一层是 ver2.0 的第二个独立应用 —— 侧栏把它与「漫画翻译」平级放置，
          而不再作为翻译流程里的一步。设计上 1:1 还原参考实现：左栏「我的音乐」四视图、
          右栏推荐/榜单三视图、底部常驻播放条、展开播放器六款皮肤。
        </div>
        <div className="notice">
          <b>当前状态：</b>播放内核尚未开始实现（M1 起）。这一屏是占位，
          不联网、不读本地音频、不展示任何假数据。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge>本地播放</Badge>
          <Badge>网易云</Badge>
          <Badge>酷狗</Badge>
          <Badge>QQ</Badge>
          <Badge>咪咕</Badge>
        </div>
      </div>

      <div className="card section">
        <div className="section-title">与翻译服务的关系</div>
        <div className="notice">
          <b>互不阻塞。</b>音乐屏不受翻译引擎的就绪状态影响 —— 即使引擎未启动，
          切换到音乐这一屏依然照常显示。反过来也一样：音乐播放不会占用翻译队列。
          这正是把信息架构从「平级四入口」拆成「两级」换来的东西。
        </div>
      </div>
    </div>
  );
}
