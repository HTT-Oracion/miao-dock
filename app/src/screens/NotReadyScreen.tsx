import { useState } from 'react';
import { Btn } from '@components/units';
import { errorText } from '@/ipc';
import type { ServiceStatus } from '@/ipc';
import { downloadEngineModels } from '@screens/settings/engine-api';

/**
 * L1–L4 启动分层（《02》§3 / 《09》§6.1）。
 *
 * 四层是「即开即用」的时间轴：用户看到的每一段等待都有名字，而不是一个转圈。
 *
 * 🔴 **文案逐字取自方案表，不得"顺手美化"** —— 这四句是《02》§3 表格与《09》§6.1 表格
 * 里同时写死的那一份，界面是它唯一的落点。改这里等于改方案。
 *
 * ⚠️ **L4 不属启动期**（《04》§4.5 已定：引擎的准备/卸载/降档都不新增客户端状态机节点）。
 * 所以这一段**永远不会被点亮成"进行中"**，它的状态词是「首图时完成」而不是「待开始」——
 * 用「待开始」会让用户以为卡在最后一段、一直在等它走完。
 */
const STAGES = [
  { id: 'L1', text: '正在检查运行环境' },
  { id: 'L2', text: '正在准备翻译模型' },
  { id: 'L3', text: '正在预热' },
  { id: 'L4', text: '首张稍慢，后续加快' },
] as const;

/** Rust `phase` 值 → 阶段下标。**唯一**的进度事实源，见下面 `reached` 的注释。 */
const PHASE_INDEX: Record<string, number> = { L1: 0, L2: 1, L3: 2 };

/**
 * 当前阶段明细：取**真实日志的末行**（Rust 的 LogBuffer，含三个子进程的 stdout）。
 *
 * 🔴 为什么不显示「2.1/4.6 GB」这种字节进度：X-C3 只在 **box-service 自己没起来**时出现，
 *    此刻没有任何 HTTP 通道可读下载进度，编一个数字就是撒谎。方案要的"可量化进度"
 *    由**真实来源**满足 —— 谁真的在打进度行（`fetch-models` / uvicorn / llama-server），
 *    那一行就会原样出现在这里。**没有就不显示，不补一个占位数字。**
 */
function lastLogLine(log: string[] | undefined): string | null {
  if (!log || log.length === 0) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const s = (log[i] ?? '').trim();
    if (s) return s;
  }
  return null;
}

/**
 * 画面 X-C3 · 服务未就绪 / 启动中（《02》§4）。
 *
 * 展示 L1–L4 阶段进度 + 当前阶段文案 + 日志入口 + 重试；sidecar 未就绪时为 `degraded`。
 * 这一屏的责任不是「道歉」，而是**把卡在哪儿说清楚** —— 所以日志默认展开、可复制。
 */
export function NotReadyScreen({
  status,
  onRestart,
  onToast,
}: {
  status: ServiceStatus | null;
  onRestart: () => void;
  onToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
}) {
  const [showLog, setShowLog] = useState(true);
  const [busy, setBusy] = useState(false);

  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;
  const failed = state === 'error';

  /**
   * 已完成的阶段数。
   *
   * 🔴 早先这里写的是 `status?.sidecar_port ? 2 : 1` —— 拿"引擎端口存不存在"猜阶段。
   *    它有两处必然出错：① 端口先于阶段就绪（② 端口在听 ≠ L2 探针已过）时会把 L1 显示成 L2；
   *    ② 引擎已起但 ③ 还没答 HTTP 时，L3 永远点不亮，用户看到的是"卡在第二段"。
   *    现在按 Rust 状态机的 `phase` 逐值映射，**没有 phase 就不假装有进度**。
   */
  const idx = status?.phase ? (PHASE_INDEX[status.phase] ?? 0) : 0;
  const reached = state === 'running' ? STAGES.length : idx;

  const detail = lastLogLine(status?.log);

  const redownload = async () => {
    setBusy(true);
    try {
      await downloadEngineModels();
      onToast('已开始重新下载模型 —— 进度见「设置 → 翻译服务 → 引擎诊断」', 'info');
    } catch (e) {
      // 失败照实说：这里报的往往是"服务此刻不可达 / 已有下载在跑"，两者都不是"下载坏了"
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  /** 阶段状态词。L4 单列一支：它不是启动期的一步，见 STAGES 上方注释 */
  const noteOf = (i: number) => {
    if (i < reached) return '已完成';
    if (i === reached) return failed ? '失败' : '进行中';
    return STAGES[i]?.id === 'L4' ? '首图时完成' : '待开始';
  };

  return (
    <div className="notready">
      <div className={failed ? 'notice is-bad' : 'notice'}>
        {failed ? (
          <>
            <b>本地服务没能起来。</b>
            {err ? <> 原因：{err}</> : null} 翻译任务暂时提交不了；浏览器插件此刻也会收到 503。
          </>
        ) : state === 'stopped' ? (
          <>
            <b>本地服务未启动。</b> 点「重启本地服务」把它拉起来。
          </>
        ) : state === 'stopping' ? (
          <>
            <b>正在停止本地服务。</b> 子进程树回收需要几秒；完成后再点「重启本地服务」。
          </>
        ) : (
          <>
            <b>正在准备本地翻译服务。</b> 首次启动需要装载模型；这一步以后，翻译是纯本地的，
            不会把图片传到任何远端。
          </>
        )}
      </div>

      {state === 'starting' || state === 'running' ? (
        <div className="stage-hint">
          当前阶段：<b>{STAGES[idx]?.text ?? STAGES[0].text}</b>
          {status?.phase === 'L3' ? '（预热没有可量化的进度，属于不定态）' : null}
        </div>
      ) : null}

      {STAGES.map((s, i) => (
        <div
          key={s.id}
          className={
            (i === reached && !failed ? 'stage is-current' : 'stage') +
            (i === reached && failed ? ' is-failed' : '')
          }
        >
          <span className="stage-idx num">{i + 1}</span>
          <div>
            <div className="stage-text">{s.text}</div>
            {i === 1 && detail && i === reached ? (
              /* L2 明细：真实日志末行原样 —— 不重排、不截断成"看起来像进度"的样子 */
              <div className="stage-detail">{detail}</div>
            ) : null}
          </div>
          <span className="stage-note">{noteOf(i)}</span>
        </div>
      ))}

      <div className="stage-meta">
        {/* `mode` 必须显式可见：否则"以为在跑真引擎、其实跑的替身"最难查 */}
        <span className="stage-meta-item">
          引擎模式 <b>{status?.mode ?? '—'}</b>
        </span>
        <span className="stage-meta-item">
          三进程{' '}
          {(status?.children ?? [])
            .map((c) => `${c.name}${c.alive ? '✓' : '✗'}${c.pid ? `(${c.pid})` : ''}`)
            .join(' · ') || '—'}
        </span>
        {status?.port ? <span className="stage-meta-item">服务端口 {status.port}</span> : null}
        {status?.sidecar_port ? <span className="stage-meta-item">引擎端口 {status.sidecar_port}</span> : null}
        {status?.llm_port ? <span className="stage-meta-item">③ 端口 {status.llm_port}</span> : null}
      </div>

      {status?.degraded ? (
        <div className="notice is-bad">
          <b>服务已降级。</b> ② 或 ③ 掉了一个，但 ① 还在 —— 服务能应答，翻译任务会失败。
          诊断见「设置 → 翻译服务 → 引擎诊断」。
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/*
         * 重试按**失败阶段**给按钮（《02》§4「按失败阶段提供『重试当前阶段』」）：
         * L2 失败 ⇒ 用户真正该做的是重下模型，而不是重启整条链路 —— 后者只是把同一件
         * 坏掉的事重做一遍。两条都给，是因为 L2 失败也可能是"服务被带崩了"。
         */}
        {failed && status?.phase === 'L2' ? (
          <Btn kind="primary" disabled={busy} onClick={() => void redownload()}>
            {busy ? '正在发起…' : '重新下载模型'}
          </Btn>
        ) : null}
        <Btn kind={failed && status?.phase === 'L2' ? 'ghost' : 'primary'} onClick={onRestart}>
          重启本地服务
        </Btn>
        <Btn kind="ghost" onClick={() => setShowLog((v) => !v)}>
          {showLog ? '收起日志' : '查看日志'}
        </Btn>
      </div>

      {showLog ? (
        <div className="logbox">
          {(status?.log ?? []).slice(-120).join('\n') || '（暂无日志）'}
        </div>
      ) : null}
    </div>
  );
}
