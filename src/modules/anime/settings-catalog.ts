/**
 * 「番剧设置」八组 30 项的**唯一事实源**（设计稿 ⑥）。
 *
 * 为什么不并进 `screens/settings/catalog.ts`：那份是设置页自身的 5 组 34 项，
 * 项数合计被 C10/COUNT 双门钉着；番剧设置是**域内**设置（真实值住 `anime/prefs.ts`），
 * 归属不同层。两份目录各自可算合计，谁也不该被另一域的增项带着跳数。
 *
 * 控件形态五种 + 占位：「弹幕」是占位项（预留能力），**不渲染可点控件**。
 */
import type { AnimePrefs } from '@anime/prefs';

/** 控件描述：key 指向 `AnimePrefs` 字段（渲染层按 kind 分派） */
export type AnimeControl =
  | { kind: 'switch'; key: keyof AnimePrefs }
  | { kind: 'seg'; key: keyof AnimePrefs; options: { value: string | number; label: string }[] }
  | { kind: 'text'; key: keyof AnimePrefs; wide?: boolean; placeholder?: string }
  | { kind: 'number'; key: keyof AnimePrefs; unit: string }
  | { kind: 'buttons'; buttons: string[] }
  | { kind: 'placeholder'; note: string };

export interface AnimeSettingItem {
  id: string;
  label: string;
  why: string;
  /** 「默认：X」小字（不是当前值） */
  def?: string;
  control: AnimeControl;
}

export interface AnimeSettingGroup {
  id: string;
  title: string;
  items: AnimeSettingItem[];
}

export const ANIME_SETTING_GROUPS: AnimeSettingGroup[] = [
  {
    id: 'lib',
    title: '番剧库',
    items: [
      {
        id: 'lib.root',
        label: '番剧根目录',
        why: '一部番一个目录、内含 manifest.json；留空则用服务端默认落点。',
        control: { kind: 'text', key: 'libraryRoot', wide: true, placeholder: '例如 D:\\Media\\Anime' },
      },
      {
        id: 'lib.title',
        label: '条目名显示',
        why: '列表与详情优先展示哪种名称；搜索时两种都参与匹配。',
        def: '中文名',
        control: {
          kind: 'seg',
          key: 'titleMode',
          options: [
            { value: 'cn', label: '中文名' },
            { value: 'original', label: '原名' },
          ],
        },
      },
      {
        id: 'lib.nsfw',
        label: '隐藏 NSFW 条目',
        why: '列表与搜索不展示已标记条目（详情页仍可临时查看）。',
        def: '开',
        control: { kind: 'switch', key: 'hideNsfw' },
      },
      {
        id: 'lib.anim',
        label: '收藏列表动画',
        why: '卡片错峰进场；低配机可关掉换流畅。',
        def: '开',
        control: { kind: 'switch', key: 'listAnim' },
      },
    ],
  },
  {
    id: 'play',
    title: '播放',
    items: [
      {
        id: 'play.resume',
        label: '记忆播放位置',
        why: '重新打开自动续播到上次位置，详情页展示「继续观看」。',
        def: '开',
        control: { kind: 'switch', key: 'resume' },
      },
      {
        id: 'play.autonext',
        label: '自动连播下一集',
        why: '当前集结束后自动播放下一集，末尾 5 秒倒计时。',
        def: '开',
        control: { kind: 'switch', key: 'autoNext' },
      },
      {
        id: 'play.skip',
        label: '自动跳过片头 / 片尾',
        why: '按条目元数据或手动标记的时间点跳过，可在播放页临时关。',
        def: '跳过片尾',
        control: {
          kind: 'seg',
          key: 'skip',
          options: [
            { value: 'op', label: '跳过片头' },
            { value: 'ed', label: '跳过片尾' },
            { value: 'both', label: '全部' },
            { value: 'off', label: '关闭' },
          ],
        },
      },
      {
        id: 'play.rate',
        label: '默认播放倍速',
        why: '每次开播的初始倍速；播放页可临时改。',
        def: '1.0×',
        control: {
          kind: 'seg',
          key: 'defaultRate',
          options: [
            { value: 1, label: '1.0×' },
            { value: 1.25, label: '1.25×' },
            { value: 1.5, label: '1.5×' },
            { value: 2, label: '2.0×' },
          ],
        },
      },
      {
        id: 'play.hw',
        label: '强制硬件解码',
        why: '花屏 / 绿屏时用它排查；默认交给内核自选。',
        def: '自动',
        control: { kind: 'switch', key: 'forceHwDecode' },
      },
      {
        id: 'play.danmaku',
        label: '弹幕',
        why: '数据契约已留好弹幕轨字段；开放前控制条不显示弹幕开关。',
        control: { kind: 'placeholder', note: '预留能力 · 尚未开放' },
      },
    ],
  },
  {
    id: 'sub',
    title: '字幕',
    items: [
      {
        id: 'sub.size',
        label: '字号',
        why: '相对基准的百分比；描边保证浅色画面下可读。',
        def: '120%',
        control: {
          kind: 'seg',
          key: 'subtitleSize',
          options: [
            { value: 100, label: '100%' },
            { value: 120, label: '120%' },
            { value: 140, label: '140%' },
          ],
        },
      },
      {
        id: 'sub.priority',
        label: '字幕语言优先级',
        why: '同一集有多个字幕时按此顺序自动选择。',
        control: { kind: 'text', key: 'subtitlePriority', wide: true },
      },
    ],
  },
  {
    id: 'source',
    title: '数据源',
    items: [
      {
        id: 'src.list',
        label: '媒体源',
        why: '在线源、BT 与媒体服务器；在「数据源与 BT」里启停、排序、测试。',
        control: { kind: 'buttons', buttons: ['去管理源'] },
      },
      {
        id: 'src.allowbt',
        label: '允许 BT / 磁力来源',
        why: '关闭后只匹配在线源与媒体服务器，BT 任务不再参与自动选源。',
        def: '开',
        control: { kind: 'switch', key: 'allowBt' },
      },
      {
        id: 'src.btstream',
        label: 'BT 边下边播',
        why: '选中 BT 来源时无需等下载完成，缓冲几秒就能看。',
        def: '开',
        control: { kind: 'switch', key: 'btStream' },
      },
      {
        id: 'src.editor',
        label: '自定义源编辑器',
        why: 'RSS 源填订阅地址；选择器源点选页面元素生成规则，均可当场测试。',
        control: { kind: 'buttons', buttons: ['RSS 编辑器', '选择器编辑器'] },
      },
    ],
  },
  {
    id: 'selector',
    title: '媒体选择',
    items: [
      {
        id: 'sel.strategy',
        label: '自动选择策略',
        why: '多来源命中时的择优顺序，靠前者优先。',
        control: { kind: 'text', key: 'selectStrategy', wide: true },
      },
      {
        id: 'sel.res',
        label: '优先分辨率',
        why: '同来源多清晰度时的偏好；无该档就近降级。',
        def: '1080P',
        control: {
          kind: 'seg',
          key: 'preferRes',
          options: [
            { value: 'auto', label: '自动' },
            { value: '1080p', label: '1080P' },
            { value: '2160p', label: '2160P' },
          ],
        },
      },
      {
        id: 'sel.sub',
        label: '优先字幕语言',
        why: '用于 BT 来源的自动择优。',
        def: '简中',
        control: {
          kind: 'seg',
          key: 'preferSub',
          options: [
            { value: 'zh', label: '简中' },
            { value: 'zh-hant', label: '繁中' },
            { value: 'ja', label: '日语' },
          ],
        },
      },
      {
        id: 'sel.confirm',
        label: '播放前确认来源',
        why: '关闭后直接按策略播放最优来源，不再弹「选择播放来源」。',
        def: '开',
        control: { kind: 'switch', key: 'confirmSource' },
      },
    ],
  },
  {
    id: 'cache',
    title: '缓存与 BT',
    items: [
      {
        id: 'cache.dir',
        label: '缓存目录',
        why: '下载与边下边播的落盘位置，建议与番剧根目录同盘。',
        control: { kind: 'text', key: 'cacheDir', wide: true, placeholder: '留空则用服务端默认落点' },
      },
      {
        id: 'cache.limit',
        label: '缓存占用上限',
        why: '超出后按「最近最少观看」清理已看完的缓存。',
        def: '50 GB',
        control: { kind: 'number', key: 'cacheLimitGb', unit: 'GB' },
      },
      {
        id: 'cache.proxy',
        label: '代理',
        why: '仅影响番剧模块的网络请求（元数据、数据源、BT 追踪器）；切换会重启动漫服务。',
        def: '不使用',
        control: {
          kind: 'seg',
          key: 'proxy',
          options: [
            { value: 'off', label: '不使用' },
            { value: 'system', label: '系统' },
            { value: 'custom', label: '自定义' },
          ],
        },
      },
      {
        id: 'cache.proxyurl',
        label: '自定义代理地址',
        why: '代理选「自定义」时生效；只影响番剧模块，形如 http://127.0.0.1:7890。',
        control: { kind: 'text', key: 'proxyUrl', wide: true, placeholder: 'http://127.0.0.1:7890' },
      },
      {
        id: 'bt.port',
        label: 'BT 监听端口',
        why: '固定端口便于在路由器上做端口映射以提高连通率。',
        def: '随机',
        control: { kind: 'text', key: 'btPort' },
      },
      {
        id: 'bt.peer',
        label: 'Peer 过滤规则',
        why: '按订阅规则屏蔽异常 peer，可手动更新或清空。',
        control: { kind: 'text', key: 'peerFilterUrl', wide: true, placeholder: '规则订阅地址' },
      },
      {
        id: 'bt.pikpak',
        label: 'PikPak 云离线',
        why: '给磁力任务加一道云离线通道，冷门资源也能跑起来。',
        def: '关',
        control: { kind: 'switch', key: 'pikpak' },
      },
    ],
  },
  {
    id: 'account',
    title: '账号与同步',
    items: [
      {
        id: 'acc.manage',
        label: '当前账号',
        why: '收藏与进度经中继服务同步，本地改动先入队再推送。',
        control: { kind: 'buttons', buttons: ['管理账号'] },
      },
      {
        id: 'acc.autosync',
        label: '自动同步',
        why: '联网时自动推送队列；关闭后只手动点「立即同步」时上传。',
        def: '开',
        control: { kind: 'switch', key: 'autoSync' },
      },
      {
        id: 'acc.conflict',
        label: '冲突处理',
        why: '本地与云端进度不一致时的默认取舍，「问我」会弹合并面板。',
        def: '问我',
        control: {
          kind: 'seg',
          key: 'conflictPolicy',
          options: [
            { value: 'ask', label: '问我' },
            { value: 'local', label: '留本地' },
            { value: 'cloud', label: '留云端' },
          ],
        },
      },
    ],
  },
  {
    id: 'backup',
    title: '备份',
    items: [
      {
        id: 'backup.transfer',
        label: '设置备份',
        why: '导出到剪贴板，换机器时粘贴即可恢复偏好与源配置。',
        control: { kind: 'buttons', buttons: ['导出', '导入'] },
      },
    ],
  },
];

/** 全表项数（左栏计数与断言共用） */
export const ANIME_SETTING_TOTAL = ANIME_SETTING_GROUPS.reduce((n, g) => n + g.items.length, 0);
