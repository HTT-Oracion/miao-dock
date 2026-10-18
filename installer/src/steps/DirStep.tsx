import { FolderOpen } from 'lucide-react';
import { INSTALL, stepMeta } from '../data';
import type { InstallEnv } from '../host';
import { driveOf, formatBytes } from '../tools/format';
import { CheckRow } from '../parts/CheckRow';
import { NoticeBar } from '../parts/NoticeBar';
import { WinShell } from '../parts/WinShell';

/**
 * 步骤 1 / 3 · 选择安装目录与安装范围。
 *
 * 两套默认目录、体积、可用空间、两种范围的模式说明**全部来自宿主探测**（`env`），
 * 界面不做任何换算之外的加工 —— 探测不到时显示 `--`，比写死一个数诚实。
 *
 * 「仅为我安装」勾上就把目录切成当前用户那一套：**目录差别正是范围的定义**，
 * 两者分开改会得到「装到 Program Files 却只写 HKCU」这种谁都不认识的状态。
 */
export function DirStep({
  env,
  dir,
  perUser,
  modeText,
  onTogglePerUser,
  onBrowse,
  onCancel,
  onNext,
}: {
  env: InstallEnv;
  dir: string;
  perUser: boolean;
  /** 当前范围的模式说明（宿主给的两套文案之一） */
  modeText: string;
  onTogglePerUser: () => void;
  onBrowse: () => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const drive = driveOf(dir);
  const freeLabel = drive === '' ? '可用空间' : `${drive} 可用空间`;

  return (
    <WinShell
      title={INSTALL.winTitle}
      tag={stepMeta('dir').tag}
      foot={
        <>
          <span className="isr-foot-left">{INSTALL.estimate}</span>
          <span className="isr-foot-grow" />
          <button type="button" className="isr-btn isr-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="isr-btn isr-btn-primary" onClick={onNext}>
            下一步 →
          </button>
        </>
      }
    >
      <div className="isr-head">
        <img className="isr-head-logo" src="/assets/icons/miao-logo.png" alt="喵坞" />
        <div>
          <h2>欢迎使用喵坞安装向导</h2>
          <p>{INSTALL.welcome}</p>
        </div>
      </div>

      <div className="isr-field">
        <div className="isr-field-label">
          安装目录 <span className="isr-req">{INSTALL.dirHint}</span>
        </div>
        <div className="isr-path-row">
          <div className="isr-path-input">{dir || '（宿主未给出默认目录）'}</div>
          <button type="button" className="isr-btn isr-btn-ghost" onClick={onBrowse}>
            <FolderOpen size={13} />
            浏览…
          </button>
        </div>
        <div className="isr-meta-row">
          <span>
            安装包体积：<b>{formatBytes(env.payloadBytes)}</b>
          </span>
          <span>
            {freeLabel}：<b>{formatBytes(env.freeBytes)}</b>
          </span>
          <span>
            {INSTALL.scopeTitle}：<b>{modeText}</b>
          </span>
        </div>
      </div>

      <CheckRow checked={perUser} title={INSTALL.perUserTitle} desc={INSTALL.perUserDesc} onToggle={onTogglePerUser} />

      <NoticeBar>{INSTALL.dirTip}</NoticeBar>
    </WinShell>
  );
}
