import { useState } from 'react';
import { emptyChecks, UNINSTALL, type DataChecks, type DataKind, type Phase } from './data';
import type { UninstallProbe, UninstallerHost } from './host';
import { ConfirmState } from './states/ConfirmState';
import { ProgressState } from './states/ProgressState';
import { DoneState } from './states/DoneState';
import {
  buildPlan,
  deletionTargets,
  markRunning,
  progressPercent,
  stepCount,
  type ProgressLine,
} from './tools/progress';
import { WinShell } from './parts/WinShell';

/**
 * 卸载页的外壳：实时数据没探测完时只显示"统计中"，拿到画像后才挂载三态界面。
 *
 * 拆成两层的用意是让三态组件能假定 `probe` 一定存在（不用到处写非空断言），
 * 而"统计中"这一态属于外壳自己的职责。
 */
export function UninstallerApp({
  host,
  probe,
}: {
  host: UninstallerHost;
  /** 宿主实时探测的结果；null = 还在统计 */
  probe: UninstallProbe | null;
}) {
  if (probe === null) return <Probing />;
  return <Flow host={host} probe={probe} />;
}

/** 统计中：窗口先出来，内容等宿主回话 */
function Probing() {
  return (
    <WinShell
      title={UNINSTALL.winTitle}
      tag="统计中…"
      note={UNINSTALL.probingFoot}
      foot={<span className="uns-foot-left">{UNINSTALL.probing}</span>}
    >
      <div className="uns-probing">{UNINSTALL.probing}</div>
    </WinShell>
  );
}

/**
 * 三态界面：确认 → 进行中 → 完成。
 *
 * 只在内存里维护四件事：当前哪一屏、主开关的值、三类各自的勾选、卸载计划的进度。
 * 真正的删除动作由宿主执行（`host.runUninstall`），界面**不替它做** ——
 * 也因此保留了"最终删了哪几类"（`targets`）：点了「留下数据，只卸载程序」时
 * 即使下面有勾选也不删，因为用户最终选的是安全路径。
 */
function Flow({ host, probe }: { host: UninstallerHost; probe: UninstallProbe }) {
  const [phase, setPhase] = useState<Phase>('confirm');
  const [purge, setPurge] = useState(false);
  const [checks, setChecks] = useState<DataChecks>(emptyChecks);
  const [plan, setPlan] = useState<ProgressLine[]>([]);
  const [done, setDone] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [targets, setTargets] = useState<DataKind[]>([]);

  function togglePurge(): void {
    if (purge) {
      // 关总开关时把子项一并清空：留着"看不见却会被删"的勾选是最危险的形态
      setChecks(emptyChecks());
    }
    setPurge(!purge);
  }

  function toggleItem(kind: DataKind): void {
    setChecks({ ...checks, [kind]: !checks[kind] });
  }

  async function startUninstall(deleting: boolean): Promise<void> {
    const nextTargets = deleting ? deletionTargets(probe, checks) : [];
    const nextPlan = buildPlan(probe, nextTargets);
    setTargets(nextTargets);
    setPlan(nextPlan);
    setDone(0);
    setFailure(null);
    setPhase('running');

    // 只把"要删哪几类"交给宿主（文案留在界面）；宿主每完成一步回调"已完成几步"
    try {
      await host.runUninstall(nextTargets, (finished) => setDone(finished));
      setDone(stepCount(nextPlan));
      setPhase('done');
    } catch (error) {
      // 失败不假装完成：留在进行中屏，把原因摆出来
      setFailure(reasonOf(error));
    }
  }

  const cancel = (): void => host.close();
  const finish = (): void => host.close();

  if (phase === 'running') {
    const lines = markRunning(plan, done);
    return <ProgressState lines={lines} percent={progressPercent(plan, done)} failure={failure} />;
  }

  if (phase === 'done') {
    return <DoneState probe={probe} targets={targets} onFinish={finish} />;
  }

  return (
    <ConfirmState
      probe={probe}
      purge={purge}
      checks={checks}
      onTogglePurge={togglePurge}
      onToggleItem={toggleItem}
      onCancel={cancel}
      onKeepOnly={() => void startUninstall(false)}
      onPurge={() => void startUninstall(true)}
    />
  );
}

/** 宿主抛来的错误可能是字符串（Tauri 的 `Err(String)`）也可能是 Error */
function reasonOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
