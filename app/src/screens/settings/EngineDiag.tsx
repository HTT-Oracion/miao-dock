import { useState } from 'react';
import type { ReactNode } from 'react';
import { Btn, Dot } from '@components/units';
import { errorText, serviceRestart } from '@/ipc';
import type { ServiceStatus } from '@/ipc';
import { configPairs } from '@screens/settings/engine-state';
import type { EngineState } from '@screens/settings/engine-state';
import type { ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 「服务四态机」的文案与色点（《02》§2.1）。
 *
 * 本文件自带一份、**不复用** `nav.ts` 的 `stateView()`，原因只有一个：那个函数
 * 的签名是 `(s: ServiceState) => {text,colorVar}` —— 传进去一个它不认识的字符串时
 * 会返回 `undefined`，调用方（这里）读 `view.colorVar` 就会把整块面板渲染崩。
 * ②/③ 的 state 是**引擎自己**报出来的字符串，将来多出第五种是迟早的事，
 * 而"诊断视图在最需要它的时候白屏"是不可接受的。所以这里用 `Record<string, …|undefined>`
 * 显式表达"可能不认识"，不认识就原样报出来。
 */
const STATE_VIEW: Record<string, { text: string; colorVar: string } | undefined> = {
  stopped: { text: '未启动', colorVar: '--md-muted' },
  starting: { text: '启动中', colorVar: '--md-blue' },
  running: { text: '运行中', colorVar: '--md-success' },
  error: { text: '异常', colorVar: '--md-error' },
};

/**
 * ② 翻译服务 ·「模型与诊断」的**引擎诊断视图**（《02》§5 / 《09》§6.2）。
 *
 * ## 它不是调试后门
 * 《02》§5 的定位写得很清楚：这是「用户能自己回答『为什么这次翻译这么慢』」的正当入口。
 * 所以它**默认对普通用户可见、不折叠**（已拍板，《02》§10-2），五个区块一个不少：
 * 进程状态 / 生效配置 / 模型状态 / 最近阶段日志 / 操作。
 *
 * ## 🔴 内部小标题**不能**复用 `SubTitle`
 * ② 那一组的「三小节」是被规格自检 C11 精确盯着的：它数 `settings-main` 里的
 * `.set-subtitle`，要求**恰好 3 个**且文字是「服务与配对 / 推理引擎 / 模型与诊断」。
 * 这里再有 5 个 `.set-subtitle`，C11 会立刻变红 —— 而那不是误报，是真的分不清
 * "这一组有几层结构"了。所以面板内一律用 `.set-diag-h`（同字号语汇，另一个层级）。
 *
 * ## 每一个"读不到"都如实说
 * `/engine/status` 和 `/engine/options` 失败时（服务刚重启、引擎没起来）本组件
 * **不显示上一次的旧值**，而是明说读不到 + 原因。诊断视图最坏的形态就是
 * "显示一份看起来正常的快照"，那会让人对着过期的数字排查。
 */
export function EngineDiag({
  eng,
  service,
  onToast,
}: {
  eng: EngineState;
  /** ① box-service 自己的状态 —— 它不在 `/engine/status` 里（那是引擎的视角），得从 Rust 侧拿 */
  service: ServiceStatus | null;
  onToast: (t: string, k?: 'info' | 'good' | 'bad') => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const s = eng.status;
  const o = eng.options;
  const busy = eng.action !== null;

  /**
   * 「重启引擎」走的其实是 **`service_restart`（整条本地链路 ①②③）**。
   *
   * 为什么不能只重启 ②：引擎② 由 **Box 壳（Rust）的 ServiceManager** 拉开，
   * box-service 是它的**兄弟进程**，拿不到它的 pid、也管不到它的生死
   * （`/engine/status.engine.pid` 恒为 null 就是这个事实的现场记录）。
   * 所以产品上这个动作的诚实表述是「重启引擎（整条链路）」——
   * 一个只重启 ③ 的按钮、和一个只改状态的按钮，都比"多做了一点"更糟：
   * 前者做到的事和标签不符，后者点了什么都不发生。
   */
  const restart = async () => {
    setRestarting(true);
    onToast('正在重启本地服务链路（①②③）…', 'info');
    try {
      await serviceRestart();
      await eng.reload();
      onToast('引擎已重启（①②③ 均已重新拉起）', 'good');
    } catch (e) {
      onToast(errorText(e), 'bad');
      await eng.reload();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="set-diag">
      <div className="set-diag-top">
        <div>
          <div className="set-diag-name">引擎诊断视图</div>
          <div className="set-diag-why">
            进程、参数、模型与阶段日志的现场。翻译慢或失败时，先看这里 ——
            它能回答「是没起来、在准备、还是在跑但没预热」。
          </div>
        </div>
        <div className="set-diag-acts">
          <Btn size="sm" disabled={busy || restarting} onClick={() => void eng.reload()}>
            刷新
          </Btn>
        </div>
      </div>

      {eng.loadError ? (
        <div className="notice is-bad set-diag-note">
          读不到引擎状态：{eng.loadError}
          <br />
          界面<b>不显示上一次的旧值</b> —— 诊断视图最坏的形态就是「一份看起来正常的快照」。
        </div>
      ) : null}

      <DiagSection title="进程状态">
        <ProcRow
          label="① box-service"
          state={service?.state ?? null}
          port={service?.port ?? null}
          // ① 的 pid 面向前端的接口里没有（有也不该给：它在同一个进程组里，pid 无排障价值）
          pidNote="—"
        />
        <ProcRow
          label="② 翻译引擎"
          state={s?.engine?.state ?? null}
          port={s?.engine?.port ?? null}
          // `/engine/status.engine.pid` 恒为 null：② 由 Box 壳 spawn，box-service 是兄弟进程
          pidNote="由 Box 壳持有"
          extra={s?.engine?.version ? `版本 ${s.engine.version}` : null}
        />
        <ProcRow
          label="③ Sakura LLM"
          state={s?.llm?.state ?? null}
          port={s?.llm?.port ?? null}
          pid={s?.llm?.pid ?? null}
          extra={s?.llm?.model ?? null}
        />
        <div className="set-diag-note">
          「已预热」= {s ? (s.warmed ? '是' : '否') : '—'} —— ③ 被空闲卸载后进程态仍是 running，
          但这一项会转 false，所以它不是「引擎没起来」，而是「首张稍慢」。
        </div>
      </DiagSection>

      <DiagSection title="生效配置">
        <div className="set-diag-kv">
          {configPairs(s?.config).map((p) => (
            <span key={p.k} className="set-diag-kv-item">
              <span className="set-diag-k">{p.k}</span>
              <span className="set-diag-v">{p.v}</span>
            </span>
          ))}
        </div>
        <div className="set-diag-note">
          这是<b>每次请求下发</b>给引擎的那一份（服务端没有 <code>--config-file</code> 这个开关，实测确认）。
          它与设置页里的档位/后端是两件事：那些是进程参数，这些是每单的翻译参数。
        </div>
      </DiagSection>

      <DiagSection title="模型状态">
        <div className="set-diag-kv">
          <span className="set-diag-kv-item">
            <span className="set-diag-k">视觉模型</span>
            <span className="set-diag-v">{readyText(s?.models?.visualReady)}</span>
          </span>
          <span className="set-diag-kv-item">
            <span className="set-diag-k">Sakura 权重</span>
            <span className="set-diag-v">{readyText(s?.models?.sakuraReady)}</span>
          </span>
          <span className="set-diag-kv-item">
            <span className="set-diag-k">上次校验</span>
            <span className="set-diag-v">{s?.models?.lastVerifiedAt ?? '未校验过'}</span>
          </span>
        </div>
        <div className="set-diag-note">
          路径 <code className="set-ro">{o?.modelDir?.current ?? '—'}</code>
        </div>
        <DownloadState view={s?.modelDownload} />
      </DiagSection>

      <DiagSection title="最近阶段日志">
        {s && s.recentStageLog.length > 0 ? (
          <div className="set-diag-log">
            {[...s.recentStageLog].reverse().map((line, i) => (
              // 引擎原始阶段名（`seq N: 原话`）—— **不做改名映射**：
              // 映射了就会在引擎改阶段名之后继续说旧名字
              <div key={`${i}-${line}`} className="set-diag-log-line">{line}</div>
            ))}
          </div>
        ) : (
          <div className="set-diag-note">
            {s
              ? '当前没有阶段记录。ver1.0 自定义协议的替身引擎是单包响应、没有阶段帧，此时为空是如实的空；真引擎在翻译时才会逐条写入。'
              : '读不到（见上方）'}
          </div>
        )}
      </DiagSection>

      <div className="set-diag-ops">
        <Btn size="sm" disabled={busy || restarting} onClick={() => void restart()}>
          {restarting ? '重启中…' : '重启引擎'}
        </Btn>
        <Btn
          size="sm"
          // 脚本不在盘上时按钮必须**是灰的**（服务端 `scriptExists` 就是给这一格用的）
          disabled={busy || s?.modelDownload?.scriptExists === false || s?.modelDownload?.running === true}
          title={
            s?.modelDownload?.scriptExists === false
              ? '模型下载脚本不在盘上'
              : s?.modelDownload?.running
                ? '已有下载任务在跑'
                : undefined
          }
          onClick={() => void eng.download()}
        >
          重新下载模型
        </Btn>
        <Btn size="sm" disabled={busy || restarting} onClick={() => void eng.unload()}>
          强制释放模型
        </Btn>
      </div>
      <div className="set-diag-note">
        「重启引擎」重启的是<b>整条本地链路（①②③）</b>：② 由 Box 壳拉开，box-service 管不到它，
        所以做不到「只重启 ②」。「强制释放模型」只停 ③ —— ② 与 ① 一根毫毛都不动，
        这是它不需要二次确认的原因（③ 不在跑时它也只是如实告诉你「无需释放」）。
      </div>
    </div>
  );
}

/**
 * 面板内的分层标题。
 *
 * ⚠️ 刻意**不用** `SubTitle`：那个类名（`.set-subtitle`）被 C11 用来数"② 这一组有几个小节"，
 * 而这里的小标题是**项内部**的分层，不是设置项层级。用同一个类名会让 C11 从
 * 「恰好 3 个」变成「3 + 5 个」，于是那条断言彻底失效（它会红，但红的原因不再是它要守的东西）。
 */
function DiagSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="set-diag-sec">
      <div className="set-diag-h">{title}</div>
      {children}
    </div>
  );
}

/** 一行进程状态。`pid` 与 `pidNote` 二选一 —— 有真 pid 就报，没有就说清为什么没有 */
function ProcRow({
  label,
  state,
  port,
  pid,
  pidNote,
  extra,
}: {
  label: string;
  state: string | null;
  port: number | null;
  pid?: number | null;
  pidNote?: string;
  extra?: string | null;
}) {
  /*
   * ⚠️ 这里**不**把 `state` 直接喂给 `stateView`：那是「服务四态机」的映射表
   * （stopped/starting/running/error），而 ②/③ 的 state 是**引擎自己**报的字符串，
   * 将来多出第五种（如 `crashed`）时，`STATE_VIEW[k]` 会是 `undefined` ——
   * 于是 `view.colorVar` 直接让整块面板崩掉。诊断视图崩在最需要它的时候是最糟的。
   * 所以：认识的态照常给色点与文字，不认识的就**原样报出来**（诊断视图宁可粗糙也不可隐瞒）。
   */
  const view = state ? STATE_VIEW[state] : null;
  return (
    <div className="set-diag-proc">
      <span className="set-diag-proc-name">{label}</span>
      <span className="set-diag-proc-state">
        {state ? (
          <>
            <Dot colorVar={view?.colorVar ?? '--md-muted'} />
            {view?.text ?? state}
          </>
        ) : (
          '—'
        )}
      </span>
      <span className="set-diag-proc-num">:{port ?? '—'}</span>
      <span className="set-diag-proc-num">{pid != null ? `pid ${pid}` : (pidNote ?? '—')}</span>
      {extra ? <span className="set-diag-proc-extra">{extra}</span> : null}
    </div>
  );
}

function readyText(v: boolean | undefined): string {
  if (v === undefined) return '—';
  return v ? '就绪' : '未就绪';
}

/**
 * 「重新下载模型」的任务实况。
 *
 * 🔴 它与上面的"模型状态"**不是一回事**，这一点必须在界面上分开：
 *    下载跑着的时候 `sakuraReady` 仍是 false（文件还没落完），把两者并在一个标签里，
 *    用户会以为"点了没反应"。所以这里报的是**任务**（state + 输出尾巴），
 *    上面报的是**盘上事实**（文件在不在、大小对不对）。
 */
function DownloadState({ view }: { view: ModelDownloadView | undefined }) {
  if (!view) return null;
  if (view.state === 'idle') {
    return (
      <div className="set-diag-note">
        没有下载任务在跑。最近一次：从未（本进程启动以来）。
      </div>
    );
  }
  const label: Record<ModelDownloadView['state'], string> = {
    idle: '空闲',
    running: '进行中',
    done: '已完成',
    error: '失败',
  };
  const tail = view.tail.slice(-6);
  return (
    <div className={view.state === 'error' ? 'set-diag-dl is-bad' : 'set-diag-dl'}>
      <div className="set-diag-dl-head">
        下载任务：{label[view.state]}
        {view.state === 'running' ? ` · 起于 ${view.startedAt ?? '—'}` : null}
        {view.state !== 'running' && view.exitCode !== null ? ` · 退出码 ${view.exitCode}` : null}
        {view.timedOut ? ' · 已超时终止' : null}
      </div>
      {tail.length > 0 ? (
        <div className="set-diag-log">
          {tail.map((line, i) => (
            <div key={`${i}-${line}`} className="set-diag-log-line">{line}</div>
          ))}
        </div>
      ) : null}
      <div className="set-diag-note">
        目标目录 <code className="set-ro">{view.rootDir}</code>。
        已就绪的文件按清单的 (sha256, 大小, 时间) 复用 —— 重下<b>不会</b>把几个 GB 再下一遍，
        只补齐缺失与不符的那几个。
      </div>
    </div>
  );
}
