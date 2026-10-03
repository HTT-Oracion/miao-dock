/**
 * 设置页 26 项的**唯一事实源**（《09》§4.2 / §4.3 / §4.4）。
 *
 * ## 为什么用数据而不是 JSX 硬写
 *
 * 26 这个数是被 C10 断言盯着的（"分组恒为 5、合计 26"）。若项数散落在五个组件的
 * JSX 里，加一项要改五处、减一项要改五处，而"合计 26"这件事**没有任何一处能算出来**
 * —— 只能靠人肉数一遍五个文件。那不是断言，是许愿。
 *
 * 所以这里把"有哪些项、每项什么能力状态"抽成数据，`SETTINGS_SECTIONS` 是它，
 * 分组组件只负责**渲染 live 项的真实控件**；`SECTION_ITEM_TOTAL` 由数据算出来，
 * 开发期启动即自校（见文件末尾）。计数与渲染因此不可能对不上。
 *
 * ## `state` 是这份数据里唯一带立场的字段
 *
 * `live` = 有真实能力可接；`pending` = 引擎/音乐模块 M1 之后才有。
 * **pending 项一律不渲染任何可点控件**，只给 `Badge`「待接入」+ 一句为什么没有。
 *
 * 这条纪律是有代价的：设置页看上去"完成度很低"。但反过来做 —— 摆一个能点、
 * 点了没反应、或预置一份假数据的控件 —— 代价更大：
 * **假控件比缺控件更伤**。用户点得动就以为它有作用，等真接上时他反而更怀疑。
 * 宁可让 19 项明明白白写着"待接入"，也不要 1 项在骗人。
 */

/** 分组 id —— 同时是深链 `?section=` 的取值集合（《09》§4.1） */
export type SectionId = 'general' | 'translate' | 'media' | 'resource' | 'about';

export const SECTION_IDS: readonly SectionId[] = [
  'general',
  'translate',
  'media',
  'resource',
  'about',
] as const;

/** 能力状态：`live` 有真实能力；`pending` 引擎/音乐 M1 之后才有 */
export type ItemState = 'live' | 'pending';

export interface SettingItem {
  /** 稳定 id，供断言与后续接能力时定位；不用标题当 key（标题会改） */
  id: string;
  label: string;
  state: ItemState;
  /**
   * `pending` 项专属：**为什么现在没有**。
   * 必须具体到"缺的是哪个能力"，不能写"暂未实现"—— 那种话等于没说，
   * 三个月后没人知道该不该做。
   */
  why?: string;
  /** `live` 项的默认值（若有）。只读展示，不做成可点的选择器 */
  def?: string;
}

export interface SettingGroup {
  /** 小节 id；`live` 分组（如"通用"）用 `main` 表示无小节层级 */
  id: string;
  /**
   * 小节标题。**null = 不设小节**（单层分组直接列行）。
   * 小节标题 10.5px/700/uppercase/.05em 是组内分层的唯一手段（《09》§4.1），
   * 抹平它 C11 会红。
   */
  title: string | null;
  items: SettingItem[];
}

export interface SettingSection {
  id: SectionId;
  name: string;
  /** 页标题下的描述（15px 标题 + 描述 margin-bottom 20） */
  blurb: string;
  groups: SettingGroup[];
  /**
   * 组级说明：这一组里为什么有这么多"待接入"。
   * 逐项的 `why` 解释单个项，这句解释**共同的那部分**（同一个上游依赖）。
   */
  note?: string;
}

/** ① 通用 —— 跨应用 */
export const GENERAL: SettingSection = {
  id: 'general',
  name: '通用',
  blurb: '外观、生命周期与本机自检。与具体应用无关的项都放在这里。',
  note:
    '本组 4 项里 3 项已接真实能力。唯一缺的「侧栏图标标签」要改 Sidebar.tsx 的渲染分支，' +
    '不在本轮（IA 重组）范围内 —— 它属于壳层，不属于设置页。',
  groups: [
    {
      id: 'main',
      title: null,
      items: [
        { id: 'dark-mode', label: '深色模式', state: 'live', def: '浅色' },
        {
          id: 'close-window',
          label: '关闭窗口行为',
          state: 'live',
          def: '收起到托盘',
        },
        { id: 'spec-check', label: '规格自检', state: 'live' },
        {
          id: 'sidebar-labels',
          label: '侧栏图标标签',
          state: 'pending',
          why:
            '「侧栏图标 + 文字标签」要改 Sidebar.tsx 的渲染分支与几何，属壳层改动，' +
            '不在本轮（设置页）范围内 —— 侧栏是 IA 重组的另一条线。',
        },
      ],
    },
  ],
};

/** ② 翻译服务 —— 引擎专属，三小节 */
export const TRANSLATE: SettingSection = {
  id: 'translate',
  name: '翻译服务',
  blurb: '本地服务、推理引擎与模型。翻译是重资源操作，这一组按「改完要不要重启引擎」分层。',
  note:
    '7 项待接入全部卡在**同一个上游**：三进程编排（引擎①②③）本身还没实现（M1 起）。' +
    '这一层刻意不先摆开关 —— 摆了就等于承诺"改了会生效"，而现在改任何一项都不会有任何变化。',
  groups: [
    {
      id: 'pairing',
      title: '服务与配对',
      items: [
        { id: 'service-endpoint', label: '服务状态与端口', state: 'live' },
        { id: 'token-pairing', label: '令牌配对', state: 'live' },
        { id: 'root-dir', label: '落盘根目录', state: 'live' },
      ],
    },
    {
      id: 'inference',
      title: '推理引擎',
      items: [
        {
          id: 'tier',
          label: '翻译档位',
          state: 'pending',
          why:
            '档位（Tiny/Small/Medium）要按硬件探测隐藏物理不可行的档位（《09》§6.3）—— ' +
            '16GB Mac 上不该出现 Medium。现在连一个可切换的引擎进程都没有，档位列表没有真实取值来源。',
        },
        {
          id: 'backend',
          label: '加速后端',
          state: 'pending',
          why: '加速后端由引擎侧按设备与精度自行选择；引擎未实现，前端列不出可信的候选。',
        },
        {
          id: 'idle-llm',
          label: '空闲卸载 LLM',
          state: 'pending',
          def: '5 分钟空闲',
          why: '空闲卸载要等引擎上报"我空闲了"这个信号。引擎未实现，无信号可等。',
        },
        {
          id: 'idle-vision',
          label: '空闲卸载视觉',
          state: 'pending',
          def: '30 分钟空闲',
          why: '同空闲卸载 LLM：依赖引擎的空闲信号与显存占用回传。',
        },
      ],
    },
    {
      id: 'model',
      title: '模型与诊断',
      items: [
        {
          id: 'model-dir',
          label: '模型目录',
          state: 'pending',
          why:
            '模型目录由引擎下载并校验后确定，且改它需要重启引擎才生效。' +
            '现在写死一个路径字符串等于给"能改的假控件" —— 用户改了不会发生任何事。',
        },
        {
          id: 'model-manage',
          label: '模型管理',
          state: 'pending',
          why: '下载 / SHA256 校验 / 断点续传是引擎 L2 阶段的一等能力（《09》§6.1），尚未落地。',
        },
        {
          id: 'engine-diag',
          label: '引擎诊断视图',
          state: 'pending',
          why: '诊断视图要展示三个引擎进程的 state/pid/port 与阶段日志；引擎未实现，没有数据源。',
        },
      ],
    },
  ],
};

/** ③ 播放·媒体 —— 音乐低频项 */
export const MEDIA: SettingSection = {
  id: 'media',
  name: '播放·媒体',
  blurb: '音乐播放的低频默认值。与播放现场相关的东西一律不在这里 —— 见下方迁移说明。',
  note:
    '本组 5 项**本轮不迁**（《09》§4.4）：音乐屏目前还是占位屏，把设置项搬过去等于搬到空页上。' +
    '但归属已经定好，届时按此执行 —— 播放模式/音量 → 底部 PlayerBar；音质档位/皮肤 → 展开播放器底栏' +
    '（需即时试听）；歌词字号/高亮色 → 展开播放器 + 桌面歌词设置；桌面歌词开关 → 音乐屏工具条' +
    '（本组只留默认值）；音源平台账号 → 音乐屏顶部登录区。',
  groups: [
    {
      id: 'main',
      title: null,
      items: [
        {
          id: 'audio-output',
          label: '音频输出',
          state: 'pending',
          why: '输出设备枚举与切换由 Rust 音乐模块负责；播放内核 M1 起才有音频输出。',
        },
        {
          id: 'equalizer',
          label: '均衡器',
          state: 'pending',
          why:
            '均衡器随播放内核一起做（后置 P3）。且它需要即时试听 —— 拖动即出声，' +
            '放在设置里做不了这件事。',
        },
        {
          id: 'media-keys',
          label: '媒体键',
          state: 'pending',
          why: '全局媒体键要 Rust 侧注册系统级热键，属音乐模块范围（M1 起）。',
        },
        {
          id: 'lyrics-default',
          label: '桌面歌词默认值',
          state: 'pending',
          why:
            '桌面歌词渲染器属音乐模块。本项只保留**默认值**（字号/高亮色的初始档）；' +
            '开关本身按《09》§4.4 迁往音乐屏工具条。',
        },
        {
          id: 'audio-cache',
          label: '音频缓存目录',
          state: 'pending',
          why: '音频缓存由在线音源的本地代理（Range/206）产生；M1 之前不存在缓存，也就没有目录可配。',
        },
      ],
    },
  ],
};

/** ④ 资源与投放 —— 跨应用资源 */
export const RESOURCE: SettingSection = {
  id: 'resource',
  name: '资源与投放',
  blurb: '磁盘占用与清理。投放规则（单次上限 20 张）不在这 —— 那是规则告知，不是参数。',
  note:
    '本组 3 项卡在**磁盘口径**上：目前只有一个 library 汇总字节数，拿它冒充"存储占用"是假账；' +
    '而"缓存清理"会真的删文件，必须与 Rust 侧路径白名单一起落地。',
  groups: [
    {
      id: 'main',
      title: null,
      items: [
        {
          id: 'storage-usage',
          label: '存储占用',
          state: 'pending',
          why:
            '完整占用要覆盖译文库 + 音频缓存 + 模型三处，需 Rust 侧统一盘点。' +
            '现在只有 library 的一个字节数，凑成一个"总占用"会把没统计的部分说成 0。',
        },
        {
          id: 'cache-clean',
          label: '缓存清理',
          state: 'pending',
          why: '清理动作会删文件，需与 Rust 侧的路径白名单、二次确认一起落地。先给按钮 = 让用户盲删。',
        },
        {
          id: 'temp-files',
          label: '临时文件',
          state: 'pending',
          why: '上传暂存由服务侧管理，ver1.0 没有列举 / 清理这两条接口。',
        },
      ],
    },
  ],
};

/** ⑤ 关于 —— 全局 */
export const ABOUT: SettingSection = {
  id: 'about',
  name: '关于',
  blurb: '版本、许可与反馈渠道。托盘「检查更新」会带 ?section=about 直达本组。',
  note:
    '本组 4 项里只有版本号能真实显示。另 3 项缺的是**外部事实**而非代码：' +
    '没有更新源、许可清单尚未逐条核准、项目未公开发布 —— 这三样都不该用占位内容填。',
  groups: [
    {
      id: 'main',
      title: null,
      items: [
        { id: 'version', label: '版本号', state: 'live' },
        {
          id: 'check-update',
          label: '检查更新',
          state: 'pending',
          why:
            '没有更新源（应用未上架任何渠道，也未接自更新端点）。' +
            '托盘「检查更新」的深链已备好（?section=about），但按钮不能先摆 —— ' +
            '一个只会告诉你"已是最新"的检查框，比没有更让人以为已经查过了。',
        },
        {
          id: 'licenses',
          label: '第三方许可',
          state: 'pending',
          why: '依赖树里有 GPL-3.0 的参考源码（D-21），许可清单需逐条核准后再展示，不能凭记忆列。',
        },
        {
          id: 'oss-feedback',
          label: '开源反馈',
          state: 'pending',
          why: '项目尚未公开发布，没有可指向的仓库地址。给一个打不开的链接不如不给。',
        },
      ],
    },
  ],
};

/** 顺序即左栏导航渲染顺序（①→⑤） */
export const SETTINGS_SECTIONS: readonly SettingSection[] = [
  GENERAL,
  TRANSLATE,
  MEDIA,
  RESOURCE,
  ABOUT,
] as const;

/** 深链解析：非法或缺省一律回落到①，不抛错（《09》§4.1 的 `?section=`） */
export function parseSection(raw: string | null): SectionId {
  return SECTION_IDS.includes(raw as SectionId) ? (raw as SectionId) : 'general';
}

/** 某一分组的项数（渲染与自检共用，不各处手写数字） */
export function sectionItemCount(s: SettingSection): number {
  return s.groups.reduce((n, g) => n + g.items.length, 0);
}

/** 全表合计项数 —— C10 的判据来源 */
export const SECTION_ITEM_TOTAL = SETTINGS_SECTIONS.reduce((n, s) => n + sectionItemCount(s), 0);

/** 本轮规格（《09》§4.2）写定的合计值。与 TOTAL 不符即为规格或数据被改动过 */
export const SPEC_ITEM_TOTAL = 26;

/**
 * 启动期自校：合计不等于 26 就在控制台报错。
 *
 * 刻意**只警告不抛异常** —— 一份数据写错不该让整个设置页白屏，
 * 但它必须在开发第一眼就被看见，而不是等评审数出 25 才有人发现。
 */
if (SECTION_ITEM_TOTAL !== SPEC_ITEM_TOTAL && typeof console !== 'undefined') {
  console.error(
    `[settings] 项数合计 ${SECTION_ITEM_TOTAL} ≠ 规格 ${SPEC_ITEM_TOTAL}（《09》§4.2）。` +
      '新增/删除项时请同步更新 SPEC_ITEM_TOTAL，或说明规格已变。',
  );
}
