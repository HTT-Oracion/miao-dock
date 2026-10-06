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
 * 摘要行：一行主句 + 一句副行。
 *
 * 原来「提示条」与「当前阶段句」是两个块、说的是同一件事 —— 合并成一行，
 * 因为用户此刻只关心三件事：卡在哪一步、是不是坏了、我该点什么。
 *
 * ⚠️ 降级（degraded）与失败共用一份红，但**不共用措辞**：前者服务还能应答、翻译会失败，
 * 后者根本提交不了。同一条屏上出现两个红条时用户分不清哪个更严重，所以只留这一处。
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
      sub: '点下方「重启本地服务」把它拉起来。首次启动需要装载模型，会慢一些。',
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
 * 整屏四段：**一行摘要 → 时间线 → 一行 meta → 一行动作**（日志默认收起）。
 * 时间线的价值是「还剩几步」—— 那是四行独立列表给不出、而一条线能一眼给到的信息。
 *
 * 这一屏的责任不是「道歉」，而是**把卡在哪儿说清楚** —— 所以真实日志末行会挂在当前段下，
 * 失败时日志自动展开。
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
  /**
   * 日志**默认收起**（本屏"信息精简"唯一的行为性改动），但**失败时自动展开**
   * —— 「把卡在哪儿说清楚」这个立意不能丢。
   *
   * `null` = 用户还没手动点过，跟随默认；点过之后以用户的为准（否则"收起"会点不动）。
   */
  const [userLog, setUserLog] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;
  const failed = state === 'error';
  const degraded = !!status?.degraded;
  const logOpen = userLog ?? failed;

  /**
   * 已完成的阶段数。
   *
   * 🔴 早先这里写的是 `status?.sidecar_port ? 2 : 1` —— 拿"引擎端口存不存在"猜阶段。
   *    它有两处必然出错：① 端口先于阶段就绪（② 端口在听 ≠ L2 探针已过）时会把 L1 显示成 L2；
   *    ② 引擎已起但 ③ 还没答 HTTP 时，L3 永远点不亮，用户看到的是"卡在第二段"。
   *    现在按 Rust 状态机的 `phase` 逐值映射，**没有 phase 就不假装有进度**。
   *
   * 上界是 `STARTUP_COUNT` 而**不是** `STAGES.length`：L4 不属启动期（见其上方注释）。
   */
  const idx = status?.phase ? (PHASE_INDEX[status.phase] ?? 0) : 0;
  const reached = state === 'running' ? STARTUP_COUNT : idx;

  const detail = lastLogLine(status?.log);
  const summary = summaryOf(state, err, status?.phase, degraded);

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

  /**
   * 阶段状态词。
   *
   * 🔴 **L4 单列一支**（它不是启动期的一步，见 STAGES 上方注释）。
   *    因为 `reached` 的上界是 `STARTUP_COUNT`，第 4 段两个 if 都进不去 ⇒ 它拿不到
   *    「进行中」「失败」「已完成」。给它 loading 态或「待开始」都会让用户一直等它走完。
   */
  const noteOf = (i: number) => {
    if (i < reached) return '已完成';
    if (i === reached && i < STARTUP_COUNT) return failed ? '失败' : '进行中';
    return STAGES[i]?.id === 'L4' ? '首图时完成' : '待开始';
  };

  /** 节点形态。`num` 是全局数字字体工具类（Inter + tabular-nums） */
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

  /** 整步形态：让连线段与状态词跟着节点一起着色，一眼看出进度占比 */
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

  /** 节点里的符号：完成打勾、失败打叉，其余显示**下标派生**的序号（不是写死的 1/2/3/4） */
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

      {/* ② 时间线：节点 + 连线 + 状态词 —— 步数与序号都由 STAGES 单源派生 */}
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
                /*
                 * 明细：**真实日志末行原样** —— 不重排、不截断成"看起来像进度"的样子。
                 * 只有"当前段且不是待开始"才挂：待开始的段挂一行日志会让人以为它已经在跑了。
                 */
                <div className="tl-detail">{detail}</div>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* ③ 一行 meta：正常时它是"都活着"，不值得占三行；异常时才转红 */}
      <div className="nr-meta">
        {/* `mode` 必须显式可见：否则"以为在跑真引擎、其实跑的替身"最难查 */}
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
        <Btn kind="ghost" onClick={() => setUserLog(!logOpen)}>
          {logOpen ? '收起日志' : '查看日志'}
        </Btn>
      </div>

      {logOpen ? (
        <div className="logbox">
          {(status?.log ?? []).slice(-120).join('\n') || '（暂无日志）'}
        </div>
      ) : null}
    </div>
  );
}
