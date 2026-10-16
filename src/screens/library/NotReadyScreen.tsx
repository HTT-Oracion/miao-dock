import { useState } from 'react';
import { Btn } from '@components/units';
import { errorText } from '@/ipc';
import { useToasts } from '@hooks';
import type { ServiceStatus } from '@/ipc';
import { downloadEngineModels } from '@screens/settings/engine-api';
import { OnlineApiForm } from '@screens/settings/OnlineApiForm';
import type { TranslateSource } from '@screens/settings/translate-api';

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

/**
 * 启动期**只含** L1–L3。
 *
 * 🔴 它同时是 `reached` 的**上界**、和「L4 永远拿不到进行中 / 已完成」这条性质的
 * **结构性保证**：第 4 段既不可能 `i < reached`、也不可能 `i === reached`。
 * 用 `STAGES.length` 当上界会把 L4 也算成"走完了"，它就变成「已完成」——
 * 用户于是以为最后一段也在启动流程里、还要等它。
 */
const STARTUP_COUNT = STAGES.length - 1;

/** Rust `phase` 值 → 阶段下标。**唯一**的进度事实源，见下面 `reached` 的注释。 */
const PHASE_INDEX: Record<string, number> = { L1: 0, L2: 1, L3: 2 };

/** 1 GiB。写成常量而**不用 `1024 ** 3`**（`**` 与 markdown 粗体同形，见 `EngineDiag.tsx` 同款说明）。 */
const GIB = 1024 * 1024 * 1024;

/**
 * 状态词 → 时间线节点形态。
 *
 * 🔴 「进行中」是**唯一**带外圈旋转环的一支 —— 本屏新增的**显式 loading 态**。
 *    把"状态词 → 形态"收在**一处**，才不会出现「状态写着进行中、圈却不转」这种自相矛盾的画法。
 *    而旋转是用户区分"在动"与"卡住了"的**唯一**信号：不动的「进行中」看起来与卡住一模一样。
 */
const NODE_KIND: Record<string, string> = {
  已完成: 'is-done',
  进行中: 'is-loading',
  失败: 'is-failed',
  待开始: '',
  首图时完成: '',
};

/**
 * 当前阶段明细：取**真实日志的末行**（Rust 的 LogBuffer，含三个子进程的 stdout）。
 *
 * 🔴 为什么不显示「2.1/4.6 GB」这种字节进度：X-C3 只在 **manga-service 自己没起来**时出现，
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
 * 摘要行：一行主句 + 一句副行。
 */
function summaryOf(
  state: string,
  err: string | null,
  phase: string | null | undefined,
  degraded: boolean,
): { bad: boolean; title: string; sub: string } {
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
  if (phase === 'L3') {
    return {
      bad: false,
      title: '正在准备本地翻译服务',
      sub: '正在预热 —— 这一步没有可量化的进度，属不定态，走完即就绪。',
    };
  }
  return {
    bad: false,
    title: '正在准备本地翻译服务',
    sub: '首次启动需要装载模型；这一步之后，翻译是纯本地的，不会把图片传到任何远端。',
  };
}

/**
 * 画面 X-C3 · 服务未就绪 / 启动中（《02》§4）。
 *
 * 三种形态：
 *  ① **在线精简页**（来源=在线）：只一句现状 + 一枚启动按钮。
 *  ② **引导页（D1 运行时未装配）**：本地引擎一键下载 + 页内在线 API 表单 + 两者对照 + 排障折叠。
 *  ③ **四段时间线**：引擎已装配、只是本地服务没起来（stopped/error/running/starting）。
 */
export function NotReadyScreen({
  status,
  source,
  onStart,
  onRestart,
  onOpenGuide,
  onOpenDownload,
}: {
  status: ServiceStatus | null;
  /**
   * 翻译来源（P-D1 / P-D3）。`online` 时本屏走**精简页**；
   * `local` / `null`（读不到来源，按本地档处理）时维持引导页 / 时间线现状。
   */
  source: TranslateSource | null;
  /** 手动启动（仅 `stopped` 时用）。 */
  onStart: () => void;
  onRestart: () => void;
  /** D1：「运行时未装配」态上的**指引入口** —— 跳到设置页（翻译服务 → 引擎诊断/安装引导）。 */
  onOpenGuide: () => void;
  /** G5：点「开始下载」⇒ 发起下载并把内容区切到下载视图。 */
  onOpenDownload: () => void;
}) {
  const { push: onToast } = useToasts();
  const [userLog, setUserLog] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(false);
  const [trouble, setTrouble] = useState(false);

  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;
  const failed = state === 'error';
  const degraded = !!status?.degraded;
  const logOpen = userLog ?? failed;

  const idx = status?.phase ? (PHASE_INDEX[status.phase] ?? 0) : 0;
  const reached = state === 'running' ? STARTUP_COUNT : idx;

  const detail = lastLogLine(status?.log);
  const summary = summaryOf(state, err, status?.phase, degraded);

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

  // ---- 引导页（D1 运行时未装配）----
  const rt = status?.runtime;
  const runtimeUnready = status?.mode === 'real' && !!rt && !rt.ready;
  /*
   * 🔴 判据**只看**「real 档 + 运行时未就绪」，**不再附加 `state !== 'running'`**。
   *
   * 原先那个附加条件在 2026-10-16 被证明是错的（D-229）：D6 闸门当时连 ① 服务一起挡下
   * （一个子进程都不起），于是"未装配"时服务必不在、state 必不是 running —— 两个条件
   * **恰好同时成立**，看不出问题。闸门改成"只挡 ②/③、① 照常起"之后，① 活着 ⇒ state 是
   * running，而引擎仍未装配 —— 这时**恰恰最需要这一页**（它的「开始下载」要 POST 到 ①）。
   * ⇒ 「引擎就绪与否」只能由 `runtime.ready` 回答，不能拿服务状态代理。
   */
  if (runtimeUnready && rt) {
    const gb = rt.requiredBytes > 0 ? (rt.requiredBytes / GIB).toFixed(1) : null;
    const start = async () => {
      setBusy(true);
      try {
        await downloadEngineModels();
        onOpenDownload();
      } catch (e) {
        onToast(errorText(e), 'bad');
      } finally {
        setBusy(false);
      }
    };
    const failing = rt.items.filter((i) => !i.ok);

    return (
      <div className="nr-guide">
        {/* 顶部：现状 + 边界 */}
        <div className="nr-guide-title">需要先安装翻译引擎{gb ? `（约 ${gb} GB）` : ''}</div>
        <div className="nr-guide-sub">
          翻译引擎不随安装包分发 —— 第一次使用要在本机装配 Python
          运行时与模型权重。下面两条路任选其一，都不需要懂命令行。
        </div>

        {/* 中部：两条路并列 */}
        <div className="nr-guide-grid">
          {/* 主路径：下载本地引擎 */}
          <div className="nr-guide-card">
            <div className="nr-guide-card-t">下载本地引擎</div>
            <div className="nr-guide-card-d">
              一键下载并自动装配。装完即可离线翻译，图片不出本机。
              {gb ? ` 本次约需下载 ${gb} GB` : ''}。
            </div>
            <div className="nr-guide-acts">
              <Btn kind="primary" disabled={busy} onClick={() => void start()}>
                {busy ? '正在发起…' : '开始下载'}
              </Btn>
            </div>
            <div className="nr-guide-note">下载分两段：先装运行环境（约 1 分钟可开始翻译），权重在后台继续。</div>
          </div>

          {/* 备路径：使用在线翻译 */}
          <div className="nr-guide-card">
            <div className="nr-guide-card-t">使用在线翻译</div>
            <div className="nr-guide-card-d">不下载引擎，填一次密钥即可。需要联网，按平台计费。</div>
            <div className="nr-guide-acts">
              <OnlineApiForm onSaved={onStart} />
            </div>
          </div>
        </div>

        {/* 底部：两者对照（默认收起） */}
        <div className="nr-guide-compare">
          <button type="button" className="nr-guide-toggle" onClick={() => setCompare(!compare)}>
            {compare ? '收起对照' : '两者有什么区别？'}
          </button>
          {compare ? (
            <div className="nr-guide-cmp">
              <div className="nr-guide-cmp-cell">
                <b className="nr-guide-cmp-t">本地引擎</b>
                <div>· 占用约 {gb ? `${gb} GB` : '数 GB'} 磁盘</div>
                <div>· 首次下载较久，之后不联网</div>
                <div>· 图片不出本机，隐私最好</div>
              </div>
              <div className="nr-guide-cmp-cell">
                <b className="nr-guide-cmp-t">在线翻译</b>
                <div>· 不占磁盘，无需下载</div>
                <div>· 始终需要联网</div>
                <div>· 按平台计费，密钥只出站</div>
              </div>
            </div>
          ) : null}
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
              {failing.map((it) => (
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

  /**
   * 阶段状态词。
   */
  const noteOf = (i: number) => {
    if (i < reached) return '已完成';
    if (i === reached && i < STARTUP_COUNT) return failed ? '失败' : '进行中';
    return STAGES[i]?.id === 'L4' ? '首图时完成' : '待开始';
  };

  const nodeClass = (note: string) => {
    switch (NODE_KIND[note]) {
      case 'is-done':
        return 'tl-node num is-done';
      case 'is-loading':
        return 'tl-node num is-loading';
      case 'is-failed':
        return 'tl-node num is-failed';
      default:
        return 'tl-node num';
    }
  };

  const stepClass = (note: string) => {
    switch (NODE_KIND[note]) {
      case 'is-done':
        return 'tl-step is-done-step';
      case 'is-loading':
        return 'tl-step is-current';
      case 'is-failed':
        return 'tl-step is-failed';
      default:
        return 'tl-step';
    }
  };

  const nodeMark = (note: string, i: number) => {
    const kind = NODE_KIND[note];
    if (kind === 'is-done') return '✓';
    if (kind === 'is-failed') return '✕';
    return i + 1;
  };

  return (
    <div className="notready">
      {/* ① 一行摘要 */}
      <div className={summary.bad ? 'nr-sum is-bad' : 'nr-sum'}>
        <span className="nr-dot" />
        <div>
          <div className="nr-sum-t">{summary.title}</div>
          <div className="nr-sum-d">{summary.sub}</div>
        </div>
      </div>

      {/* ② 时间线：节点 + 连线 + 状态词 */}
      {STAGES.map((s, i) => {
        const note = noteOf(i);
        const kind = NODE_KIND[note];
        return (
          <div key={s.id} className={stepClass(note)}>
            <div className="tl-rail">
              <span className={nodeClass(note)}>{nodeMark(note, i)}</span>
              <span className="tl-line" />
            </div>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-title">{s.text}</span>
                <span className="tl-state">{note}</span>
              </div>
              {detail && (kind === 'is-loading' || kind === 'is-failed') ? (
                <div className="tl-detail">{detail}</div>
              ) : null}
            </div>
          </div>
        );
      })}

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
        {state === 'stopped' ? (
          <Btn kind="primary" onClick={onStart}>
            启动本地服务
          </Btn>
        ) : (
          <Btn kind={failed && status?.phase === 'L2' ? 'ghost' : 'primary'} onClick={onRestart}>
            重启本地服务
          </Btn>
        )}
        <Btn kind="ghost" onClick={() => setUserLog(!logOpen)}>
          {logOpen ? '收起日志' : '查看日志'}
        </Btn>
      </div>

      {logOpen ? <div className="logbox">{(status?.log ?? []).slice(-120).join('\n') || '（暂无日志）'}</div> : null}
    </div>
  );
}

/** 「重新下载模型」：保留原有能力（时间线分支 L2 失败时）。 */
async function redownload(push: (msg: string, kind?: 'info' | 'bad' | 'good') => void) {
  try {
    await downloadEngineModels();
    push('已开始重新下载模型 —— 进度见「设置 → 翻译服务 → 引擎诊断」', 'info');
  } catch (e) {
    push(errorText(e), 'bad');
  }
}
