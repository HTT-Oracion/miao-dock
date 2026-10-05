/**
 * 设置页 29 项的**唯一事实源**（《09》§4.2 / §4.3 / §4.4）。
 *
 * ## 为什么用数据而不是 JSX 硬写
 *
 * 项数合计是被自校盯着的（`SPEC_ITEM_TOTAL`）。若项数散落在五个组件的
 * JSX 里，加一项要改五处、减一项要改五处，而"合计"这件事**没有任何一处能算出来**
 * —— 只能靠人肉数一遍五个文件。那不是断言，是许愿。
 *
 * 所以这里把"有哪些项、每项什么能力状态"抽成数据，`SETTINGS_SECTIONS` 是它，
 * 分组组件只负责**渲染 live 项的真实控件**；`SECTION_ITEM_TOTAL` 由数据算出来，
 * 开发期启动即自校（见文件末尾）。计数与渲染因此不可能对不上。
 *
 * ## `state` 是这份数据里唯一带立场的字段
 *
 * `live` = 有真实能力可接；`pending` = 依赖的能力还不存在。
 * **pending 项一律不渲染任何可点控件**，只给 `Badge`「待接入」+ 一句为什么没有。
 *
 * 这条纪律是有代价的：设置页看上去"完成度很低"。但反过来做 —— 摆一个能点、
 * 点了没反应、或预置一份假数据的控件 —— 代价更大：
 * **假控件比缺控件更伤**。用户点得动就以为它有作用，等真接上时他反而更怀疑。
 * 同一把尺子也适用于**剔除**：做不到的项宁可整条删掉（理由记在组 note 里），
 * 也不要留一条永远"待接入"。
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
   *
   * `live` 项也可以写：用来解释**这项在做什么、有什么边界**（例如"仅在某档位下生效"）。
   * 两种情况都会渲染成标题下的一行小字说明。
   */
  why?: string;
  /**
   * 出厂默认值，**仅作说明用**（当前没有任何组件渲染它）。
   * 为什么留着：为「这项默认是什么」留一处可查的文字；真实生效值始终以控件显示的为准
   * —— 不要把它当成"当前值"，用户改过之后它并不跟着变。
   */
  def?: string;
  /**
   * 形态：**默认（不写）= 标准两栏行**，由 `Group` 包一层 `Row`（标题左 / 窄控件列右）。
   *
   * `block` = 通栏块，`Group` **不包 `Row`**，直接把渲染结果铺满整行。
   *
   * ## 为什么需要这个字段（而不是给某一项开小灶）
   *
   * `Row` 的右列是 `flex: 0 0 auto` 的**窄列**。少数几项要的内容天生放不进去 ——
   * 比如「音乐缓存」是**四格**（左列两行：文案 + 目录绝对路径；右列两行：总量 + 按钮）。
   * 塞进窄列会把长路径挤成一条读不了的细缝。
   *
   * 另两条路都更贵：做成独立小节会撞上「③ 组恰为三个小节」的冻结断言；
   * 不走 catalog 直接在组件里手写块，则项数合计对不上（本文件存在的理由就没了）。
   * 所以形态是**数据的一部分**：项数仍是单一事实源，渲染仍由 `Group` 统一负责。
   */
  layout?: 'block';
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

/**
 * ③ 播放·媒体 —— 音乐播放的默认值。
 *
 * ## 这一组做过一次「能实现 / 不能实现」的逐项裁定
 *
 * 原先 5 项全部是 `pending`（理由都是"等音乐模块"）。音乐模块的四平台与播放内核
 * 落地后重新裁定：**能实现的补齐、不能实现的剔除**，逐项结论写在 `note` 里
 * （含被剔除项的理由 —— 直接删掉会让后来者不知道这些项被考虑过、也不知道为什么没有）。
 *
 * 判据不是"想不想做"，而是两件事：
 *   ① 参考实现里**真的有**这个设置吗？（没有的话，我们在凭空发明一个偏好）
 *   ② 本移植**有能力**让它真的生效吗？（做不到就是假控件，比缺控件更伤）
 */
export const MEDIA: SettingSection = {
  id: 'media',
  name: '播放·媒体',
  blurb:
    '播放与媒体的默认值。播放现场的即时操作（音量 / 播放模式 / 切皮肤）仍在播放器上，' +
    '这里给的是**启动时的取值** —— 两边读写同一份偏好，不存在"默认值"与"当前值"两套。',
  note:
    '本组 11 项全部接真实能力。原先 5 项「待接入」已按「参考实现是否真有 + 本移植能否做到」逐项裁定：' +
    '· 桌面歌词：**已实现**（拍板《09》§5.6 第 1 项）—— 独立置顶窗口已落地（固定 label、跨窗口状态推送、' +
    '锁定态由歌词窗自持），此前以「需独立置顶窗口，延后」为由剔除的桌面歌词相关设置项已恢复；' +
    '· 剔除「媒体键」：参考实现的媒体键并非键盘监听，而是 Rust 侧 SMTC（Windows 系统媒体传输控件）' +
    '转发到前端的 smtc:control 事件 —— macOS 要另做 MPRemoteCommandCenter，不是"接上就有"；' +
    '· 剔除「音频输出」：参考实现没有这个设置，且 WebView 无法指定音频输出设备（始终跟随系统默认）；' +
    '· 剔除「均衡器」：参考实现没有这个设置，且它要"拖动即出声"的即时试听，属播放器而非设置页；' +
    '· 剔除「音频缓存目录」：音频走本地代理流式透传（Range/206），不落盘，没有缓存可配' +
    '（⚠️ 这条剔除只针对**目录**；缓存本身已落地，只是路径固定由内核管理，故以「音乐缓存」一项呈现）；' +
    '补进来的是参考实现里真实存在、且本移植能实现的 8 项：音质档位 / 展开播放器皮肤 / 动态背景 / ' +
    '碟片模式（对应参考的 dynamicEnabled / coverFilmEffect）/ 歌词字号 / 歌词高亮色 / ' +
    '透明彩胶配色 / 彩胶自定义色；加上恢复的桌面歌词 2 项（窗口开关 / 锁定）与「音乐缓存」1 项，共 11 项。' +
    '⚠️ 桌面歌词的外观（字号 / 高亮色 / 未高亮行底色 / 显示行数）是独立的一小套偏好，' +
    '收在播放条唤起的「桌面歌词设置」弹窗里，刻意**不放进本页**：它作用于另一个窗口，' +
    '和这里的「歌词字号 / 歌词高亮色」（作用于展开播放器）同名不同物，摆在一起只会制造歧义。' +
    '所以那两项的 why 里都写明了「改桌面歌词请走哪个入口」。',
  groups: [
    {
      id: 'playback',
      title: '播放',
      items: [
        { id: 'quality', label: '音质档位', state: 'live', def: '高清臻音' },
        { id: 'skin', label: '展开播放器皮肤', state: 'live', def: '现代' },
        {
          id: 'dynamic-bg',
          label: '动态背景',
          state: 'live',
          def: '关',
          why: '让「现代 / 沉浸」两种皮肤的渐变缓慢流动；另外四种皮肤没有可流动的渐变。',
        },
        {
          id: 'disc-mode',
          label: '碟片模式',
          state: 'live',
          def: '关',
          why: '把展开播放器的封面显示成旋转唱片（播放时转、暂停时停）。',
        },
        {
          id: 'music-cache',
          label: '音乐缓存',
          state: 'live',
          // 四格块：塞不进 Row 的窄右列（见 SettingItem.layout 的注释）
          layout: 'block',
          why:
            '在线播放的歌词与整首歌会落盘缓存，这里能看占用、按平台清除、打开缓存目录。' +
            '只统计**在线歌曲**的缓存 —— 你自己导入的本地文件不在其中。',
        },
      ],
    },
    {
      id: 'lyrics',
      title: '歌词',
      items: [
        {
          id: 'lyrics-mode',
          label: '歌词高亮方式',
          state: 'live',
          def: '逐字',
          why:
            '逐字＝有逐字数据（yrc/qrc）时精确到字、没有则整行从左到右渐进（默认）；' +
            '整行＝唱到该句整行一次性点亮，不逐字也不渐变。作用于「展开播放器」与灵动岛歌词卡。',
        },
        {
          id: 'lyrics-size',
          label: '歌词字号',
          state: 'live',
          def: '19px',
          why:
            '作用于「展开播放器」的歌词区，当前行会在此基础上再大 3px；不影响桌面歌词。' +
            '桌面歌词有自己的一套字号（窗口只有 160px 高，和满屏的详情页共用一个字号会被撑爆），' +
            '改它请走「桌面歌词设置」：播放条右侧、音量图标旁的那个齿轮按钮。',
        },
        {
          id: 'lyrics-color',
          label: '歌词高亮色',
          state: 'live',
          def: '#FFE066',
          why:
            '作用于「展开播放器」里正在唱的那一行；不影响桌面歌词。' +
            '桌面歌词的高亮色与未高亮行底色是独立的一对，同样在「桌面歌词设置」（播放条右侧的齿轮按钮）里调。',
        },
        {
          id: 'lyrics-window',
          label: '桌面歌词窗口',
          state: 'live',
          def: '关',
          why: '独立的置顶小窗，浮在所有应用之上跟随播放；与播放条上的那个开关是同一份状态。',
        },
        {
          id: 'lyrics-locked',
          label: '锁定歌词窗口',
          state: 'live',
          def: '未锁定',
          why: '锁定后歌词窗不可拖动。macOS 上没有「点击穿透」能力，锁定只表示「不会被误拖走」。',
        },
      ],
    },
    {
      id: 'vinyl',
      title: '透明彩胶',
      items: [
        {
          id: 'vinyl-color-mode',
          label: '彩胶配色',
          state: 'live',
          def: '跟随封面',
          why: '「透明彩胶」皮肤整张唱片底色：跟随封面主色（本地取色）或固定一个颜色。',
        },
        {
          id: 'vinyl-color',
          label: '彩胶自定义色',
          state: 'live',
          def: '#E8B04B',
          why: '仅在「彩胶配色 = 固定颜色」时生效；跟随封面主色时本项不可用。',
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

/**
 * 本轮规格（《09》§4.2 为 26；③ 播放·媒体 经「能实现补齐/不能实现剔除」后为 29，
 * 再恢复桌面歌词 2 项后为 31，加「音乐缓存」1 项后为 32，加「歌词高亮方式」1 项后为 **33**）。
 *
 * ⚠️ 改这个数之前必须先核对 `SECTION_ITEM_TOTAL`（由数据算出，不手写）：
 * 两者不一致时下面的自校会报错 —— 那正是它存在的意义（防止"加了一项忘了改总数"）。
 */
export const SPEC_ITEM_TOTAL = 33;

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
