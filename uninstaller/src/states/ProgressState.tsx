import { UNINSTALL } from '../data';
import { ProgressList } from '../parts/ProgressList';
import { NoticeBar } from '../parts/NoticeBar';
import { WinShell } from '../parts/WinShell';
import type { ProgressLine } from '../tools/progress';

/**
 * 卸载进行中 —— 每一步的处理内容实时可见。
 *
 * 未勾选项在这一屏必须明确写「已保留」（渐进行由 `buildPlan` 生成），
 * 因为"卸载在跑"这件事本身就会让人怀疑自己的数据还在不在。
 * 宿主报失败时不跳完成屏：把退出码摆在这一屏顶上，让人能重跑。
 */
export function ProgressState({
  lines,
  percent,
  failure,
}: {
  lines: ProgressLine[];
  percent: number;
  /** 卸载失败原因（人话）；null = 正常进行中 */
  failure: string | null;
}) {
  return (
    <WinShell
      title={UNINSTALL.winTitle}
      tag={`${UNINSTALL.runningTagPrefix} ${percent}%`}
      note={UNINSTALL.runningNote}
      foot={
        <>
          <span className="uns-foot-left">{UNINSTALL.runningFootLeft}</span>
          <span className="uns-foot-grow" />
        </>
      }
    >
      {failure === null ? null : <NoticeBar kind="warn">{UNINSTALL.failure(failure)}</NoticeBar>}

      <div className="uns-bye">
        <img className="uns-bye-logo" src="/assets/icons/miao-logo.png" alt="喵坞" />
        <div>
          <h2>{UNINSTALL.runningTitle}</h2>
          <p>{UNINSTALL.runningSub}</p>
        </div>
      </div>

      <ProgressList lines={lines} percent={percent} />
    </WinShell>
  );
}
