import { useState } from 'react';
import { Play } from 'lucide-react';
import { Btn, Pill } from '@components/units';
import { formatBytes } from '@tools';
import { errorText } from '@/ipc';
import { stateView } from '@/stores/nav';
import { useEngineDownload, useToasts } from '@hooks';
import type { ServiceStatus } from '@/ipc';
import { downloadEngineModels } from '@screens/settings/engine-api';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import type { TranslateSource } from '@screens/settings/translate-api';
import { ASSEMBLY_PHASES, assemblyNotes, type StageNote } from '@screens/library/assembly';
import { AssemblyTimeline } from '@screens/library/AssemblyTimeline';

/**
 * 画面 X-C3 · 服务未就绪 / 启动中 / 引擎装配（《02》§4）。
 *
 * 三种形态：
 *  ① **在线精简页**（来源=在线）：只一句现状 + 一枚启动按钮。
 *  ② **装配流程页**（D-233）：五段时间线 + 第一个未完成模型段下的两条路。
 *  ③ **服务状态页**：资产已装配、只是本地服务没起来（stopped/error/running/starting）。
 *
 * ## 五段与「下载两步」不是同一台状态机
 * `modelDownload.step`（prepare/runtime/visual/llm）回答装配到哪一段；
 * `modelDownload.stage`（stage1/stage2）只服务下载详情页的两轮指示器。
 * 本屏只消费前者与 `runtime.sets`，不再拿 `status.phase` 当进度事实源。
 */

/** 真实日志末行（Rust 的 LogBuffer，含三个子进程的 stdout）。没有就不显示，不补占位。 */
function lastLogLine(log: string[] | undefined): string | null {
  if (!log || log.length === 0) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const s = (log[i] ?? '').trim();
    if (s) return s;
  }
  return null;
}

/**
 * 摘要行：一行主句 + 一句副行。
 *
 * 🔴 只讲**服务现状**，不掺装配进度 —— 装配进度归五段时间线。
 * 两个状态机混进同一句话，就会出现"文案说正在预热、时间线说在装 Python"这种自相矛盾。
 */
function summaryOf(state: string, err: string | null, degraded: boolean): { bad: boolean; title: string; sub: string } {
  if (state === 'error') {
    return {
      bad: true,
      title: '本地服务没能起来',
      sub: `${err ? `原因：${err} ` : ''}翻译任务暂时提交不了；浏览器插件此刻也会收到 503。`,
    };
  }
  if (degraded) {
    return {
      bad: true,
      title: '服务已降级',
      sub: '② 或 ③ 掉了一个，但 ① 还在 —— 服务能应答，翻译任务会失败。诊断见「设置 → 翻译服务 → 引擎诊断」。',
    };
  }
  if (state === 'running') {
    return {
      bad: false,
      title: '本地翻译服务已就绪',
      sub: '翻译全程在本机完成，图片不会上传到任何远端。',
    };
  }
  if (state === 'stopped') {
    return {
      bad: false,
      title: '本地服务未启动',
      sub: '点下方「启动本地服务」把它拉起来。首次启动需要装载模型，会慢一些。',
    };
  }
  if (state === 'stopping') {
    return {
      bad: false,
      title: '正在停止本地服务',
      sub: '子进程树回收需要几秒；完成后再点「重启本地服务」。',
    };
  }
  return {
    bad: false,
    title: '正在准备本地翻译服务',
    sub: '引擎已装好，服务正在把它拉起来；这一步没有可量化的进度，走完即就绪。',
  };
}

/** 下载按钮文案：只按真实 `step` 说，取不到就退回通用句。 */
function downloadLabelOf(busy: boolean, download: ModelDownloadView | null): string {
  if (busy) return '正在发起…';
  const state = download?.state;
  if (state === 'interrupted' || state === 'failed') return '继续下载';
  if (state !== 'running') return '开始下载';
  if (download?.step === 'visual') return '视觉模型下载中';
  if (download?.step === 'llm' || download?.step === 'models') return '翻译模型下载中';
  return '下载引擎中';
}

/** 下载态徽标：进行中/中断才出现；完成由下载页的「关闭下载」收尾。 */
function DownloadPill({ state }: { state: ModelDownloadView['state'] | undefined }) {
  if (state === 'running') return <Pill colorVar="--md-blue">引擎下载中</Pill>;
  if (state === 'interrupted' || state === 'failed') return <Pill colorVar="--md-error">下载已中断</Pill>;
  return null;
}

export function NotReadyScreen({
  status,
  source,
  download,
  onStart,
  onRestart,
  onOpenGuide,
  onOpenDownload,
  onDownloadStarted,
}: {
  status: ServiceStatus | null;
  /** 翻译来源（P-D1 / P-D3）。`online` 时本屏走**精简页** */
  source: TranslateSource | null;
  /** 引擎下载态 —— 五段时间线的唯一进度事实源 */
  download: ModelDownloadView | null;
  /** 手动启动（仅 `stopped` 时用） */
  onStart: () => void;
  onRestart: () => void;
  /** 运行时尚缺件时的指引入口（设置页完整诊断） */
  onOpenGuide: () => void;
  /** 开始/继续下载后切到下载页 */
  onOpenDownload: () => void;
  /** 把刚发起的下载视图写回壳层（下载页立刻有内容） */
  onDownloadStarted: (view: ModelDownloadView | null) => void;
}) {
  const { push: onToast } = useToasts();
  const { busy, start } = useEngineDownload();
  const [userLog, setUserLog] = useState<boolean | null>(null);
  const [trouble, setTrouble] = useState(false);

  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;
  const failed = state === 'error';
  const degraded = !!status?.degraded;
  const logOpen = userLog ?? failed;

  const notes = assemblyNotes(status, download);
  const activeIndex = notes.findIndex((n: StageNote) => n === 'active' || n === 'failed');
  const detail = lastLogLine(status?.log);
  const summary = summaryOf(state, err, degraded);
  const downloading = download?.state === 'running' || download?.state === 'interrupted';
  const stepLabel = activeIndex >= 0 ? ASSEMBLY_PHASES[activeIndex]?.text : null;

  // ---- 在线精简页 ----
  if (source === 'online') {
    return (
      <div className="notready">
        <div className={summary.bad ? 'nr-sum is-bad' : 'nr-sum'}>
          <span className="nr-dot" />
          <div>
            <div className="nr-sum-t">{summary.title}</div>
            <div className="nr-sum-d">
              {failed && err ? `原因：${err} ` : ''}
              翻译来源已配置为在线平台，但漫画的投放、队列与漫画库仍由本地服务承载 —— 点下方按钮把本地服务拉起来。
            </div>
          </div>
        </div>
        <div className="nr-acts">
          {state === 'stopped' ? (
            <Btn kind="primary" onClick={onStart}>
              启动本地服务
            </Btn>
          ) : (
            <Btn kind="primary" onClick={onRestart}>
              重启本地服务
            </Btn>
          )}
        </div>
      </div>
    );
  }

  // ---- 装配流程页（D1 运行时未装配）----
  const rt = status?.runtime;
  const runtimeUnready = status?.mode === 'real' && !!rt && !rt.ready;
  /*
   * 🔴 判据**只看**「real 档 + 运行时未就绪」，**不再附加 `state !== 'running'`**。
   * D6 闸门只挡 ②/③、① 照常起，此时 state 仍是 running 而引擎仍未装配 ——
   * 「引擎就绪与否」只能由 `runtime.ready` 回答，不能拿服务状态代理。
   */
  if (runtimeUnready && rt) {
    const totalText = rt.requiredBytes > 0 ? formatBytes(rt.requiredBytes) : null;

    const beginDownload = async () => {
      try {
        const r = await start(false);
        onDownloadStarted(r.view);
        // 单飞守卫（已在下载）也直接去下载页：用户要的是看进度，不是看报错。
        onOpenDownload();
      } catch (e) {
        onToast(errorText(e), 'bad');
      }
    };

    /*
     * LLM 段的「使用在线翻译」提示：**纯文本、不可点**。
     *
     * 🔴 在线翻译**只替代 ③ LLM**：图片仍要经 ② 视觉引擎处理，
     *    所以启用入口收敛到设置页 —— 流程页不再承担密钥填写，
     *    也不再给「下载 / 在线」二选一的岔路（下载按钮统一放在时间线下方）。
     */
    const onlineTip = (
      <div className="nr-guide-online">
        <span className="nr-guide-online-text">使用在线翻译</span>
        <span className="nr-guide-online-tip" title="请到设置页启用">
          ⓘ
        </span>
      </div>
    );
    const extra = { llm: onlineTip };

    return (
      <div className="nr-guide">
        {/* 服务状态：装配页顶部同样给五态文本 + 启动入口（① 没起来时，下载要先靠它） */}
        <div className="nr-sum">
          <div className="nr-sum-body">
            <div className="nr-sum-t">{stateView(state).text}</div>
          </div>
          {state === 'stopped' ? (
            <Btn kind="ghost" size="sm" title="启动服务" onClick={onStart}>
              <Play size={16} />
            </Btn>
          ) : null}
        </div>
        <div className="nr-guide-title">需要先装配本地引擎</div>
        <div className="nr-guide-sub">
          翻译引擎不随安装包分发 —— 第一次使用要在本机装配运行环境、
          视觉模型与翻译模型。下面两条路任选其一，都不需要懂命令行。
          {totalText ? ` 首次装配共约 ${totalText}。` : ''}
        </div>

        <div className="nr-guide-note">
          {downloading && stepLabel
            ? `当前处于第 ${activeIndex + 1} 段：${stepLabel}`
            : state === 'stopped'
              ? '本地服务未启动；下面是磁盘装配状态 —— 已装好的段会打勾，缺的段等你选下面两条路。'
              : '装配分五段：环境 → 运行环境 → 视觉模型 → 翻译模型 → 就绪。'}
        </div>
        <div className="nr-guide-gap" />

        <AssemblyTimeline notes={notes} detail={detail} extra={extra} />

        {/*
          时间线下方：唯一的下载入口。
          🔴 点了就走，按钮文本随下载态切换（「视觉模型下载中 / 翻译模型下载中」）——
             不再展开卡片，也不再让用户在「下载 / 在线」之间先选一条路。
        */}
        <div className="nr-guide-dl">
          <Btn kind="primary" disabled={busy || download?.state === 'running'} onClick={() => void beginDownload()}>
            {downloadLabelOf(busy, download)}
          </Btn>
          <DownloadPill state={download?.state} />
        </div>

        {/* 右下：排障信息（默认收起） */}
        <div className="nr-guide-trouble">
          <button type="button" className="nr-guide-toggle is-quiet" onClick={() => setTrouble(!trouble)}>
            {trouble ? '收起排障信息' : '查看排障信息'}
          </button>
        </div>
        {trouble ? (
          <div className="nr-guide-gap">
            <div className="nr-rt">
              {rt.items
                .filter((i) => !i.ok)
                .map((it) => (
                  <div key={it.id} className="nr-rt-item">
                    <div className="nr-rt-head">
                      <span className="nr-rt-id">{it.id}</span>
                      <span className="nr-rt-detail">{it.detail}</span>
                    </div>
                    {it.fix ? <div className="nr-rt-fix">{it.fix}</div> : null}
                  </div>
                ))}
            </div>
            <div className="nr-guide-gap">
              <Btn kind="ghost" onClick={onOpenGuide}>
                打开设置页查看完整诊断
              </Btn>
            </div>
            {logOpen ? (
              <div className="logbox nr-guide-gap">{(status?.log ?? []).slice(-120).join('\n') || '（暂无日志）'}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="notready">
      {/* ① 服务状态：文本跟 `stateView`（`pill` 的同一张表）一致，只显示文本 */}
      <div className="nr-sum">
        <div className="nr-sum-body">
          <div className="nr-sum-t">{stateView(state).text}</div>
          <div className="nr-sum-d">{summary.sub}</div>
        </div>
        {state === 'stopped' ? (
          <Btn kind="ghost" size="sm" title="启动服务" onClick={onStart}>
            <Play size={16} />
          </Btn>
        ) : null}
      </div>

      {/* ② 五段时间线（已装配 ⇒ 前四段全打勾；启动期只有「就绪」在进行中） */}
      {state === 'stopped' ? (
        <div className="nr-guide-note">本地服务未启动；点右上角「启动服务」后进入就绪。</div>
      ) : null}
      <AssemblyTimeline notes={notes} detail={detail} />

      {/* ③ 一行 meta */}
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

      {/* ④ 一行动作 */}
      <div className="nr-acts">
        {failed && status?.phase === 'L2' ? (
          <Btn kind="primary" disabled={busy} onClick={() => void redownload(onToast)}>
            {busy ? '正在发起…' : '重新下载模型'}
          </Btn>
        ) : null}
        {state !== 'stopped' ? (
          <Btn kind={failed && status?.phase === 'L2' ? 'ghost' : 'primary'} onClick={onRestart}>
            重启本地服务
          </Btn>
        ) : null}
        <Btn kind="ghost" onClick={() => setUserLog(!logOpen)}>
          {logOpen ? '收起日志' : '查看日志'}
        </Btn>
      </div>

      {logOpen ? <div className="logbox">{(status?.log ?? []).slice(-120).join('\n') || '（暂无日志）'}</div> : null}
    </div>
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
