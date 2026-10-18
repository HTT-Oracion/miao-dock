import { FolderOpen } from 'lucide-react';
import { INSTALL, stepMeta } from '../data';
import type { InstallEnv } from '../host';
import { formatBytes } from '../tools/format';
import { NoticeBar } from '../parts/NoticeBar';
import { WinShell } from '../parts/WinShell';

/**
 * 步骤 1 / 3 · 选择安装目录。
 *
 * 默认目录、体积、可用空间**全部来自宿主探测**（`env`），界面不做任何换算之外的加工 ——
 * 探测不到时显示 `--`，比写死一个数诚实。
 */
export function DirStep({
  env,
  dir,
  onBrowse,
  onCancel,
  onNext,
}: {
  env: InstallEnv;
  dir: string;
  onBrowse: () => void;
  onCancel: () => void;
  onNext: () => void;
}) {
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
            安装包体积：<b>{formatBytes(env.sizeBytes)}</b>
          </span>
          <span>
            C: 可用空间：<b>{formatBytes(env.freeBytes)}</b>
          </span>
          <span>
            安装模式：<b>{env.mode}</b>
          </span>
        </div>
      </div>

      <NoticeBar>{INSTALL.dirTip}</NoticeBar>
    </WinShell>
  );
}
