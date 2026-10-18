import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { useToasts } from '@hooks';
import { Btn, Dot, Notice } from '@components/units';
import { errorText, serviceRestart, writeTextFile } from '@/ipc';
import type { ServiceStatus } from '@/ipc';
import { configPairs } from '@screens/settings/engine-state';
import type { EngineState } from '@screens/settings/engine-state';
import type { ModelDisk, ModelDownloadView, ModelFileStatus, ModelGuidance } from '@screens/settings/engine-api';
import { emphasis, humanBytes } from '@screens/settings/parts';
import type { SettingItem } from '@screens/settings/catalog';

/**
 * **服务五态机**的诊断侧映射（与 `nav.ts` 同一集：`ipc.ts` 的 `ServiceState` 就是
 * `stopped | starting | running | stopping | error`）。
 *
 * 本文件自带一份、**不复用** `nav.ts` 的 `stateView()`，原因只有一个：那个函数
 * 的签名是 `(s: ServiceState) => {text,colorVar}` —— 传进去一个它不认识的字符串时
 * 会返回 `undefined`，调用方（这里）读 `view.colorVar` 就会把整块面板渲染崩。
 * ②/③ 的 state 是**引擎自己**报出来的字符串，多出第六种是迟早的事，
 * 而"诊断视图在最需要它的时候白屏"是不可接受的。所以这里用 `Record<string, …|undefined>`
 * 显式表达"可能不认识"，不认识就原样报出来。
 *
 * ⚠️ 五个键**一个都不能少**：漏一个不会编译报错，只会把**英文裸 id** 漏到界面上
 * （取值取不到时会回落到原始字符串，那就是用户看到的 `stopping`）。S2 给服务端加
 * `stopping` 时这里就漏过一次 —— `check:settings` 的 `NOTREADY.state.fiveStates`
 * 现在按本表的五个键逐一断言，就是要让这种漏同步当场变红。
 */
const STATE_VIEW: Record<string, { text: string; colorVar: string } | undefined> = {
  stopped: { text: '未启动', colorVar: '--md-muted' },
  starting: { text: '启动中', colorVar: '--md-blue' },
  running: { text: '运行中', colorVar: '--md-success' },
  stopping: { text: '正在停止', colorVar: '--md-muted' },
  error: { text: '异常', colorVar: '--md-error' },
};

/** 常驻日志区默认显几行 */
const LOG_DEFAULT = 3;
/** 就地展开的上限（不再跳抽屉）—— 3 行是一次典型失败的最小上下文，8 行是"多看几眼" */
const LOG_EXPANDED = 8;
/** 「全部日志」抽屉的上限 —— 与引擎侧留存的 `recentStageLog` 同口径（最多 120 行） */
const LOG_DRAWER_MAX = 120;

/**
 * ② 翻译服务 ·「模型与诊断」的**运行状态卡 + 诊断详情**（《03》§3）。
 *
 * ## 这一版修的是上一版自己造的问题
 * ver2.0 的 R6 把整个引擎诊断面板折叠了（不折叠时常态 170px、带下载日志 500px+，
 * 把 ② 的四小节标题顶出首屏）。那次取舍本身有道理，但它把**最高频的一条信息一起埋了**：
 * 「最近发生了什么」—— 而 ver2.0 自己的文档就写着 `recentStageLog` 是**排障第一入口**。
 * 把第一入口藏在一次点击之后，是把定位写反了。
 *
 * 所以本版的处置不是"再折叠一次"，而是**把日志从折叠范围里拿出来**：
 *   · 「运行状态」卡 = 标题 + 三枚进程 chip + **常驻日志区**（默认 3 行，就地可扩到 8）
 *     + 「全部日志」抽屉（全量 ≤120 行、倒序、可复制、可导出）；
 *   · 「诊断详情」仍然折叠 —— 折叠的对象**收窄**为 进程表 / 生效配置 / 模型路径 / 三个操作。
 *
 * 一句话对照：ver2.0 是「要看日志 ⇒ 先点展开」；本版是「日志就摆在那儿，想多看再点」。
 * **能力一个都不少**：项数不减、按钮不减、日志总量不减，只改层次。
 *
 * ## 标题与 why 都从 catalog 的那一项来（不在这里硬写）
 * 原先 `.set-diag-name` 与 why 是本文件里的两个字符串，而 catalog 的 `engine-diag` 项
 * 自己也带一份 label/why —— **同一件事两处写，且那一份从来不渲染**（本组件当时不收 item）。
 * 于是"改口径"要改两处、漏一处没人发现。现在与兄弟块 `ModelManageBlock` 同一惯用法：
 * `item.label` + `emphasis(item.why)`，catalog 是唯一事实源。
 *
 * ## 🔴 ③ 那枚 chip 不能无条件报「运行中」
 * ③ Sakura 被空闲卸载后，**进程态仍是 running**，只有 `warmed` 转 false。
 * chip 若照着 state 直译成「运行中」，用户看到的是"一切正常"，而真相是
 * 「首张要等一次冷启动」—— 这是整块卡唯一能骗人的地方，也最容易骗过肉眼。
 * 所以 `running && !warmed` 一律报**「未预热」**。
 *
 * ## 🔴 不加时间戳（《03》§3.3）
 * 引擎的阶段日志行形态是 `seq N: 原话`，本身**不含时刻字段**。给它补一个时间戳
 * 就是编数据 —— 与本项目「没有就不显示，不补占位数字」的纪律直接冲突。
 * 替代品是卡片右下角那句**客户端**记录的「最后更新：12 秒前」：那是我们真的知道的事实。
 *
 * ## 🔴 内部小标题**不能**复用 `SubTitle`
 * ② 那一组的「四小节」是被规格自检 C11 精确盯着的：它数 `settings-main` 里的
 * `.set-subtitle`，要求**恰好 4 个**且文字是「翻译来源 / 服务与配对 / 推理引擎 / 模型与诊断」。
 * 折叠区里再有 3 个 `.set-subtitle`，C11 会立刻变红 —— 而那不是误报，是真的分不清
 * "这一组有几层结构"了。所以面板内一律用 `.set-diag-h`（同字号语汇，另一个层级）。
 *
 * ## 每一个"读不到"都如实说
 * `/engine/status` 和 `/engine/options` 失败时（服务刚重启、引擎没起来）本组件
 * **不显示上一次的旧值**，而是明说读不到 + 原因。诊断视图最坏的形态就是
 * "显示一份看起来正常的快照"，那会让人对着过期的数字排查。
 */
export function EngineDiag({
  item,
  eng,
  service,
}: {
  /** catalog 的 `engine-diag` 项 —— 标题与 why 都从它来（单一事实源，见下方文件头） */
  item: SettingItem;
  eng: EngineState;
  /** ① manga-service 自己的状态 —— 它不在 `/engine/status` 里（那是引擎的视角），得从 Rust 侧拿 */
  service: ServiceStatus | null;
}) {
  // 吐司单例总线：直接取用，不必由宿主透传（见 useToasts 注释）
  const { push: onToast } = useToasts();
  const [restarting, setRestarting] = useState(false);
  /**
   * 「诊断详情」折叠态。默认收起；`false` 初值即"默认折叠"这件事本身。
   * 注意折叠的**不是**整块能力：日志与三枚 chip 都在折叠之外（见文件头）。
   */
  const [open, setOpen] = useState(false);
  /** 日志区就地展开（3 → 8 行）。与抽屉是两个不同的需求：前者高频、后者低频 */
  const [logMore, setLogMore] = useState(false);
  /** 「全部日志」抽屉 */
  const [drawer, setDrawer] = useState(false);
  const s = eng.status;
  const o = eng.options;
  const busy = eng.action !== null;

  /*
   * 「最后更新」是**客户端**记录的事实：日志内容一变化就记一次时刻。
   * 引擎不报时刻，所以这个数字只能由"我们什么时候看到它变了"来给 —— 见文件头。
   */
  const logs = s?.recentStageLog ?? [];
  const logSig = logs.length > 0 ? `${logs.length}·${logs[logs.length - 1]}` : '';
  const stampRef = useRef<{ sig: string; at: number }>({ sig: '\u0000', at: 0 });
  if (stampRef.current.sig !== logSig) stampRef.current = { sig: logSig, at: Date.now() };

  /* 每 5 秒刷新一次"XX 秒前"，否则这个数字会停在第一次渲染的那一刻 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  /* 抽屉的 Esc 关闭（点遮罩 / 关闭按钮在下方各自的元素上） */
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  /**
   * 「重启引擎」走的其实是 **`service_restart`（整条本地链路 ①②③）**。
   *
   * 为什么不能只重启 ②：引擎② 由 **Box 壳（Rust）的 ServiceManager** 拉开，
   * manga-service 是它的**兄弟进程**，拿不到它的 pid、也管不到它的生死
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

  /*
   * 三枚 chip —— **每一枚分别取自它自己那个进程的 state**，不共用一份映射：
   *   ① 从 Rust 侧的 `ServiceStatus`（服务五态机）
   *   ② / ③ 从 `/engine/status`（引擎自己报的字符串，可能多出第六种）
   * ③ 再叠一条 `warmed` 的修正（见上方文件头）。
   */
  const chipText = (state: string | null | undefined): { text: string; colorVar: string } => {
    const view = state ? STATE_VIEW[state] : null;
    return { text: view?.text ?? state ?? '—', colorVar: view?.colorVar ?? '--md-muted' };
  };
  const llmBase = chipText(s?.llm?.state);
  const llmChip = s?.llm?.state === 'running' && !s.warmed ? { text: '未预热', colorVar: '--md-warning' } : llmBase;

  /* 最新在上（引擎按发生顺序写入，界面要第一眼看到刚发生的那条） */
  const allLogs = [...logs].reverse();
  const shownLogs = allLogs.slice(0, logMore ? LOG_EXPANDED : LOG_DEFAULT);
  const drawerLogs = allLogs.slice(0, LOG_DRAWER_MAX);
  const logText = allLogs.join('\n');

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(logText);
      onToast('已复制全部日志', 'good');
    } catch (e) {
      onToast(errorText(e), 'bad');
    }
  };
  const exportTxt = async () => {
    try {
      // 取消不是错误：用户按下取消 ⇒ save() 给 null ⇒ 静默返回
      const path = await save({
        defaultPath: '引擎阶段日志.txt',
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (!path) return;
      await writeTextFile(path, logText);
      onToast('已导出日志', 'good');
    } catch (e) {
      onToast(errorText(e), 'bad');
    }
  };

  return (
    <>
      {/* ── 运行状态卡（常驻，不在任何折叠里）── */}
      <div className="set-run">
        <div className="set-run-head">
          <span className="set-run-title">{item.label}</span>
          <span className="set-state is-chip">
            <Dot colorVar={chipText(service?.state).colorVar} />
            <span className="set-state-text">① {chipText(service?.state).text}</span>
          </span>
          <span className="set-state is-chip">
            <Dot colorVar={chipText(s?.engine?.state).colorVar} />
            <span className="set-state-text">② {chipText(s?.engine?.state).text}</span>
          </span>
          <span className="set-state is-chip">
            <Dot colorVar={llmChip.colorVar} />
            <span className="set-state-text">③ {llmChip.text}</span>
          </span>
          <span className="set-run-grow" />
          <button type="button" className="set-run-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起 ꜛ' : '诊断详情 ▾'}
          </button>
          <button type="button" className="set-run-all" onClick={() => setDrawer(true)}>
            全部日志
          </button>
        </div>

        {item.why ? <div className="set-run-why">{emphasis(item.why)}</div> : null}

        {/*
          常驻日志区 —— **折叠之外**，这是本版的全部改动所在。
          行内容原样转发引擎输出（`seq N: 原话`），**不做改名映射**：
          映射了就会在引擎改阶段名之后继续说旧名字。
        */}
        <div className="set-run-log">
          {allLogs.length > 0 ? (
            shownLogs.map((line, i) => (
              <div key={`${i}-${line}`} className={isFailedLine(line) ? 'set-run-line is-bad' : 'set-run-line'}>
                {line}
              </div>
            ))
          ) : (
            <div className="set-run-empty">
              {s
                ? '当前没有阶段记录：替身（mock）引擎是单包响应、没有阶段帧，此时为空是如实的空；真引擎翻译时会逐条写入。可对照上方「引擎模式」确认现在跑的是哪一个。'
                : '读不到（见上方）'}
            </div>
          )}
        </div>

        <div className="set-run-foot">
          {/*
            没有阶段记录时必须是「—」，而不是"刚刚" —— 那个时刻是"我们第一次读到空日志"的时刻，
            不是"日志更新于此刻"。本项目不补占位数字，这里同理。
          */}
          <span className="set-run-updated">
            最后更新：{relativeText(logs.length > 0 ? stampRef.current.at : 0, now)}
          </span>
          {allLogs.length > LOG_DEFAULT ? (
            <button type="button" className="set-run-more" aria-expanded={logMore} onClick={() => setLogMore(!logMore)}>
              {logMore ? `收起到 ${LOG_DEFAULT} 行 ꜛ` : `展开到 ${LOG_EXPANDED} 行 ▾`}
            </button>
          ) : null}
        </div>
      </div>

      {/*
        「诊断详情」的折叠条。被折叠的集合**比 ver2.0 更小**：日志已经不在其中。
        条上那句话就是"里面有什么"的清单 —— 不点开也能知道值不值得点。
      */}
      <div className="set-run-detail">
        <span className="set-run-detail-t">诊断详情 —— 进程表 / 生效配置 / 模型路径 / 重启 · 重下 · 释放</span>
        <button type="button" className="set-run-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起 ꜛ' : '展开 ▾'}
        </button>
      </div>

      {eng.loadError ? (
        <Notice kind="bad" className="set-diag-note">
          读不到引擎状态：{eng.loadError}
          <br />
          界面<b>不显示上一次的旧值</b> —— 诊断视图最坏的形态就是「一份看起来正常的快照」。
        </Notice>
      ) : null}

      {/* 折叠区：3 个区块 + 3 个操作**一个不少**（折叠只是默认收起，不是删内容） */}
      {open ? (
        <>
          <DiagSection title="进程状态">
            <ProcRow
              label="① manga-service"
              state={service?.state ?? null}
              port={service?.port ?? null}
              // ① 的 pid 面向前端的接口里没有（有也不该给：它在同一个进程组里，pid 无排障价值）
              pidNote="—"
            />
            <ProcRow
              label="② 翻译引擎"
              state={s?.engine?.state ?? null}
              port={s?.engine?.port ?? null}
              // `/engine/status.engine.pid` 恒为 null：② 由 Box 壳 spawn，manga-service 是兄弟进程
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
              「已预热」= {s ? (s.warmed ? '是' : '否') : '—'} —— ③ 被空闲卸载后进程态仍是 running， 但这一项会转
              false，所以它不是「引擎没起来」，而是「首张稍慢」。
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
            {/* C1：体积与落点，动手之前先说清楚 */}
            <ModelGuide guidance={s?.models?.guidance} dir={o?.modelDir?.current} />
            {/* D4：盘上实况（装没装 / 占多少盘 / 什么时候落的） */}
            <ModelDiskRow disk={s?.models?.disk} />
            {/* D8：逐条引导清单（**渲染**清单，不是在这里编写） */}
            <ModelFiles files={s?.models?.files} />
            <DownloadState view={s?.modelDownload} />
          </DiagSection>

          <div className="set-diag-ops">
            <Btn size="sm" disabled={busy || restarting} onClick={() => void restart()}>
              {restarting ? '重启中…' : '重启引擎'}
            </Btn>
            <Btn
              size="sm"
              // 执行体不在盘上时按钮必须**是灰的**（服务端 `runnerExists` 就是给这一格用的）
              disabled={busy || s?.modelDownload?.runnerExists === false || s?.modelDownload?.running === true}
              title={
                s?.modelDownload?.runnerExists === false
                  ? '模型下载执行体不在盘上'
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
            「重启引擎」重启的是<b>整条本地链路（①②③）</b>：② 由 Box 壳拉开，manga-service 管不到它， 所以做不到「只重启
            ②」。「强制释放模型」只停 ③ —— ② 与 ① 一根毫毛都不动， 这是它不需要二次确认的原因（③
            不在跑时它也只是如实告诉你「无需释放」）。
          </div>
        </>
      ) : null}

      {/* ── 「全部日志」抽屉 ── */}
      {drawer ? (
        <div className="set-run-scrim" onClick={() => setDrawer(false)}>
          <div
            className="set-run-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="全部日志"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="set-run-drawer-head">
              <span className="set-run-drawer-title">全部日志</span>
              <span className="set-run-drawer-sub">最多 {LOG_DRAWER_MAX} 行 · 最新在上</span>
              <span className="set-run-grow" />
              <Btn size="sm" onClick={() => void copyAll()}>
                复制全部
              </Btn>
              <Btn size="sm" onClick={() => void exportTxt()}>
                导出 .txt
              </Btn>
              <button type="button" className="set-run-drawer-x" aria-label="关闭" onClick={() => setDrawer(false)}>
                ✕
              </button>
            </div>
            <div className="set-run-drawer-body">
              {drawerLogs.length > 0 ? (
                drawerLogs.map((line, i) => (
                  <div key={`${i}-${line}`} className={isFailedLine(line) ? 'set-run-line is-bad' : 'set-run-line'}>
                    {line}
                  </div>
                ))
              ) : (
                <div className="set-run-empty">当前没有阶段记录。</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * 一行日志是不是失败行（《03》§3.4：失败行就地着色，不新增形状、不加图标）。
 *
 * 判据取**引擎原话**里的失败词 —— 引擎的阶段名与措辞就是我们的唯一事实源，
 * 另立一套映射会在引擎改阶段名之后继续说旧名字（这也正是"不做改名映射"的原因）。
 */
function isFailedLine(line: string): boolean {
  if (/退出码\s*[1-9]/.test(line)) return true;
  if (line.includes('失败')) return true;
  return /\b(?:error|failed|failure|exception|traceback)\b/i.test(line);
}

/** 相对时刻（《03》§3.3）：只报我们真的知道的事实，不编时间戳 */
function relativeText(at: number, now: number): string {
  if (!at) return '—';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时前`;
}

/**
 * 面板内的分层标题。
 *
 * ⚠️ 刻意**不用** `SubTitle`：那个类名（`.set-subtitle`）被 C11 用来数"② 这一组有几个小节"，
 * 而这里的小标题是**项内部**的分层，不是设置项层级。用同一个类名会让 C11 从
 * 「恰好 4 个」变成「4 + 3 个」，于是那条断言彻底失效（它会红，但红的原因不再是它要守的东西）。
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

/*
 * 字节 → 人读的换算**移到 `parts.tsx` 的 `humanBytes()`**（D4）：这一页与「模型管理」
 * 两块都要显示同一个量（模型资产占盘），各自留一份换算函数就会出现"同一个数在两处
 * 显示成不同单位"。纯函数、与具体能力无关，故归排版件 —— 与 `plain()` 同一个理由。
 */

/**
 * **安装引导：体积与落点**（C1）—— 把"要留多少盘、装到哪"在**动手之前**说清楚。
 *
 * ## 为什么必须动手前说
 * 那十几个 GB 是用户**自己下、自己占盘**的（引擎与模型都不随包分发）。下手前不说清，
 * 最常见的失败不是"装失败"，而是"下到一半发现盘不够"—— 那时已经下了几个 GB，
 * 而且没有任何一步会报错。
 *
 * ## 为什么分档位报
 * 合计只回答"要留多少盘"，回答不了"我只要视觉那部分是多少"—— 而后者才是用户在
 * 「只下必需」与「全量」之间做选择时要问的（`--set visual` ≈ 0.7 GB 对全量 ≈ 6.9 GiB）。
 *
 * 🔴 数字**全部来自服务端**（`guidance.totalBytes` / `guidance.sets[].bytes`，由清单
 *    `sizeBytes` 求和得出），这里只做单位换算。前端再遍历一遍 `files` 自己求和，
 *    就等于把"总量"实现两遍 —— 两份迟早不一样，而界面上只表现为"数字对不上"。
 */
function ModelGuide({ guidance, dir }: { guidance?: ModelGuidance; dir?: string }) {
  if (!guidance) return null;
  const loc = <code className="set-ro">{dir ?? '—'}</code>;
  // 清单读不到：不说"0 B"（那会被读成"不用占盘"），也不编一个数字，照实说算不出来。
  if (guidance.entries === 0) {
    return <div className="set-diag-note">落点 {loc} —— 清单读不到，体积无从算起。</div>;
  }
  return (
    <>
      <div className="set-diag-note">
        当前平台 <code>{guidance.platform}</code> · 落点 {loc}
      </div>
      <div className="set-diag-guide">
        <div className="set-diag-guide-total">
          模型资产合计 <b>{humanBytes(guidance.totalBytes)}</b>
          <span className="set-diag-guide-sub">
            {guidance.totalBytes.toLocaleString('en-US')} 字节 · {guidance.entries} 个条目（已按本平台过滤）
          </span>
        </div>
        <div className="set-diag-guide-sets">
          {guidance.sets.map((s) => (
            <span key={s.id} className="set-diag-guide-set">
              <span className="set-diag-guide-set-id">{s.id}</span>
              <span className="set-diag-guide-set-bytes">{humanBytes(s.bytes)}</span>
              <span className="set-diag-guide-set-n">{s.entries} 项</span>
            </span>
          ))}
        </div>
      </div>
      <div className="set-diag-note">
        这些都是<b>从网上下的</b>资产（不随安装包分发）：上手前按上面这个数留盘。 另需 Python 运行时与 venv 依赖（
        <code>torch</code> 那几 GB）—— 那部分体积由你的 环境决定，这里<b>不替你估</b>。分平台的命令与逐项自检见{' '}
        <code>docs/install-guide-*.md</code>。
      </div>
    </>
  );
}

/**
 * **模型引导清单**（D8）—— 把清单逐条渲染出来，不是在这里编写一份。
 *
 * ## 为什么三个聚合布尔不够
 * 它们回答"现在能不能翻译"，却回答不了"**还缺哪一个文件**"—— 而后者才是用户在点
 * 「重新下载模型」之前真正要确认的。那份信息清单里本来就有（`dest` / `linkTo` /
 * `sizeBytes` / `url`），早先却被压成三个布尔，答案在界面上根本不存在。
 *
 * ## 只列**适用本机**的条目
 * Windows 用户不该看到两条 macOS 的 `llama.cpp` —— 那会让人以为自己也缺。
 * 跨平台条目用一句话交代数量，既说清"清单里有"，也不误导。
 *
 * 🔴 路径取服务端给的 `path`（**判据真正作用的绝对路径**），不是我们自己拿
 *    `modelDir + dest` 拼的 —— 拼一个就等于在界面里再造一套落点规则，
 *    而 `linkTo` 的条目根本不落在 `dest` 上。
 */
/**
 * **盘上实况**（D4）—— 一次答完三个问题：装没装、占多少盘、什么时候落的。
 *
 * 🔴 每处措辞都在防一种误读，改动前先看清：
 *   · 占的是「**模型资产**」而不是"整个安装" —— Python / venv 那几 GB 由用户环境决定，
 *     我们算不出来；报一个包含它的数就是编数字（同 `ModelGuide` 的口径）；
 *   · 去重口径写在界面上 —— 硬链接（`mangasvc --fetch-models --link` 建的那种）是同一份
 *     inode，不说明的话用户会以为"6.9 GB 怎么显示成 13.8 GB 了"；
 *   · 时间是「**最近落盘**」而不是"装配于" —— 我们没有"装配完成"这个事件的记录，
 *     把文件 mtime 说成"装配时刻"就是在编数据；没有就绪条目时**不显示时间**。
 */
function ModelDiskRow({ disk }: { disk?: ModelDisk }) {
  if (!disk) {
    return <div className="set-diag-note">模型资产占盘：服务端还没给出（诊断视图没取到状态）。</div>;
  }
  return (
    <div className="set-diag-guide">
      <div className="set-diag-guide-total">
        模型资产占盘 <b>{humanBytes(disk.bytes)}</b>
        <span className="set-diag-guide-sub">
          {disk.bytes.toLocaleString('en-US')} 字节 · 去重后 {disk.uniqueFiles} 个文件（硬链接不重复计）
        </span>
      </div>
      <div className="set-diag-note">
        已就绪 <b>{disk.readyEntries}</b> 条
        {disk.assembledAt ? (
          <>
            {' '}
            · 最近一次落盘 <b>{disk.assembledAt}</b>（就绪文件里最新的修改时间，
            <b>不是</b>"装配完成时刻"）
          </>
        ) : (
          <> · 还没有任何就绪条目（没落过盘）</>
        )}
      </div>
    </div>
  );
}

function ModelFiles({ files }: { files?: ModelFileStatus[] }) {
  const all = files ?? [];
  if (all.length === 0) {
    return <div className="set-diag-note">清单读不到 —— 无法逐条对账。</div>;
  }
  const mine = all.filter((f) => f.applicable);
  const missing = mine.filter((f) => !f.ready);
  const others = all.length - mine.length;
  return (
    <>
      <div className={missing.length ? 'set-diag-note is-bad' : 'set-diag-note'}>
        清单共 {all.length} 条，适用本机 {mine.length} 条{others > 0 ? `（另有 ${others} 条属其他平台，不列）` : ''}：
        {missing.length ? (
          <>
            其中 <b>{missing.length} 条未就绪</b>
          </>
        ) : (
          '全部就绪'
        )}
      </div>
      <div className="set-diag-files">
        {mine.map((f) => (
          <div key={f.id} className={f.ready ? 'set-diag-file' : 'set-diag-file is-bad'}>
            <span className="set-diag-file-id">{f.id}</span>
            <span className="set-diag-file-path" title={f.path}>
              {f.path}
            </span>
            <span className="set-diag-file-size">
              {f.sizeBytes ? humanBytes(f.sizeBytes) : '大小未声明'}
              {f.platform ? ` · ${f.platform}` : ''}
            </span>
          </div>
        ))}
      </div>
    </>
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
    return <div className="set-diag-note">没有下载任务在跑。最近一次：从未（本进程启动以来）。</div>;
  }
  const label: Record<ModelDownloadView['state'], string> = {
    idle: '空闲',
    running: '进行中',
    done: '已完成',
    interrupted: '中断（可续传）',
    failed: '失败',
  };
  const tail = view.tail.slice(-6);
  // 🔴 兼容新态：`interrupted` / `failed` 都按警示态上色；未知态原样显示，不崩。
  const bad = view.state === 'interrupted' || view.state === 'failed';
  return (
    <div className={bad ? 'set-diag-dl is-bad' : 'set-diag-dl'}>
      <div className="set-diag-dl-head">
        下载任务：{label[view.state]}
        {view.state === 'running' ? ` · 起于 ${view.startedAt ?? '—'}` : null}
        {view.state !== 'running' && view.exitCode !== null ? ` · 退出码 ${view.exitCode}` : null}
        {view.timedOut ? ' · 已超时终止' : null}
        {view.interruptedReason ? ` · ${view.interruptedReason}` : null}
      </div>
      {view.state === 'running' || view.state === 'interrupted' || view.state === 'failed' ? (
        <div className="set-diag-note" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {view.percent != null ? `进度 ${Math.round(view.percent)}%` : '准备中（尚无真实进度）'}
          {view.receivedBytes != null
            ? ` · 已下 ${humanBytes(view.receivedBytes)}${
                view.totalBytes != null ? ` / ${humanBytes(view.totalBytes)}` : ''
              }`
            : ''}
          {view.speedBps != null ? ` · ↓ ${humanBytes(view.speedBps)}/s` : ''}
          {view.stage ? ` · 阶段 ${view.stage}` : ''}
          {view.currentId ? ` · 当前 ${view.currentId}` : ''}
        </div>
      ) : null}
      {tail.length > 0 ? (
        <div className="set-diag-log">
          {tail.map((line, i) => (
            <div key={`${i}-${line}`} className="set-diag-log-line">
              {line}
            </div>
          ))}
        </div>
      ) : null}
      <div className="set-diag-note">
        目标目录 <code className="set-ro">{view.rootDir}</code>。 已就绪的文件按清单的 (sha256, 大小, 时间) 复用 —— 重下
        <b>不会</b>把几个 GB 再下一遍， 只补齐缺失与不符的那几个。
      </div>
    </div>
  );
}
