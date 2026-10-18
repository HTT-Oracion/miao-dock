/**
 * 卸载页的固定文案与数据项**元信息**。
 *
 * 🔴 三类数据的**目录与体积一律不在这里**：它们由宿主实时探测后经 `host.ts` 的
 *    `DataProfiles` 传进来（目录的权威口径在产品侧：漫画 = `paths::root_dir()`、
 *    引擎 = `paths::runtimes_dir()`、音乐缓存 = `app_cache_dir()/music-cache`）。
 *    把演示值写死在这里，用户换个安装位置、多用两个月，界面就会说谎。
 */

/** 卸载页的三个界面状态 */
export type Phase = 'confirm' | 'running' | 'done';

/** 可勾选的三类本地数据 */
export type DataKind = 'music' | 'manga' | 'engine';

/** 三类各自的勾选与否（初始值由 `emptyChecks()` 给出） */
export type DataChecks = Record<DataKind, boolean>;

/** 三类里任选其一的删除风险级 —— 决定行内徽章的配色 */
export type BadgeKind = 'keep' | 'danger' | 'slow';

export interface DataItem {
  kind: DataKind;
  /** 行标题，也是"正在删除…"那行用的名字 */
  title: string;
  /** 汇总里的短名（完成页空间小，用短名拼接） */
  short: string;
  badge: string;
  badgeKind: BadgeKind;
  desc: string;
}

export const DATA_ITEMS: DataItem[] = [
  {
    kind: 'music',
    title: '本地音乐数据',
    short: '音乐缓存',
    badge: '删除后可重新缓存',
    badgeKind: 'keep',
    desc: '在线播放产生的歌词与音频缓存。删除不影响歌单，再次播放时重新缓存即可。',
  },
  {
    kind: 'manga',
    title: '本地漫画数据',
    short: '译稿',
    badge: '删除后不可恢复',
    badgeKind: 'danger',
    desc: '你的译稿、导入的图片与收藏。删除后无法恢复，卸载前请确认是否还需要。',
  },
  {
    kind: 'engine',
    title: '本地引擎数据',
    short: '引擎数据',
    badge: '重新装配耗时较长',
    badgeKind: 'slow',
    desc: '自行装配的 Python 依赖与模型权重。该目录位于安装目录之外，卸载程序时默认保留；勾选后将一并删除。',
  },
];

export const UNINSTALL = {
  winTitle: '卸载 喵坞 MiaoDock',
  confirmTag: 'v2.2.1 · 再见页',
  runningTagPrefix: '告别中…',
  doneTag: '再见完成',
  probing: '正在统计本地数据…',
  probingFoot: '正在读取三类数据的目录与体积',
  confirmTitle: '确定要卸载喵坞吗？',
  confirmSub: '卸载仅移除程序本身。以下三类本地数据默认全部保留，只有勾选后才会被删除。',
  introLabel: '接下来会发生什么：',
  introText:
    '卸载将移除喵坞的程序文件、桌面与开始菜单入口，以及控制面板里的卸载项。' +
    '下列三类本地数据默认原地保留，重新安装后仍可继续使用。',
  masterTitle: '同时删除本地数据',
  masterBadge: '默认不勾选',
  masterDesc: '不勾选：仅卸载程序，数据全部保留（推荐）。勾选后，下方三项数据可逐项选择，仅勾选项会被删除。',
  /** 探测未完成时行尾的占位（比写死一个体积诚实） */
  probingSize: '统计中…',
  /** 目录不存在时的行尾说明 */
  missingSize: '未安装',
  missingPath: '目录不存在',
  footNoteLeft: '如需重新使用，可再次运行安装包',
  /** 脚注里的落点由宿主探测回来的真实路径拼出（不写死 `%LOCALAPPDATA%\\runtimes\\`） */
  footNoteBottom: (runtimesRoot: string) => `引擎数据若未勾选，将原样留在 ${runtimesRoot}`,
  keepOnlyBtn: '留下数据，只卸载程序',
  purgeBtn: '狠心卸载',
  cancelBtn: '取消',
  runningTitle: '正在卸载…',
  runningSub: '卸载正在进行，请稍候。',
  runningFootLeft: '卸载会完整执行到最后一步',
  runningNote: '删除中的项目按你的勾选实时显示；未勾选的数据会明确写「已保留」',
  backgroundBtn: '后台卸载',
  /** 卸载失败时摆在进度屏顶上的提示（失败原因由宿主给成人话） */
  failure: (reason: string) => `卸载未正常结束：${reason}。可重新运行本卸载器；若反复失败，请查看安装日志。`,
  doneTitle: '卸载完成',
  doneSub:
    '勾选删除的数据已移除，未勾选的数据均未触碰。关窗后卸载器会把自身与安装目录一并清掉；' +
    '如需重新使用，可再次运行安装包。',
  /** 完成页的补充说明：同样用真实落点，不写死盘符与目录名 */
  engineHint: (runtimesRoot: string) => `引擎数据目录位于 ${runtimesRoot}，未勾选时可手动清理。`,
  feedbackBtn: '打开反馈问卷（30 秒）',
  finishBtn: '完成',
} as const;

/** 三类全不勾 —— 新进来时就是这个值 */
export function emptyChecks(): DataChecks {
  return { music: false, manga: false, engine: false };
}

/** 至少勾了一类吗 —— 「狠心卸载」能不能点由它决定 */
export function hasAnyCheck(checks: DataChecks): boolean {
  return checks.music || checks.manga || checks.engine;
}
