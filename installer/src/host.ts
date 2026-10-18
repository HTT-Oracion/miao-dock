/**
 * 宿主接缝 —— 向导界面（这一侧）与安装器程序（外壳）之间**唯一**的通道。
 *
 * 界面自己不起子进程、不解包、不碰文件系统与注册表：读环境、选目录、解包安装、
 * 建入口、启动应用、打开日志、关窗口，全部由宿主实现后**注入**给界面；
 * 界面只发意图、渲染结果。
 *
 * 三种实现，优先级从高到低：
 *   ① `window.miaoInstallerHost` —— 外部注入（自动化 / 走查时可替换，不常用）；
 *   ② Tauri 宿主（`installer/src-tauri`）—— 真实运行时走这条：命令契约见那里的 `main.rs`；
 *   ③ 预览替身 —— 纯浏览器开发（`npm run dev`，端口 1444）时用，不真的安装。
 */
import { invoke } from '@tauri-apps/api/core';

/** 安装环境画像 —— 全部由宿主**实时探测**，界面不写死任何一个数 */
export interface InstallEnv {
  /** 为所有用户的默认目录（`C:\Program Files\MiaoDock`） */
  machineDir: string;
  /** 仅为我安装的默认目录（`%LOCALAPPDATA%\Programs\MiaoDock`） */
  userDir: string;
  /** 内嵌载荷压缩后的体积（字节）—— 界面「安装包体积」的数据源 */
  payloadBytes: number;
  /**
   * 产品版本号（宿主从 `Cargo.toml` 给）。
   * 🔴 界面**不许**自己写一份：写死之后发版时完成页会印一个与包名对不上的版本。
   */
  version: string;
  /** 目标盘可用空间（字节） */
  freeBytes: number;
  /** 默认是否「仅为我安装」 */
  perUserDefault: boolean;
  /** 为所有用户的模式说明（宿主给，界面不写死） */
  modeMachine: string;
  /** 仅为我安装的模式说明 */
  modeUser: string;
  /**
   * 系统「长路径」开关是否已开。
   * `null` = 探测不到 —— 界面按**未开**处理（保守：宁可多提示一次，不可默默放过）。
   */
  longPathEnabled: boolean | null;
  /** 安装日志的**绝对路径**（由宿主解析；界面只负责显示与回传） */
  logPath: string;
}

export interface InstallerHost {
  /** 探测安装环境（两套默认目录 / 体积 / 可用空间 / 长路径开关） */
  probe(): Promise<InstallEnv>;
  /** 弹出目录选择；返回用户选的目录，取消返回 `null` */
  pickDir(current: string): Promise<string | null>;
  /** 解包安装到 `dir`；`perUser` 决定卸载项 hive 与入口落点。失败即抛错（人话） */
  runInstall(dir: string, perUser: boolean): Promise<void>;
  /** 完成页按勾选建 / 删入口；返回失败说明（空数组 = 全成功） */
  createShortcuts(dir: string, perUser: boolean, desktop: boolean, startMenu: boolean): Promise<string[]>;
  /** 「立即打开喵坞」—— 启动安装目录内的主程序（不继承安装器权限） */
  launchApp(dir: string): Promise<void>;
  /** 打开安装日志 */
  openLog(path: string): Promise<void>;
  /** 关闭向导窗口 */
  close(): Promise<void>;
}

/** Tauri 宿主：命令名与 `installer/src-tauri/src/main.rs` 的 `generate_handler!` 一一对应 */
const tauriHost: InstallerHost = {
  probe: () => invoke<InstallEnv>('probe_env'),
  pickDir: (current) => invoke<string | null>('pick_dir', { current }),
  runInstall: (dir, perUser) => invoke<void>('run_install', { dir, perUser }),
  createShortcuts: (dir, perUser, desktop, startMenu) =>
    invoke<string[]>('create_shortcuts', { dir, perUser, desktop, startMenu }),
  launchApp: (dir) => invoke<void>('launch_app', { dir }),
  openLog: (path) => invoke<void>('open_log', { path }),
  close: async () => {
    await invoke('close_window');
  },
};

/** 预览替身的取样值 —— 即设计稿里的演示值；真值一律由宿主实时探测 */
const PREVIEW_ENV: InstallEnv = {
  machineDir: 'C:\\Program Files\\MiaoDock',
  userDir: 'C:\\Users\\Doro\\AppData\\Local\\Programs\\MiaoDock',
  payloadBytes: 327_155_712, // 312 MB
  // 预览替身**不搬真版本号**：搬了就是前端的第三处硬编码（真值由宿主从 Cargo.toml 给）。
  // 界面上看到 `0.0.0-preview` 一眼就知道这是浏览器预览，不是装好的程序。
  version: '0.0.0-preview',
  freeBytes: 127_122_767_052, // 118.4 GB
  perUserDefault: false,
  modeMachine: '所有用户（需要管理员授权）',
  modeUser: '当前用户（无需管理员）',
  // 默认按"未开"给 —— 与设计稿的默认引导态（状态 B）一致
  longPathEnabled: false,
  logPath: 'C:\\Users\\Doro\\AppData\\Local\\Temp\\miao-dock-install.log',
};

/** 浏览器预览替身：不真的安装，只把流程跑通，便于开发时看界面 */
const previewHost: InstallerHost = {
  async probe() {
    await sleep(120);
    return PREVIEW_ENV;
  },
  async pickDir(current) {
    await sleep(80);
    return current;
  },
  async runInstall() {
    await sleep(900);
  },
  async createShortcuts() {
    await sleep(200);
    return [];
  },
  async launchApp() {
    /* 预览：不真的起进程 */
  },
  async openLog() {
    /* 预览：没有日志可看 */
  },
  async close() {
    /* 预览：浏览器里不关窗 */
  },
};

/** 解析宿主：外部注入 > Tauri 宿主 > 预览替身 */
export function resolveHost(): InstallerHost {
  if (window.miaoInstallerHost) return window.miaoInstallerHost;
  if ('__TAURI_INTERNALS__' in window) return tauriHost;
  return previewHost;
}

declare global {
  interface Window {
    /** 外部注入的宿主实现（自动化 / 走查用）；缺省时按运行环境选择 */
    miaoInstallerHost?: InstallerHost;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
