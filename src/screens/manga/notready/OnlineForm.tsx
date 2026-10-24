import { Play, RefreshCw } from 'lucide-react';
import { Btn } from '@components/units';
import type { ServiceStatus } from '@/ipc';
import { summaryOf } from '@screens/manga/notready/copy';
import { NotReadyCard } from '@screens/manga/notready/NotReadyCard';
import { StateChip } from '@screens/manga/notready/chips';

/**
 * 形态① **在线精简页**（翻译来源 = 在线）。
 *
 * 为什么它只有一句现状 + 一枚按钮：在线来源下，翻译本身不走本地引擎，
 * 但**投放 / 队列 / 漫画库仍由本地服务承载** —— 用户此刻真正缺的只有"把 ① 拉起来"。
 * 摆五段时间线只会让人以为"翻译引擎没装好就不能用"。
 */
export function OnlineForm({
  status,
  onStart,
  onRestart,
}: {
  status: ServiceStatus | null;
  onStart: () => void;
  onRestart: () => void;
}) {
  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;
  const failed = state === 'error';
  const summary = summaryOf(state, err, !!status?.degraded);

  return (
    <NotReadyCard
      mood={summary.bad ? 'sleep' : undefined}
      kicker={<StateChip state={failed ? 'error' : 'stopped'} />}
      title={summary.title}
      desc={
        <>
          {failed && err ? `原因：${err} ` : ''}
          翻译来源已配置为在线平台，但漫画的投放、队列与漫画库仍由本地服务承载 —— 点下方按钮把本地服务拉起来。
        </>
      }
    >
      <div className="nr-actions">
        {state === 'stopped' ? (
          <Btn kind="primary" onClick={onStart}>
            <Play size={14} />
            启动本地服务
          </Btn>
        ) : (
          <Btn kind="primary" onClick={onRestart}>
            <RefreshCw size={14} />
            重启本地服务
          </Btn>
        )}
      </div>
    </NotReadyCard>
  );
}
