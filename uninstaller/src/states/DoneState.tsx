import { UNINSTALL, type DataKind } from '../data';
import type { UninstallProbe } from '../host';
import { NoticeBar } from '../parts/NoticeBar';
import { WinShell } from '../parts/WinShell';
import { runtimesRoot } from '../tools/paths';
import { buildOutcome } from '../tools/summary';

/**
 * 卸载完成 —— 如实汇总本次删了什么、留了什么。
 *
 * 这一屏的价值在于**要是事实**：勾了却没删、没勾反而删了，都会在这里露出来。
 * 因此清单由 `buildOutcome` 从探测画像与最终勾选算出来，而不是把上一屏的文案照抄一遍。
 */
export function DoneState({
  probe,
  targets,
  onFeedback,
  onFinish,
}: {
  probe: UninstallProbe;
  /** 最终真的删掉的几类 */
  targets: DataKind[];
  onFeedback: () => void;
  onFinish: () => void;
}) {
  const { deleted, kept } = buildOutcome(probe.data, targets);

  return (
    <WinShell
      title={UNINSTALL.winTitle}
      tag={UNINSTALL.doneTag}
      foot={
        <>
          <span className="uns-foot-grow" />
          <button type="button" className="uns-btn uns-btn-ghost" onClick={onFeedback}>
            {UNINSTALL.feedbackBtn}
          </button>
          <button type="button" className="uns-btn uns-btn-primary" onClick={onFinish}>
            {UNINSTALL.finishBtn}
          </button>
        </>
      }
    >
      <div className="uns-bye">
        <img className="uns-bye-logo" src="/assets/icons/miao-logo.png" alt="喵坞" />
        <div>
          <h2>{UNINSTALL.doneTitle}</h2>
          <p>{UNINSTALL.doneSub}</p>
        </div>
      </div>

      <NoticeBar>
        {deleted.length > 0 ? <div>已删除：{deleted.join(' · ')}。</div> : null}
        {kept.length > 0 ? <div>保留清单：{kept.join(' · ')}（均未触碰）。</div> : <div>全部数据已按勾选删除。</div>}
        <div className="uns-outcome-hint">{UNINSTALL.engineHint(runtimesRoot(probe.data.engine.path))}</div>
      </NoticeBar>
    </WinShell>
  );
}
