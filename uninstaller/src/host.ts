/**
 * 宿主接缝 —— 卸载界面（这一侧）与卸载器程序（外壳）之间**唯一**的通道。
 *
 * 界面自己不起子进程、不碰文件系统：探测三类本地数据的目录与体积、执行卸载、
 * 关窗口，全部由宿主实现后**注入**给界面；界面只发意图、渲染结果。
 *
 * 三种实现，优先级从高到低：
 *   ① `window.miaoUninstallerHost` —— 外部注入（自动化 / 走查时可替换，不常用）；
 *   ② Tauri 宿主（`uninstaller/src-tauri`）—— 真实运行时走这条：命令契约见那里的 `main.rs`；
 *   ③ 预览替身 —— 纯浏览器开发（`npm run dev`，端口 1555）时用，不真的卸载。
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type { DataKind } from './data';

/**
 * 一类本地数据的实时画像。
 *
 * 🔴 目录与体积都**不许**由界面写死：它们随用户装到哪、用了多久而变，
 *    而且权威口径在产品侧（漫画 = `paths::root_dir()`、引擎 = `paths::runtimes_dir()`、
 *    音乐缓存 = `app_cache_dir()/music-cache`）—— 界面只负责显示宿主探测回来的结果。
 */
export interface DataProfile {
  /** 该数据的目录；宿主探不到时给空串 */
  path: string;
  /** 实测体积（字节）；目录不在时给 0 */
  sizeBytes: number;
  /** 目录是否真的存在于本机 */
  exists: boolean;
}

export type DataProfiles = Record<DataKind, DataProfile>;

/** 卸载页需要的全部实时数据（一次探测拿全，避免界面分多次来回问） */
export interface UninstallProbe {
  /** 三类本地数据的画像 */
  data: DataProfiles;
  /** 程序本体的实测体积（字节）—— "已移除程序文件与注册表项（…）"那一行用它 */
  programSizeBytes: number;
  /**
   * 产品版本号（宿主从 `Cargo.toml` 给）。
   * 🔴 界面**不许**自己写一份：写死之后发版时标题旁的标签会印一个与包名对不上的版本。
   */
  version: string;
}

export interface UninstallerHost {
  /** 实时探测：三类数据的目录 / 体积 / 存在性 + 程序本体体积 */
  probe(): Promise<UninstallProbe>;
  /**
   * 执行卸载。`targets` 是要删的几类（界面已按勾选 + 存在性筛过，**没勾的一律不碰**）；
   * 宿主每完成一步回调一次 `done`（从 1 起）。步数口径：
   * `2 + targets.length + 1`（入口 / 程序文件与注册表 / 逐项数据 / 安排自删），
   * 与界面 `tools/progress.ts` 的 `stepCount()` 同一条公式。失败即抛错（人话）。
   */
  runUninstall(targets: DataKind[], onProgress: (done: number) => void): Promise<void>;
  /** 关闭窗口 */
  close(): void;
}

/** Tauri 宿主：命令名与 `uninstaller/src-tauri/src/main.rs` 的 `generate_handler!` 一一对应 */
const tauriHost: UninstallerHost = {
  probe: () => invoke<UninstallProbe>('probe'),
  runUninstall: async (targets, onProgress) => {
    // 进度走 Tauri 的 Channel（命令参数名 on_progress ⇄ 这里 onProgress）
    const channel = new Channel<number>();
    channel.onmessage = (done) => onProgress(done);
    await invoke<void>('run_uninstall', { targets, onProgress: channel });
  },
  close: () => {
    void invoke('close_window');
  },
};

/** 预览替身的取样值 —— 即设计稿里的演示值；真值一律由宿主实时探测 */
const PREVIEW_PROBE: UninstallProbe = {
  data: {
    music: {
      path: '%LOCALAPPDATA%\\com.miaodock.desktop\\cache\\music-cache',
      sizeBytes: 1_288_490_188, // 1.2 GB
      exists: true,
    },
    manga: {
      path: '%USERPROFILE%\\Pictures\\Box 漫画',
      sizeBytes: 9_234_179_876, // 8.6 GB
      exists: true,
    },
    engine: {
      path: '%LOCALAPPDATA%\\runtimes\\manga-translator',
      sizeBytes: 13_529_146_982, // 12.6 GB
      exists: true,
    },
  },
  programSizeBytes: 327_155_712, // 312 MB
  // 预览替身**不搬真版本号**：搬了就是前端的第三处硬编码（真值由宿主从 Cargo.toml 给）
  version: '0.0.0-preview',
};

/** 浏览器预览替身：不真的卸载，只把三态流程跑通，便于开发时看界面 */
const previewHost: UninstallerHost = {
  async probe() {
    await sleep(150);
    return PREVIEW_PROBE;
  },
  async runUninstall(targets, onProgress) {
    // 与真实宿主同一条步数公式：2（入口 / 程序文件与注册表）+ 逐项 + 1（安排自删）
    const total = 2 + targets.length + 1;
    for (let done = 1; done <= total; done++) {
      await sleep(450);
      onProgress(done);
    }
  },
  close() {
    /* 预览：浏览器里不关窗 */
  },
};

/** 解析宿主：外部注入 > Tauri 宿主 > 预览替身 */
export function resolveHost(): UninstallerHost {
  if (window.miaoUninstallerHost) return window.miaoUninstallerHost;
  if ('__TAURI_INTERNALS__' in window) return tauriHost;
  return previewHost;
}

declare global {
  interface Window {
    /** 外部注入的宿主实现（自动化 / 走查用）；缺省时按运行环境选择 */
    miaoUninstallerHost?: UninstallerHost;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
