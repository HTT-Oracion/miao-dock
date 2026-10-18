import { CheckCircle2, Info } from 'lucide-react';
import { INSTALL, LONG_PATH, LONG_PATH_CMD, installFailureText, stepMeta } from '../data';
import { CheckRow } from '../parts/CheckRow';
import { CmdBlock } from '../parts/CmdBlock';
import { NoticeBar } from '../parts/NoticeBar';
import { StepBar } from '../parts/StepBar';
import { WinShell } from '../parts/WinShell';

/**
 * 步骤 2 / 3 · 确认长路径。
 *
 * 🔴 **默认态跟随系统实况**：宿主探测到已开 ⇒ 预勾（设计稿状态 A）；未开或探测不到 ⇒
 *    不勾并把手动步骤摆出来（状态 B）。不替用户改注册表 —— 系统级设置、要提权，
 *    当前用户模式没资格改，只读 + 告知（与 `installer/hooks.nsh` 的既有纪律一致）。
 */
export function LongPathStep({
  checked,
  failure,
  logPath,
  onToggle,
  onBack,
  onInstall,
}: {
  checked: boolean;
  /** 上一次安装的退出码；非 null 时在顶部摆出失败提示 */
  failure: number | null;
  /** 安装日志的绝对路径（失败提示里要指出来） */
  logPath: string;
  onToggle: () => void;
  onBack: () => void;
  onInstall: () => void;
}) {
  return (
    <WinShell
      title={INSTALL.winTitle}
      tag={stepMeta('longpath').tag}
      foot={
        <>
          <span className="isr-foot-left">{LONG_PATH.footNote}</span>
          <span className="isr-foot-grow" />
          <button type="button" className="isr-btn isr-btn-ghost" onClick={onBack}>
            ← 上一步
          </button>
          <button type="button" className="isr-btn isr-btn-primary" onClick={onInstall}>
            开始安装
          </button>
        </>
      }
    >
      <StepBar current="longpath" />

      {failure === null ? null : <NoticeBar kind="warn">{installFailureText(failure, logPath)}</NoticeBar>}

      <div className="isr-head">
        <img className="isr-head-logo" src="/assets/icons/miao-logo.png" alt="喵坞" />
        <div>
          <h2>{LONG_PATH.title}</h2>
          <p>{LONG_PATH.intro}</p>
        </div>
      </div>

      <CheckRow
        checked={checked}
        title={LONG_PATH.option}
        desc={checked ? LONG_PATH.descChecked : LONG_PATH.descUnchecked}
        onToggle={onToggle}
      />

      {checked ? <ConfirmedPanel /> : <UnconfirmedPanel />}
    </WinShell>
  );
}

/** 已确认：绿灯放行，不必再铺开原因与命令 */
function ConfirmedPanel() {
  return <NoticeBar kind="ok">{LONG_PATH.okTip}</NoticeBar>;
}

/** 未确认：把"为什么"列清楚，再把可一键复制的手动步骤给出来 */
function UnconfirmedPanel() {
  return (
    <>
      <div className="isr-why">
        <div className="isr-why-title">
          <Info size={13} />
          {LONG_PATH.whyTitle}
        </div>
        <ol>
          {LONG_PATH.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
      </div>

      <div className="isr-manual">
        <div className="isr-manual-title">
          <CheckCircle2 size={13} />
          {LONG_PATH.manualTitle}
        </div>
        <div className="isr-manual-sub">{LONG_PATH.manualSub}</div>
        <CmdBlock command={LONG_PATH_CMD} />
        <div className="isr-manual-foot">{LONG_PATH.manualFoot}</div>
      </div>
    </>
  );
}
