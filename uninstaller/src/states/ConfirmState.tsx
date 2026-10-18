import { formatBytes } from '../tools/format';
import { runtimesRoot } from '../tools/paths';
import { DATA_ITEMS, UNINSTALL, hasAnyCheck, type DataChecks, type DataKind } from '../data';
import type { DataProfiles, UninstallProbe } from '../host';
import { CheckRow } from '../parts/CheckRow';
import { NoticeBar } from '../parts/NoticeBar';
import { WinShell } from '../parts/WinShell';

/**
 * 主视图 · 告别确认。
 *
 * 默认态是"只卸载程序"：主开关不勾、三项数据锁着不可点 —— 想误删也删不掉。
 * 勾上主开关三项才亮起来，**勾了哪项卸载时才删哪项**；「狠心卸载」在没勾任何一项前
 * 保持禁用（这两个条件的合取就在 `canPurge`，不要在各处重判一遍）。
 *
 * 行尾的体积与路径全部来自宿主的实时探测：目录不在时显示"未安装 / 目录不存在"，
 * 而不是留一个写死的演示值 —— 那是本次改造要消除的主要形态。
 */
export function ConfirmState({
  probe,
  purge,
  checks,
  onTogglePurge,
  onToggleItem,
  onCancel,
  onKeepOnly,
  onPurge,
}: {
  probe: UninstallProbe;
  purge: boolean;
  checks: DataChecks;
  onTogglePurge: () => void;
  onToggleItem: (kind: DataKind) => void;
  onCancel: () => void;
  onKeepOnly: () => void;
  onPurge: () => void;
}) {
  const locked = !purge;
  const canPurge = purge && hasAnyCheck(checks);

  return (
    <WinShell
      title={UNINSTALL.winTitle}
      tag={UNINSTALL.confirmTag(probe.version)}
      note={UNINSTALL.footNoteBottom(runtimesRoot(probe.data.engine.path))}
      foot={
        <>
          <span className="uns-foot-left">{UNINSTALL.footNoteLeft}</span>
          <span className="uns-foot-grow" />
          <button type="button" className="uns-btn uns-btn-ghost" onClick={onCancel}>
            {UNINSTALL.cancelBtn}
          </button>
          <button type="button" className="uns-btn uns-btn-primary" onClick={onKeepOnly}>
            {UNINSTALL.keepOnlyBtn}
          </button>
          <button type="button" className="uns-btn uns-btn-danger" disabled={!canPurge} onClick={onPurge}>
            {UNINSTALL.purgeBtn}
          </button>
        </>
      }
    >
      <ConfirmHead />

      <NoticeBar>
        <b>{UNINSTALL.introLabel}</b>
        {UNINSTALL.introText}
      </NoticeBar>

      <CheckRow
        variant="master"
        checked={purge}
        badge={UNINSTALL.masterBadge}
        badgeKind="keep"
        title={UNINSTALL.masterTitle}
        desc={UNINSTALL.masterDesc}
        onToggle={onTogglePurge}
      />

      <div className="uns-sub-list">
        {DATA_ITEMS.map((item) => (
          <CheckRow
            key={item.kind}
            checked={checks[item.kind]}
            locked={locked}
            title={item.title}
            badge={item.badge}
            badgeKind={item.badgeKind}
            desc={item.desc}
            side={<DataFacts profiles={probe.data} kind={item.kind} />}
            onToggle={() => onToggleItem(item.kind)}
          />
        ))}
      </div>
    </WinShell>
  );
}

/** 页头：大头像 + 问句 + 一句交代 */
function ConfirmHead() {
  return (
    <div className="uns-bye">
      <img className="uns-bye-logo" src="/assets/icons/miao-logo.png" alt="喵坞" />
      <div>
        <h2>{UNINSTALL.confirmTitle}</h2>
        <p>{UNINSTALL.confirmSub}</p>
      </div>
    </div>
  );
}

/**
 * 行尾两行：实测体积 + 目录。
 *
 * 目录不在时不显示体积（`0 B` 会让人以为"有目录只是空的"），改标「未安装」；
 * 路径同理给「目录不存在」，不拿一个猜的路径糊弄。
 */
function DataFacts({ profiles, kind }: { profiles: DataProfiles; kind: DataKind }) {
  const profile = profiles[kind];
  return (
    <>
      <div className="uns-item-size">{profile.exists ? formatBytes(profile.sizeBytes) : UNINSTALL.missingSize}</div>
      <div className="uns-item-path">{profile.path || UNINSTALL.missingPath}</div>
    </>
  );
}
