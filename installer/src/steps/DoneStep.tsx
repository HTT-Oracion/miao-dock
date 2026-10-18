import { DONE, INSTALL, stepMeta } from '../data';
import type { InstallEnv } from '../host';
import { CheckRow } from '../parts/CheckRow';
import { NoticeBar } from '../parts/NoticeBar';
import { StepBar } from '../parts/StepBar';
import { WinShell } from '../parts/WinShell';

/** 完成页彩带的六枚色块（顺序即错峰顺序，颜色由 css 的 nth-child 给出） */
const CONFETTI = [0, 1, 2, 3, 4, 5];

/**
 * 步骤 3 / 3 · 安装完成。
 *
 * 收尾只留两件**可反悔**的事：要不要桌面快捷方式、要不要现在就打开。两者默认勾选 ——
 * 首次打开会顺带引导下载翻译引擎，所以第二段说明把这件事提前讲明（它不在安装向导里做）。
 * 长路径那条提示**只在宿主探测到"没开"时**才出现（已开 / 探测不到都不打扰）。
 */
export function DoneStep({
  env,
  shortcut,
  launch,
  onToggleShortcut,
  onToggleLaunch,
  onViewLog,
  onFinish,
}: {
  env: InstallEnv;
  shortcut: boolean;
  launch: boolean;
  onToggleShortcut: () => void;
  onToggleLaunch: () => void;
  onViewLog: () => void;
  onFinish: () => void;
}) {
  // 探测不到（null）也提示 —— 保守口径：宁可多提醒一次，不可默默放过
  const longPathMissing = env.longPathEnabled !== true;

  return (
    <WinShell
      title={INSTALL.winTitle}
      tag={stepMeta('done').tag}
      foot={
        <>
          <span className="isr-foot-left">{DONE.footNote(INSTALL.version, env.logPath)}</span>
          <span className="isr-foot-grow" />
          <button type="button" className="isr-btn isr-btn-ghost" onClick={onViewLog}>
            查看安装日志
          </button>
          <button type="button" className="isr-btn isr-btn-primary" onClick={onFinish}>
            完成 ✓
          </button>
        </>
      }
    >
      <StepBar current="done" />

      <div className="isr-done">
        <img className="isr-done-logo" src="/assets/icons/miao-logo.png" alt="喵坞" />
        <div>
          <h2>{DONE.hero}</h2>
          <p>{DONE.heroSub}</p>
        </div>
      </div>

      <div className="isr-confetti">
        {CONFETTI.map((i) => (
          <i key={i} />
        ))}
      </div>

      <div className="isr-opt-list">
        <CheckRow checked={shortcut} title={DONE.shortcut} desc={DONE.shortcutDesc} onToggle={onToggleShortcut} />
        <CheckRow checked={launch} title={DONE.launch} desc={DONE.launchDesc} onToggle={onToggleLaunch} />
      </div>

      {longPathMissing ? <NoticeBar kind="warn">{DONE.longPathTip}</NoticeBar> : null}
    </WinShell>
  );
}
