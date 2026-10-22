/**
 * 设置页 34 项的**唯一事实源**（《09》§4.2 / §4.3 / §4.4）。
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

/**
 * 分组 id —— 同时是深链 `?section=` 的取值集合（《09》§4.1）。
 *
 * `anime` 是**域内设置**：30 项数据住在 `modules/anime/settings-catalog.ts`，
 * 不并进本文件的 `SETTINGS_SECTIONS`（那份合计被 C10/COUNT 双门钉着，
 * 把另一域 30 项塞进来会让"设置页 34 项"这个数字失去意义）。
 * 本表只负责"有这一组、深链能进来"，渲染由 `AnimeSettingsSection` 自己承担。
 */
export type SectionId = 'general' | 'translate' | 'media' | 'resource' | 'about' | 'anime';

export const SECTION_IDS: readonly SectionId[] = [
  'general',
  'translate',
  'media',
  'resource',
  'about',
  'anime',
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
   * 出厂默认值 —— 渲染成标题行内的一枚浅色小字「默认：X」（`parts.tsx` 的 `DefaultChip`）。
   *
   * ⚠️ **它不是"当前值"**：用户改过之后它并不跟着变。真实生效值始终以右侧控件显示的为准。
   * 这正是界面上必须写「默认：」三个字的原因（只写值会被读成"你现在是这个"），
   * 也是悬停那句"这不是你当前的设置"存在的原因。
   * 它回答的是另一个问题：**「我改过没有」** —— 对照一眼就知道现在这个值是不是原封未动。
   *
   * 只在 `Row`（`live` 项）渲染；`pending` 项不显示它（还没有能力，谈默认值没有对象）。
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
  /**
   * 卡头副标题（设计稿 `.s-card-head p`）：标题下那行 10px 说明。
   *
   * 缺省 = 不渲染。它回答的是"这张卡在管什么"，与逐项的 `why`（管"这一项是什么"）
   * 不同层级 —— 四项各自写 why 之后，用户仍然不知道"为什么这四项被放在一起"。
   */
  head?: string;
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
  /**
   * 组说明的**一行摘要** —— 折叠态显示的就是它，点「为什么 ?」才铺开 `note` 全文。
   *
   * ## 为什么是"抽几句事实"，而不是让组件截 `note` 的前 N 字
   * 截取会把句子切在半句上（`…（四小节：翻译来源 1 · 服务与配…`），读起来像坏了。
   * 而这一段要给用户的只有一条：**改哪些东西要重启**。其余是写给维护者的背景论证
   * （两个服务端视角为何缺一不可、两个阈值待遇为何不同），默认不该占 6 行。
   *
   * ## 🔴 硬约束：摘要的**每一段都必须能在 `note` 原文里逐字找到**
   * 按 ` · ` 切段；把 `note` 与每一段都**去掉空白与 `**` 标记**后，每段必须是 `note` 的
   * 子串。这是"**摘要不得成为新的承诺**"这条纪律的可执行形式：
   *   · 摘要里出现 `note` 没写过的说法（例如把「10 项」说成「全部已实现」）⇒ 变红；
   *   · `note` 改了而摘要没跟着改 ⇒ 变红；
   *   · 摘要写成空串、或一段都切不出来（空转）⇒ 变红。
   * 项数也由此被间接钉住：`note` 里的「本组 N 项」已被 `NOTE.count` 对着数据验过。
   *
   * ## 缺省 = 不折叠
   * 不给 `noteSummary` 就不折叠（原样铺全文）。折叠与否是**数据**说了算，
   * 不在组件里按字符数猜 —— 猜出来的阈值没人能解释，也没法被断言。
   */
  noteSummary?: string;
}

/** ① 通用 —— 跨应用 */
export const GENERAL: SettingSection = {
  id: 'general',
  name: '通用',
  blurb: '外观、生命周期与本机自检等',
  /*
   * 两张卡（设计稿 `.s-card`）：外观 / 行为与自检。
   *
   * 分成两张而不是一张四行，是设计稿的层级：前三项都在回答"界面长什么样"，
   * 第四项是"去核对界面是否与规格一致"。混在一张卡里，自检那行的按钮看起来
   * 与前两项的开关同级，用户会以为它也是一个偏好。
   */
  groups: [
    {
      id: 'appearance',
      title: '外观',
      head: '让界面更像你的房间',
      items: [
        { id: 'dark-mode', label: '深色模式', state: 'live', why: '柔和的夜色，长时间使用不刺眼', def: '浅色' },
        {
          id: 'sidebar-labels',
          label: '侧栏图标标签',
          state: 'live',
          why: '在应用图标下显示名称；关闭后只留图标',
          def: '显示',
        },
      ],
    },
    {
      id: 'behavior',
      title: '行为与自检',
      head: '窗口生命周期与规格核对',
      items: [
        {
          id: 'close-window',
          label: '关闭窗口行为',
          state: 'live',
          why: '由系统窗口按钮触发；翻译服务会在后台留驻',
          def: '收起到托盘',
        },
        { id: 'spec-check', label: '规格自检', state: 'live', why: '核对设置页、模块目录与运行契约的完整性' },
      ],
    },
  ],
};

/** ② 翻译服务 —— 引擎专属 + ver2.2 在线翻译来源，四小节 */
export const TRANSLATE: SettingSection = {
  id: 'translate',
  name: '翻译服务',
  blurb: '本地服务、推理引擎与模型配置',
  note:
    '本组 13 项，分四小节：翻译来源、服务与配对、推理引擎、模型与诊断。' +
    '翻译来源二选一 —— 本地引擎（默认）或在线 API，选一次即对之后所有翻译生效。' +
    '改档位/后端/模型目录要重启引擎才生效，所以界面上「已配置」与「已生效」分开显示。' +
    '两个空闲卸载阈值生效时机不同：LLM 档保存后立刻生效，视觉档必须重启引擎 —— ' +
    '提示条因此只挂在真正需要它的那一小节下方。',
  noteSummary: '本组 13 项 · 改档位/后端/模型目录要重启引擎才生效 · 两个空闲卸载阈值生效时机不同',
  groups: [
    {
      id: 'source',
      title: '翻译链路',
      head: '二选一 · 下一次翻译生效',
      items: [
        {
          id: 'translate-source',
          label: '翻译来源',
          state: 'live',
          def: '本地引擎',
          why: '本地引擎或在线 API，下一次翻译生效',
        },
      ],
    },
    {
      id: 'pairing',
      title: '服务与配对',
      head: '本地服务由喵坞托管，可随时启停',
      items: [
        { id: 'service-endpoint', label: '服务状态与端口', state: 'live', why: '本地翻译服务与引擎端口' },
        {
          id: 'service-auto-start',
          label: '自动启动翻译服务',
          state: 'live',
          def: '开',
          why: '进入喵坞时自动拉起本地服务',
        },
        { id: 'token-pairing', label: '令牌配对', state: 'live', why: '服务与引擎之间的本地鉴权令牌' },
        { id: 'root-dir', label: '落盘根目录', state: 'live', why: '漫画原图与译文的保存位置' },
      ],
    },
    {
      id: 'inference',
      title: '推理引擎',
      head: '改档位 / 后端 / 模型目录需要重启引擎才生效',
      items: [
        {
          id: 'translate-direction',
          label: '翻译方向',
          state: 'live',
          def: '日译中',
          why: '日译中或英译中',
        },
        {
          id: 'tier',
          label: '翻译档位',
          state: 'live',
          def: '按硬件探测',
          why: 'Tiny / Small / Medium，改后需重启引擎',
        },
        {
          id: 'backend',
          label: '加速后端',
          state: 'live',
          def: '自动',
          why: 'auto / CUDA / MPS / CPU',
        },
        {
          id: 'idle-llm',
          label: '空闲卸载 LLM',
          state: 'live',
          def: '5 分钟',
          why: 'Sakura 空闲多久后释放，保存即生效',
        },
        {
          id: 'idle-vision',
          label: '空闲卸载视觉',
          state: 'live',
          def: '30 分钟',
          why: '视觉模型空闲释放，需重启引擎',
        },
      ],
    },
    {
      id: 'model',
      title: '模型与诊断',
      head: '权重与引擎的现场',
      items: [
        {
          id: 'model-dir',
          label: '模型目录',
          state: 'live',
          why: '权重文件所在的 models-store',
        },
        {
          id: 'model-manage',
          label: '模型管理',
          state: 'live',
          // 通栏块：校验结果是一份"哪几个不符/缺失"的清单，塞不进 Row 的窄右列
          layout: 'block',
          why: '校验完整性、补齐缺失与重新下载',
        },
        {
          id: 'engine-diag',
          label: '运行状态',
          state: 'live',
          // 通栏块：常驻的「运行状态」卡 + 折叠的「诊断详情」，是一整块面板而非一行
          layout: 'block',
          /*
           * 《03》§3.1：卡片标题「运行状态」取代了原先的 `item.label`（原为「引擎诊断视图」）。
           * 单一事实源仍是 catalog —— 组件里不硬写这五个字。
           *
           * ⚠️ why 是**重写**不是删除（《03》§7.1）：ver2.0 那句「默认收起、点开即见」描述的
           * 是"日志也被折叠"的旧形态，本版日志已摘出折叠范围，那句话留着就是错的。
           */
          why: '进程、参数、模型与阶段日志现场',
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
  name: '播放 · 媒体',
  blurb: '播放、歌词与彩胶等设置',
  groups: [
    {
      id: 'playback',
      title: '播放',
      head: '这些默认值会同步到播放条和展开播放器',
      items: [
        {
          id: 'quality',
          label: '音质档位',
          state: 'live',
          def: '高清臻音',
          why: '标准 / 极高 / 无损 / 高清臻音 / 超清母带',
        },
        { id: 'skin', label: '展开播放器皮肤', state: 'live', def: '现代', why: '六套播放器皮肤' },
        {
          id: 'dynamic-bg',
          label: '动态背景',
          state: 'live',
          def: '关',
          why: '现代 / 沉浸皮肤的渐变缓慢流动',
        },
        {
          id: 'disc-mode',
          label: '碟片模式',
          state: 'live',
          def: '关',
          why: '封面显示成旋转唱片',
        },
        {
          id: 'music-cache',
          label: '音乐缓存',
          state: 'live',
          // 四格块：塞不进 Row 的窄右列（见 SettingItem.layout 的注释）
          layout: 'block',
          why: '歌词与整首歌的本地缓存，按平台清理',
        },
      ],
    },
    {
      id: 'lyrics',
      title: '歌词',
      head: '作用于展开播放器与桌面歌词窗口',
      items: [
        {
          id: 'lyrics-mode',
          label: '歌词高亮方式',
          state: 'live',
          why: '整行点亮或逐字推进',
          def: '逐字',
        },
        {
          id: 'lyrics-size',
          label: '歌词字号',
          state: 'live',
          def: '19px',
          why: '17–48 px，实时预览',
        },
        {
          id: 'lyrics-color',
          label: '歌词高亮色',
          state: 'live',
          def: '#FFE066',
          why: '作用于展开播放器里正在唱的那一行',
        },
        {
          id: 'lyrics-window',
          label: '桌面歌词窗口',
          state: 'live',
          def: '关',
          why: '独立的置顶歌词窗',
        },
        {
          id: 'lyrics-locked',
          label: '锁定歌词窗口',
          state: 'live',
          def: '未锁定',
          why: '锁定后无法拖动歌词窗',
        },
      ],
    },
    {
      id: 'vinyl',
      title: '透明彩胶',
      head: '「透明彩胶」皮肤专用的唱片底色',
      items: [
        {
          id: 'vinyl-color-mode',
          label: '彩胶配色',
          state: 'live',
          def: '跟随封面',
          why: '跟随封面或固定颜色',
        },
        {
          id: 'vinyl-color',
          label: '彩胶自定义色',
          state: 'live',
          def: '#E8B04B',
          why: '仅固定颜色模式可用',
        },
      ],
    },
  ],
};

/** ④ 资源与投放 —— 跨应用资源 */
export const RESOURCE: SettingSection = {
  id: 'resource',
  name: '资源与投放',
  blurb: '磁盘占用与清理',
  groups: [
    {
      id: 'main',
      title: null,
      items: [
        {
          id: 'storage-usage',
          label: '存储占用',
          state: 'live',
          why: '译文库、音乐缓存与模型占用',
          // 通栏块：三行「名称 / 值 / 来源」塞不进 Row 的窄右列（会同 CacheBlock 的理由）
          layout: 'block',
        },
        {
          id: 'temp-files',
          label: '临时文件',
          state: 'pending',
          why: '上传暂存在服务侧管理，目前没有可用的列举与清理接口',
        },
      ],
    },
  ],
};

/** ⑤ 关于 —— 全局 */
export const ABOUT: SettingSection = {
  id: 'about',
  name: '关于',
  blurb: '版本、许可与反馈渠道',
  groups: [
    {
      id: 'main',
      title: null,
      items: [
        { id: 'version', label: '版本号', state: 'live', why: '喵坞 MiaoDock 当前版本' },
        {
          id: 'licenses',
          label: '第三方许可',
          state: 'live',
          // 通栏块：聚合 + 可展开的完整清单，塞不进 Row 的窄右列
          // （⑤ 组由 `AboutSection` 手工渲染，不经过 `Group`；这个字段仍如实描述形态）
          layout: 'block',
          why: 'npm / Rust / 引擎与模型许可清单',
        },
        {
          id: 'oss-feedback',
          label: '开源反馈',
          state: 'pending',
          why: '项目尚未公开发布',
        },
      ],
    },
  ],
};

/** 顺序即左栏导航渲染顺序（①→⑤） */
export const SETTINGS_SECTIONS: readonly SettingSection[] = [GENERAL, TRANSLATE, MEDIA, RESOURCE, ABOUT] as const;

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
 * 本轮规格。演进链（每一次都是产品拍板，不要凭记忆改）：
 *   26（《09》§4.2 原文）→ 29（③ 播放·媒体 经「能实现补齐 / 不能实现剔除」）
 *   → 31（恢复桌面歌词 2 项）→ 32（加「音乐缓存」1 项）→ 33（加「歌词高亮方式」1 项）
 *   → **31**（剔除「缓存清理」「检查更新」2 项：前者与 ③「音乐缓存」重复，
 *     后者缺的是更新源这个外部事实，且文案承诺的托盘入口本就不存在）
 *   → **32**（② 服务与配对加「自动启动翻译服务」1 项）：让"不翻译就别把引擎拉起来"
 *     成为可配置项 —— 关掉后由未就绪屏的「启动本地服务」手动拉起（台账 D-94）。
 *   → **33**（② 推理引擎加「翻译方向」1 项）：把"方向逐任务下发、英译中走离线 nllb"
 *     这件事实写进界面 —— 否则引擎诊断里的「源语言：按任务方向」没有一处能自答（ver2.1）。
 *   → **34**（② 加「翻译来源」小节 1 项，ver2.2）：在线翻译并入 ② 作为第一个小节
 *     （P-D2）—— 来源二选一（本地引擎 / 在线 API），是**服务的设置**不是任务属性（P-D1）。
 *
 * ⚠️ 改这个数之前必须先核对 `SECTION_ITEM_TOTAL`（由数据算出，不手写）：
 * 两者不一致时下面的自校会报错 —— 那正是它存在的意义（防止"加了一项忘了改总数"）。
 */
export const SPEC_ITEM_TOTAL = 34;

/**
 * 启动期自校：合计不等于 32 就在控制台报错。
 *
 * 刻意**只警告不抛异常** —— 一份数据写错不该让整个设置页白屏，
 * 但它必须在开发第一眼就被看见，而不是等评审数出 25 才有人发现。
 */
if (SECTION_ITEM_TOTAL !== SPEC_ITEM_TOTAL && typeof console !== 'undefined') {
  console.error(
    `[settings] 项数合计 ${SECTION_ITEM_TOTAL} ≠ 规格 ${SPEC_ITEM_TOTAL}（现值见 SPEC_ITEM_TOTAL）。` +
      '新增/删除项时请同步更新 SPEC_ITEM_TOTAL，或说明规格已变。',
  );
}
