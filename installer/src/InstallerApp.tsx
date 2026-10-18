import { useState } from 'react';
import { INSTALL, type StepKey } from './data';
import type { InstallEnv, InstallerHost } from './host';
import { DirStep } from './steps/DirStep';
import { LongPathStep } from './steps/LongPathStep';
import { DoneStep } from './steps/DoneStep';
import { WinShell } from './parts/WinShell';

/**
 * 安装引导的外壳：环境没探测完时只显示"探测中"，拿到环境后才挂载向导本体。
 *
 * 拆成两层的用意是让 `Wizard` 能假定 `env` 一定存在（不用到处写非空断言），
 * 而"探测中"这一态属于外壳自己的职责。
 */
export function InstallerApp({ host, env }: { host: InstallerHost; env: InstallEnv | null }) {
  if (env === null) return <Probing />;
  return <Wizard host={host} env={env} />;
}

/** 环境探测中：窗口先出来，内容等宿主回话 */
function Probing() {
  return (
    <WinShell
      title={INSTALL.winTitle}
      tag="准备中…"
      foot={<span className="isr-foot-left">{INSTALL.probingFoot}</span>}
    >
      <div className="isr-probing">{INSTALL.probing}</div>
    </WinShell>
  );
}

/**
 * 向导本体：目录（含范围）→ 长路径 → 完成。
 *
 * 这一层只管**界面自己的流转**（第几步、几个勾选项、失败原因）；
 * 真正干活的（解包安装、建入口、起应用）走 `host`，界面只发意图、渲染结果。
 */
function Wizard({ host, env }: { host: InstallerHost; env: InstallEnv }) {
  const [step, setStep] = useState<StepKey>('dir');
  const [perUser, setPerUser] = useState(env.perUserDefault);
  const [dir, setDir] = useState(env.perUserDefault ? env.userDir : env.machineDir);
  // 系统已经开了长路径 ⇒ 默认就勾上；没开或探测不到 ⇒ 默认不勾（引导用户看手动步骤）
  const [longPathOk, setLongPathOk] = useState(env.longPathEnabled === true);
  const [desktopShortcut, setDesktopShortcut] = useState(true);
  const [startMenuShortcut, setStartMenuShortcut] = useState(true);
  const [launch, setLaunch] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** 完成页补建入口时的失败说明；非空时再点「完成」只关窗 */
  const [shortcutFailures, setShortcutFailures] = useState<string[]>([]);

  const modeText = perUser ? env.modeUser : env.modeMachine;

  /** 换范围就把目录换成对应默认值 —— 两套目录的差别正是这两个范围的定义 */
  function togglePerUser(): void {
    const next = !perUser;
    setPerUser(next);
    setDir(next ? env.userDir : env.machineDir);
  }

  async function handleBrowse(): Promise<void> {
    const picked = await host.pickDir(dir);
    if (picked !== null) setDir(picked);
  }

  async function handleInstall(): Promise<void> {
    if (installing) return;
    setInstalling(true);
    setFailure(null);
    try {
      await host.runInstall(dir, perUser);
      setStep('done');
    } catch (error) {
      // 失败不往前走：停在长路径这一步，把原因摆出来让人能重试
      setFailure(reasonOf(error));
    } finally {
      setInstalling(false);
    }
  }

  /** 完成：按勾选补建入口 → 需要时起主程序 → 关窗；有入口失败就先留在页面上说清楚 */
  async function finish(): Promise<void> {
    if (shortcutFailures.length > 0) {
      void host.close();
      return;
    }
    try {
      const failures = await host.createShortcuts(dir, perUser, desktopShortcut, startMenuShortcut);
      if (failures.length > 0) {
        setShortcutFailures(failures);
        return;
      }
      if (launch) await host.launchApp(dir);
      void host.close();
    } catch (error) {
      setShortcutFailures([reasonOf(error)]);
    }
  }

  const cancel = (): void => {
    void host.close();
  };
  const viewLog = (): void => {
    void host.openLog(env.logPath);
  };
  const back = (): void => {
    setFailure(null);
    setStep('dir');
  };
  const toLongPath = (): void => setStep('longpath');

  if (step === 'dir') {
    return (
      <DirStep
        env={env}
        dir={dir}
        perUser={perUser}
        modeText={modeText}
        onTogglePerUser={togglePerUser}
        onBrowse={handleBrowse}
        onCancel={cancel}
        onNext={toLongPath}
      />
    );
  }
  if (step === 'longpath') {
    return (
      <LongPathStep
        checked={longPathOk}
        failure={failure}
        installing={installing}
        logPath={env.logPath}
        onToggle={() => setLongPathOk(!longPathOk)}
        onBack={back}
        onInstall={() => {
          void handleInstall();
        }}
      />
    );
  }
  return (
    <DoneStep
      env={env}
      shortcut={desktopShortcut}
      startMenu={startMenuShortcut}
      launch={launch}
      failures={shortcutFailures}
      onToggleShortcut={() => setDesktopShortcut(!desktopShortcut)}
      onToggleStartMenu={() => setStartMenuShortcut(!startMenuShortcut)}
      onToggleLaunch={() => setLaunch(!launch)}
      onViewLog={viewLog}
      onFinish={() => {
        void finish();
      }}
    />
  );
}

/** 宿主抛来的错误可能是字符串（Tauri 的 `Err(String)`）也可能是 Error */
function reasonOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
