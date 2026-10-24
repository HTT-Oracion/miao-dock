import { AlertTriangle, Download, Info, Play, RefreshCw, Settings, Terminal } from 'lucide-react';
import { Btn, LogBlock } from '@components/units';
import { errorText, type ServiceStatus } from '@/ipc';
import { copyText } from '@tools';
import { toastBus } from '@/stores/toastBus';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import { downloadEngineModels } from '@screens/settings/engine-api';
import { stateView } from '@/stores/nav';
import { AssemblyTimeline } from '@screens/manga/AssemblyTimeline';
import type { StageNote } from '@screens/manga/assembly';
import { descOf, NOT_READY_TITLE } from '@screens/manga/notready/copy';
import { isL2Failure } from '@screens/manga/notready/derive';
import { NotReadyCard } from '@screens/manga/notready/NotReadyCard';
import { StateChip } from '@screens/manga/notready/chips';

/**
 * 形态③ **服务状态页**（资产已装配、只是本地服务没起来）。
 *
 * 四种状态共用一张卡，动作按状态分派：
 * · `stopped`     → 启动本地服务（不是"重启"：对停止的服务说重启是错的，还多走一次阻塞 stop）
 * · `starting/stopping` → 一个禁用按钮 + 日志（此刻没有可点的推进动作）
 * · `error`       → L2 失败给「重新下载模型」，其余给「重启本地服务」
 * · `running`     → 重启（此时通常是被降级/异常后的残留形态）
 */
export function ServiceForm({
  status,
  download,
  notes,
  detail,
  logOpen,
  busy,
  onToggleLog,
  onStart,
  onRestart,
  onOpenGuide,
  onToast,
}: {
  status: ServiceStatus | null;
  download: ModelDownloadView | null;
  notes: StageNote[];
  detail: string | null;
  logOpen: boolean;
  busy: boolean;
  onToggleLog: () => void;
  onStart: () => void;
  onRestart: () => void;
  onOpenGuide: () => void;
  onToast: (msg: string, kind?: 'info' | 'bad' | 'good') => void;
}) {
  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;
  const failed = state === 'error';
  const degraded = !!status?.degraded;
  const l2Failed = isL2Failure(status);

  const logBtn = (
    <Btn kind="ghost" ariaExpanded={logOpen} onClick={onToggleLog}>
      <Terminal size={14} />
      {logOpen ? '收起日志' : '查看日志'}
    </Btn>
  );

  const restartBtn = (
    <Btn kind={l2Failed ? 'ghost' : 'primary'} onClick={onRestart}>
      <RefreshCw size={14} />
      重启本地服务
    </Btn>
  );

  const settingsBtn = (
    <Btn kind="ghost" onClick={onOpenGuide}>
      <Settings size={14} />
      服务设置
    </Btn>
  );

  /** 动作行：按状态分派，四支互斥（不写内联长链三元，见工程纪律第 8 条） */
  const actionsOf = () => {
    if (state === 'stopped') {
      return (
        <>
          <Btn kind="primary" onClick={onStart}>
            <Play size={14} />
            启动本地服务
          </Btn>
          {settingsBtn}
          {logBtn}
        </>
      );
    }
    if (state === 'starting' || state === 'stopping') {
      return (
        <>
          <Btn kind="primary" disabled>
            <span className="spinner" />
            {state === 'starting' ? '正在启动…' : '正在停止…'}
          </Btn>
          {logBtn}
        </>
      );
    }
    if (failed) {
      return (
        <>
          {l2Failed ? (
            <Btn kind="primary" disabled={busy} onClick={() => void redownload(onToast)}>
              <Download size={14} />
              {busy ? '正在发起…' : '重新下载模型'}
            </Btn>
          ) : null}
          {restartBtn}
          {logBtn}
          {settingsBtn}
        </>
      );
    }
    return (
      <>
        {restartBtn}
        {logBtn}
      </>
    );
  };

  return (
    <NotReadyCard
      mood={failed ? 'sleep' : undefined}
      kicker={<StateChip state={failed ? 'error' : state} />}
      title={NOT_READY_TITLE[state as keyof typeof NOT_READY_TITLE] ?? stateView(state).text}
      desc={descOf(state, download)}
    >
      <div className="nr-actions">{actionsOf()}</div>

      {/* 五段时间线：已装配 ⇒ 前四段全打勾；启动期只有「就绪」在进行中 */}
      <AssemblyTimeline notes={notes} detail={detail} />

      {/* 一行 meta：正常时它是"都活着"，不值得占三行；异常时才转红 */}
      <div className="nr-meta">
        <span className="mchip">引擎模式 {status?.mode ?? '—'}</span>
        <span className={degraded ? 'mchip is-bad' : 'mchip'}>
          三进程{' '}
          {(status?.children ?? [])
            .map((c) => `${c.name}${c.alive ? '✓' : '✗'}${c.pid ? `(${c.pid})` : ''}`)
            .join(' · ') || '—'}
        </span>
        {status?.port ? <span className="mchip">服务 :{status.port}</span> : null}
        {status?.sidecar_port ? <span className="mchip">引擎 :{status.sidecar_port}</span> : null}
        {status?.llm_port ? <span className="mchip">③ :{status.llm_port}</span> : null}
      </div>

      {/* 异常时：三格诊断 + 逐行原因 + 日志（设计稿 `.nr-diag` / `.nr-list` / `.nr-log`） */}
      {failed ? (
        <>
          <div className="nr-diag">
            <span>
              服务端口
              <b>{status?.port ? `:${status.port} · 无响应` : '未监听'}</b>
            </span>
            <span>
              引擎端口
              <b>{status?.sidecar_port ? `:${status.sidecar_port} · 已停止` : '未监听'}</b>
            </span>
            <span>
              三进程
              <b>
                {(status?.children ?? []).filter((c) => c.alive).length} / {status?.children?.length ?? 0} 存活
              </b>
            </span>
          </div>
          <div className="nr-list">
            {(status?.children ?? [])
              .filter((c) => !c.alive)
              .map((c) => (
                <div key={c.name} className="nr-list-row">
                  <AlertTriangle size={13} className="is-bad" />
                  <span>{c.name} 子进程未存活</span>
                  <code>{c.pid ? `pid ${c.pid}` : 'no pid'}</code>
                </div>
              ))}
            {err ? (
              <div className="nr-list-row">
                <AlertTriangle size={13} className="is-bad" />
                <span>{err}</span>
                <code>{status?.phase ?? '—'}</code>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {logOpen ? (
        <LogBlock
          variant="compact"
          copy={copyText}
          text={(status?.log ?? []).slice(-120).join('\n')}
          emptyText="（暂无日志）"
          onCopied={() => toastBus.push('日志已复制', 'good', '已复制全部可见行')}
          onCopyError={(e) => toastBus.push('复制失败', 'bad', errorText(e))}
        />
      ) : null}

      {state === 'stopped' || state === 'starting' || state === 'stopping' ? (
        <p className="nr-foot-hint">
          <Info size={12} />
          提示：可以在「设置 → 翻译服务 → 自动启动翻译服务」里让喵坞启动时自动拉起服务。
        </p>
      ) : null}
    </NotReadyCard>
  );
}

/** 「重新下载模型」：保留原有能力（L2 失败时）。 */
async function redownload(push: (msg: string, kind?: 'info' | 'bad' | 'good') => void) {
  try {
    await downloadEngineModels();
    push('已开始重新下载模型 —— 进度见「设置 → 翻译服务 → 引擎诊断」', 'info');
  } catch (e) {
    push(errorText(e), 'bad');
  }
}
