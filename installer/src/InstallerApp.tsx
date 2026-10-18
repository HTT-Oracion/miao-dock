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
 * 向导本体：目录 → 长路径 → 完成。
 *
 * 这一层只管**界面自己的流转**（第几步、几个勾选项、失败码）；
 * 真正干活的（选目录、跑安装包）走 `host`，界面只发意图、渲染结果。
 */
function Wizard({ host, env }: { host: InstallerHost; env: InstallEnv }) {
  const [step, setStep] = useState<StepKey>('dir');
  const [dir, setDir] = useState(env.defaultDir);
  // 系统已经开了长路径 ⇒ 默认就勾上；没开或探测不到 ⇒ 默认不勾（引导用户看手动步骤）
  const [longPathOk, setLongPathOk] = useState(env.longPathEnabled === true);
  const [shortcut, setShortcut] = useState(true);
  const [launch, setLaunch] = useState(true);
  const [failure, setFailure] = useState<number | null>(null);

  async function handleBrowse(): Promise<void> {
    const picked = await host.pickDir(dir);
    if (picked !== null) setDir(picked);
  }

  async function handleInstall(): Promise<void> {
    const code = await host.runInstall(dir);
    if (code === 0) {
      setStep('done');
      return;
    }
    // 失败不往前走了：停在长路径这一步，把退出码摆出来让人能重试
    setFailure(code);
  }

  const finish = (): void => {
    void host.close();
  };
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
    return <DirStep env={env} dir={dir} onBrowse={handleBrowse} onCancel={cancel} onNext={toLongPath} />;
  }
  if (step === 'longpath') {
    return (
      <LongPathStep
        checked={longPathOk}
        failure={failure}
        logPath={env.logPath}
        onToggle={() => setLongPathOk(!longPathOk)}
        onBack={back}
        onInstall={handleInstall}
      />
    );
  }
  return (
    <DoneStep
      env={env}
      shortcut={shortcut}
      launch={launch}
      onToggleShortcut={() => setShortcut(!shortcut)}
      onToggleLaunch={() => setLaunch(!launch)}
      onViewLog={viewLog}
      onFinish={finish}
    />
  );
}
