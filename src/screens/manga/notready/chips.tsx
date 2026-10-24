import { Dot } from '@components/units';
import type { ServiceState } from '@/ipc';
import type { ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 引导页的两枚小徽标（状态胶囊 / 下载态胶囊）。
 *
 * 它们放在一起是因为**判据同源**：都是"用颜色 + 图标 + 文案三重编码"的状态件
 * （《02》§5.2：颜色不作唯一载体）。分成两个文件时，改配色容易只改一处 ——
 * 于是同一张卡上会出现两种"红"。
 */

/** 状态胶囊（设计稿 `.nr-kicker` 里那一枚）：三态配色，文案逐字。 */
export function StateChip({ state }: { state: ServiceState | 'unassembled' }) {
  if (state === 'error') {
    return (
      <span className="chip chip-danger">
        <Dot colorVar="--md-error" />
        需要处理
      </span>
    );
  }
  if (state === 'unassembled') {
    return (
      <span className="chip chip-warning">
        <Dot colorVar="--md-warning" />
        首次装配
      </span>
    );
  }
  return (
    <span className="chip chip-soft">
      <Dot colorVar="--md-muted" />
      本地服务
    </span>
  );
}

/**
 * 下载态徽标：进行中 / 中断才出现。
 *
 * `done` **不**在这里出现 —— 完成由下载页的「关闭下载」收尾；在引导页再挂一枚
 * "已完成"会让"装配好了"与"服务起来了"两件事混成一件。
 */
export function DownloadPill({ state }: { state: ModelDownloadView['state'] | undefined }) {
  if (state === 'running') {
    return (
      <span className="chip chip-soft">
        <Dot colorVar="--md-blue" pulse />
        引擎下载中
      </span>
    );
  }
  if (state === 'interrupted' || state === 'failed') {
    return (
      <span className="chip chip-danger">
        <Dot colorVar="--md-error" />
        下载已中断
      </span>
    );
  }
  return null;
}
