/**
 * 宿主接缝 —— 向导界面（这一侧）与安装器程序（外壳）之间**唯一**的通道。
 *
 * 界面自己不起子进程、不碰文件系统：读环境、选目录、以 `/S` 静默跑安装包、
 * 打开日志、关窗口，全部由宿主实现后**注入**给界面；界面只发意图、渲染结果。
 *
 * 三种实现，优先级从高到低：
 *   ① `window.miaoInstallerHost` —— 外部注入（自动化 / 走查时可替换，不常用）；
 *   ② Tauri 宿主（`installer/src-tauri`）—— 真实运行时走这条：命令契约见那里的 `main.rs`；
 *   ③ 预览替身 —— 纯浏览器开发（`npm run dev`，端口 1444）时用，不真的安装。
 */
import { invoke } from '@tauri-apps/api/core';

/** 安装环境画像 —— 全部由宿主**实时探测**，界面不写死任何一个数 */
export interface InstallEnv {
  /** 默认安装目录（当前用户目录 ⇒ 免管理员） */
  defaultDir: string;
  /** 安装包体积（字节） */
  sizeBytes: number;
  /** 目标盘可用空间（字节） */
  freeBytes: number;
  /** 安装模式说明 */
  mode: string;
  /**
   * 系统「长路径」开关是否已开。
   * `null` = 探测不到 —— 界面按**未开**处理（保守：宁可多提示一次，不可默默放过）。
   */
  longPathEnabled: boolean | null;
  /** 安装日志的**绝对路径**（由宿主解析；界面只负责显示与回传） */
  logPath: string;
}

export interface InstallerHost {
  /** 探测安装环境（默认目录 / 体积 / 可用空间 / 长路径开关） */
  probe(): Promise<InstallEnv>;
  /** 弹出目录选择；返回用户选的目录，取消返回 `null` */
  pickDir(current: string): Promise<string | null>;
  /** 以 `/S` 静默执行安装包，装到 `installDir`；返回进程退出码（0 = 成功） */
  runInstall(installDir: string): Promise<number>;
  /** 打开安装日志 */
  openLog(path: string): Promise<void>;
  /** 关闭向导窗口 */
  close(): Promise<void>;
}

/** Tauri 宿主：命令名与 `installer/src-tauri/src/main.rs` 的 `generate_handler!` 一一对应 */
const tauriHost: InstallerHost = {
  probe: () => invoke<InstallEnv>('probe_env'),
  pickDir: (current) => invoke<string | null>('pick_dir', { current }),
  runInstall: (installDir) => invoke<number>('run_install', { installDir }),
  openLog: (path) => invoke<void>('open_log', { path }),
  close: async () => {
    await invoke('close_window');
  },
};

/** 预览替身的取样值 —— 即设计稿里的演示值；真值一律由宿主实时探测 */
const PREVIEW_ENV: InstallEnv = {
  defaultDir: 'C:\\Users\\Doro\\AppData\\Local\\Programs\\喵坞',
  sizeBytes: 327_155_712, // 312 MB
  freeBytes: 127_122_767_052, // 118.4 GB
  mode: '当前用户（无需管理员）',
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
    return 0;
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
