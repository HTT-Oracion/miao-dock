/**
 * 安装向导的固定文案。
 *
 * 🔴 这里**只有文案**，没有任何数字：默认目录、程序体积、可用空间、长路径开关
 *    全部由宿主实时探测后经 `host.ts` 的 `InstallEnv` 传进来（见该文件说明）。
 *    把演示值写死在这里，将来体积一变就会与真实值打架 —— 那正是本次要消除的形态。
 */

/** 三步；`key` 同时是状态机的取值 */
export interface StepMeta {
  key: StepKey;
  name: string;
  tag: string;
}

export type StepKey = 'dir' | 'longpath' | 'done';

/** 三步的完整信息（顺序给 `STEP_ORDER`，这里只按 key 查） */
export const STEPS: Record<StepKey, StepMeta> = {
  dir: { key: 'dir', name: '选择目录', tag: '步骤 1 / 3 · 选择目录' },
  longpath: { key: 'longpath', name: '确认长路径', tag: '步骤 2 / 3 · 确认长路径' },
  done: { key: 'done', name: '完成', tag: '步骤 3 / 3 · 完成' },
};

/** 步骤顺序 —— 指示器的排布与序号都按它 */
export const STEP_ORDER: StepKey[] = ['dir', 'longpath', 'done'];

export function stepMeta(key: StepKey): StepMeta {
  return STEPS[key];
}

/** 步骤序号（0 起）；指示器用它判"已完成 / 当前 / 未到" */
export function stepIndex(key: StepKey): number {
  return STEP_ORDER.indexOf(key);
}

export const INSTALL = {
  winTitle: '喵坞 安装向导',
  version: '2.2.1',
  probing: '正在读取安装环境…',
  probingFoot: '正在与安装器通信',
  dirHint: '一般使用默认值即可',
  welcome: '请选择喵坞的安装目录。建议放在固态硬盘上，读取会更快一些。',
  dirTip: '译稿、模型与缓存不存放在此目录，卸载时也不会被移除。此目录仅包含程序本身。',
  estimate: '预计耗时约 1 分钟',
  scopeTitle: '安装范围',
  perUserTitle: '仅为我安装',
  perUserDesc: '装到当前用户目录、不需要管理员权限；换个 Windows 账户就看不到喵坞了。',
  installing: '正在安装…',
  installingFoot: '正在释放程序文件，请勿关闭窗口',
} as const;

export const LONG_PATH = {
  title: '安装前，请先确认「长路径支持」',
  intro: '翻译引擎的依赖层级较深，可能超出 Windows 默认的路径长度上限。开启「长路径支持」可避免安装中途失败。',
  option: '我的 Windows 已开启「长路径支持」',
  /** 勾选与未勾选给的是**两套**说明：前者指路，后者安抚 + 指向下方手动步骤 */
  descChecked: '如不确定，可参照下方步骤开启。未开启时安装可能在中途报错，因此需要先行确认。',
  descUnchecked: '尚未开启也没有关系，可参照下方「手动操作」步骤处理。',
  okTip: '已确认开启，安装可以继续进行。',
  footNote: '长路径为系统级设置，安装程序只做检测与提示，不会自动修改',
  whyTitle: '为什么需要这一步？',
  reasons: [
    '翻译引擎的依赖层级较深（Python venv 与 transformers 等），文件路径逐层叠加。',
    '路径长度很容易超过 Windows 默认的 260 字符上限。',
    '未开启时，安装会在中途报出「文件名或扩展名太长」，报错位置与真正的原因相距较远，不易定位。',
  ],
  manualTitle: '未勾选时，需要手动操作（可直接复制）',
  manualSub: '请以管理员身份打开 PowerShell，粘贴以下命令并执行，然后重启电脑：',
  manualFoot:
    '操作方法：在开始菜单搜索 PowerShell，右键选择「以管理员身份运行」，粘贴命令并执行，随后重启电脑。' +
    '重启后可回到本向导补充勾选；也可以直接继续安装，安装完成后会再次检查并提示。',
} as const;

/**
 * 开启长路径的那一行命令。
 *
 * 多行只是为了界面上看得清；**不要**直接把它送去剪贴板 ——
 * 行尾续行符的处理见 `tools/cmd.ts` 的 `singleLineCommand`。
 */
export const LONG_PATH_CMD = [
  "New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' `",
  '  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force',
].join('\n');

export const DONE = {
  hero: '安装完成',
  heroSub: '以下是最后三项可选设置，默认勾选，可按需取消。',
  shortcut: '创建桌面快捷方式',
  shortcutDesc: '在桌面创建快捷方式，便于下次启动。（不勾选也可从开始菜单找到喵坞）',
  startMenu: '创建开始菜单快捷方式',
  startMenuDesc: '在开始菜单里放一枚喵坞入口；卸载时桌面与开始菜单两处会一并清除。',
  launch: '立即打开喵坞',
  launchDesc: '首次打开时会引导下载翻译引擎（约 10 GB，可跳过），也可以稍后在应用内下载。',
  /** 只在宿主探测到"长路径未开"时显示（`null` = 探测不到，也按未开处理） */
  longPathTip:
    '检测到系统尚未开启长路径。这不影响本次安装，但首次装配引擎时可能报出「文件名或扩展名太长」。' +
    '届时可按步骤 2 中的命令处理，应用内也会再次提醒。',
  shortcutFailedTitle: '有入口没能创建好（程序本身已装好，可照常使用）',
  footNote: (version: string, logPath: string) => `版本 v${version} · 安装日志：${logPath}`,
} as const;

/** 安装失败时摆在长路径这一步顶上的提示（失败原因由宿主给成人话，不再有退出码） */
export function installFailureText(reason: string, logPath: string): string {
  return `安装失败：${reason}。可重试一次；反复失败请查看安装日志 ${logPath}。`;
}
