import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Btn, LogBlock, Modal, ProgressRing, Tooltip } from '@components/units';
import { copyText, formatBytes } from '@tools';
import { errorText, openPath } from '@/ipc';
import { toastBus } from '@/stores/toastBus';
import { useToasts } from '@hooks';
import { ASSEMBLY_PHASES, type StageNote } from '@screens/manga/assembly';
import {
  chipOf,
  heroDescOf,
  heroTitleOf,
  metricsOf,
  pageTitleOf,
  preflightOf,
  ringCenterOf,
  ringLabelOf,
  ROUND_TEXT,
  STEP_TEXT,
  stepStateText,
  type PreflightView,
} from '@screens/engine/download/copy';
import { Preflight } from '@screens/engine/download/Preflight';
import type { ServiceStatus } from '@/ipc';
import { engineStatus } from '@screens/settings/engine-api';
import type { ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 引擎下载页（`/engine-download`）—— 结构照设计稿 `.engine-download` 一屏：
 * `.ed-head`（返回 + `LOCAL ENGINE` + 页标题 + 状态胶囊）→ `.ed-hero`（环 + eyebrow +
 * 阶段标题/说明 + 四格 metrics + 动作）→ `.ed-preflight`（下载前检查，仅等待开始时）→
 * `.ed-timeline`（五段）→ `.ed-detail`（当前文件 + 细条 + 日志）。
 *
 * ## 为什么是路由页而不是覆盖层
 * 设计稿把它做成覆盖层（`position: fixed; z-index: --z-engine`）；本页走路由 ——
 * 「返回上一个操作页面」要真的走浏览器返回栈，覆盖层只能自己记来源、刷新即丢，
 * 而且路由让这一页可深链（排障时直接把地址发给用户）。**视觉按设计稿，容器按产品的 IA**。
 *
 * ## 三条不能糊弄的口径（承旧版，一条都没丢）
 * - **不编造**：`percent === null` 显示「准备中」而非假的 0%；速度 / 剩余没有真实来源就 `—`。
 * - **环用整体装配进度**（段加权），不是字节百分比：venv / pip 装依赖 / 打补丁这几段
 *   一个字节都不进账本，用字节会把环冻在上一段的数值上（实测「一直 0%，像卡死」）。
 * - **继续下载 ≠ 重新下载**：前者调同一端点续传（补 `.part` 缺口），后者清 `.part`
 *   从头再来，所以必须二次确认。
 *
 * ## 设计稿「下载前检查」里被换掉的两格
 * 那四格里 总下载 / 保存位置 有真实来源，但 **磁盘剩余** 与 **模型源延迟** 服务端没有出口
 * （`/engine/status` 与 `/engine/runtime` 都不报这两项）。本页换成两条**真实存在**的
 * 下载链路判据（下载器在位 / 清单在位）—— 宁可换一个能答的问题，也不摆两个永远 `—` 的假检查项。
 */

interface DownloadPanelProps {
  view: ModelDownloadView;
  /** 服务状态：预检里的体积三段与「保存位置」都由它回答 */
  status: ServiceStatus | null;
  /** 五段形态（`assemblyNotes()` 的返回值）—— 与引导页同一个事实源 */
  notes: StageNote[];
  onContinue: () => void;
  onRedownload: () => void;
  /** 暂停下载（`.part` 留盘 ⇒ 「继续下载」接着下）；只在进行中可用 */
  onPause: () => void;
  onBack: () => void;
  /** 完成态「关闭下载」：写 dismissal 并移除侧栏入口 */
  onClose: () => void;
}

export function DownloadPanel({
  view,
  status,
  notes,
  onContinue,
  onRedownload,
  onPause,
  onBack,
  onClose,
}: DownloadPanelProps) {
  const { push } = useToasts();
  /*
   * 日志**默认展开**（2026-10-25 用户要求）。
   * 原先默认收起：那一屏已经有环、五段、当前文件三块，再摊开一段等宽日志会很长。
   * 但实际排障时"现在到底在干什么"只有日志答得出来，收着等于每次都要多点一下 ——
   * 用户明确要求默认展开，就按默认展开。（仍可点「收起日志」折起。）
   */
  const [logOpen, setLogOpen] = useState(true);
  const [confirmRedo, setConfirmRedo] = useState(false);
  const [checking, setChecking] = useState(false);
  /**
   * 「重新检测」探到的**最新一份**预检结论（`null` = 还没探过，用 props 推出来的那份）。
   *
   * 🔴 为什么要单独存：props 是壳层轮询给的快照，本页不能改它；但用户点了"重新检测"
   *    必须能**看见新结果**，否则这个按钮等于没做（改前正是如此：只弹一句吐司，
   *    页面上四个格子的值一动不动）。
   */
  const [probe, setProbe] = useState<PreflightView | null>(null);
  /** 两级文案（标题 + 说明）走总线；`useToasts` 的 push 只出标题，说明在这里补齐 */
  const toast = (title: string, detail: string, kind: 'info' | 'bad' | 'good') => toastBus.push(title, kind, detail);

  /*
   * 三种异常态要分开，因为**用户该做的事不同**：
   *   · `interrupted`  有 `.part` 留盘 ⇒ 可续传（「继续下载」补缺口）；
   *   · `failed` / `error`  没有 ⇒ 只能从头重下（「重新下载」走 `fresh=true`）。
   * 🔴 `error` 是 Rust 侧 `state.rs` 的真实取值（非零退出且无 `.part`），
   *    漏了它界面会把失败显示成「等待开始 + 暂停下载」。
   */
  const interrupted = view.state === 'interrupted';
  const failed = view.state === 'failed' || view.state === 'error';
  const bad = interrupted || failed;
  const done = view.state === 'done';
  const running = view.state === 'running';
  // 产品把「暂停」建模成 interrupted + 原因（`.part` 留盘可续传），所以中断态要说"已暂停"而不是"失败"
  const paused = view.state === 'interrupted';
  const idle = view.state === 'idle';
  const step = view.step ? STEP_TEXT[view.step] : null;
  const round = view.stage ? ROUND_TEXT[view.stage] : null;
  /*
   * 环用**整体装配进度**（段加权），不是字节百分比。
   *
   * 🔴 为什么要换：`percent` 只覆盖"下载字节"。venv / **pip 装依赖** / 打补丁这几段
   *    一个字节都不进账本（pip 命中 `Using cached` 时更是一个都不下），
   *    于是环会停在上一段的数值上 —— 实测就是「一直 0%，像卡死」。
   *    段加权把这些段也纳入进度，段内不可测时配旋转弧（`assemblyIndeterminate`）。
   */
  const overall = view.assemblyPercent;
  const indeterminate = view.assemblyIndeterminate;
  // 完成态的环是终态示意（不是过程数字）；中心文案仍写「完成」而非伪造的百分比。
  const ringPercent = done ? (overall ?? 100) : overall;

  const ringColor = bad ? '--md-error' : '--md-blue';

  // 页标题 / 状态胶囊 / 环心小字 —— 文案与色位都在 `copy.ts`（与页面结构分开）
  const pageTitle = pageTitleOf(done, bad, idle);
  const chip = chipOf(done, bad, running);
  const activeIdx = notes.findIndex((n) => n === 'active' || n === 'failed');
  const activePhase = activeIdx >= 0 ? ASSEMBLY_PHASES[activeIdx].text : null;
  const ringLabel = ringLabelOf(done, bad, activePhase);

  /*
   * 当前文件行：把 id 拆成「文件名 + 序号」—— 没有真实来源时不美化（如实显示 id 或留空）。
   *
   * 🔴 **非运行态一律不显示**：暂停 / 失败 / 完成时 `currentId` 要么已被 Rust 清掉
   *    （`pause_download` 现在会清 `current_id`），要么是上一轮的残留。
   *    壳层每 1.5 s 轮询一次，残留值会让这一行"看起来还在动"——
   *    真机实测用户会以为下载没停（2026-10-25）。
   */
  const currentLabel = running ? (view.currentId ?? null) : null;
  const currentText = done ? '全部文件已校验' : (currentLabel ?? '—');
  // 占位句由 `LogBlock` 的 `emptyText` 负责：这里只传**真实内容**，空就是空
  const logText = view.tail.slice(-40).join('\n');

  /*
   * 预检四格的数据（`copy.ts::preflightOf`）：总下载 / 保存位置 / 下载器 / 模型清单。
   *
   * `probe` 是「重新检测」刚探到的那一份；没有就按 props 推 —— 两者形状相同，
   * 所以页面不必区分"这是初值还是复测值"。
   */
  const preflight = probe ?? preflightOf(view, status, formatBytes);

  /**
   * 「重新检测」：**真的**再问一次后端。
   *
   * 🔴 改前是假交互：`setTimeout(600)` 之后读的仍是**进页面时那份** `view.runnerExists`，
   *    一次网络都不发 —— 用户点完得到的只是"刚检测过"的假象，页面上四个格子一动不动。
   *    现在打 `GET /engine/status`，把新拿到的 `runtime` 重新算一遍四格并**写回页面**；
   *    失败如实报错，不假装通过。
   */
  const recheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const fresh = await engineStatus();
      const next = preflightOf(view, status ? { ...status, runtime: fresh.runtime } : status, formatBytes);
      setProbe(next);
      const problems = [
        next.total.ok ? null : '清单体积读不到',
        next.runner.ok ? null : '下载器不在位',
        next.manifest.ok ? null : '模型清单缺失',
      ].filter(Boolean);
      if (problems.length === 0) {
        toast('下载链路正常', '清单、执行体与体积都读到了', 'good');
      } else {
        toast('下载链路不完整', problems.join(' · '), 'bad');
      }
    } catch (e) {
      toast('重新检测失败', errorText(e), 'bad');
    } finally {
      setChecking(false);
    }
  };

  const openDir = () => {
    if (!view.rootDir) {
      toast('下载位置未知', '服务还没有报出落点', 'bad');
      return;
    }
    void openPath(view.rootDir).catch((e: unknown) => push(errorText(e), 'bad'));
  };

  return (
    <div className="engine-download-page">
      {/*
        `.ed-wrap` 是**居中盒**（max-width 980），外层 `.engine-download-page` 才是滚动容器。
        🔴 两者不能合成一个：滚动条要贴窗口右缘，内容要居中 —— 合起来只能二选一。
      */}
      <div className="ed-wrap">
        {/* ── 页头（设计稿 `.ed-head`）：返回 + LOCAL ENGINE + 页标题 + 状态胶囊 ── */}
        <header className="ed-head">
          <Btn kind="bare" className="icon-btn" ariaLabel="返回" title="返回" onClick={onBack}>
            <ArrowLeft size={18} />
          </Btn>
          <div>
            <span className="modal-kicker">LOCAL ENGINE</span>
            <h2>{pageTitle}</h2>
          </div>
          <div className="ed-head-actions">
            <span className={`chip ${chip.cls}`}>{chip.text}</span>
          </div>
        </header>

        <div className="ed-scroll">
          {/* ── 主卡（设计稿 `.ed-hero`）：左环 + 右文案 ── */}
          <section className="ed-hero">
            <div className="ed-ring-wrap">
              <ProgressRing
                percent={ringPercent}
                size={170}
                // 设计稿 `.ed-ring` 是 170 画布装 160 viewBox（r=68 / stroke=7）：
                // 换算到 px 是 r≈72.25 / stroke≈7.44，环外径 152（四周各留 9px 白）。
                // 按单元的缺省半径会得到外径 170 —— 环比设计稿大 18px 且贴边。
                radius={72.25}
                stroke={7.44}
                colorVar={done ? '--md-success' : ringColor}
                // 段内不可测（venv / pip / 补丁）⇒ 转起来：让人看出"在跑，只是这一段没有分母"
                spinning={running && (overall == null || indeterminate)}
              />
              <div className="ed-ring-center">
                <strong>{ringCenterOf(done, overall)}</strong>
                <span>{ringLabel}</span>
              </div>
            </div>

            <div className="ed-hero-copy">
              {status?.runtime?.requiredBytes ? (
                <p className="ed-eyebrow">
                  首次使用需要下载约 {formatBytes(status.runtime.requiredBytes)} 的视觉与翻译模型
                </p>
              ) : null}
              {round ? <p className="ed-round">{round}</p> : null}
              <h3>{heroTitleOf(done, bad, idle, step, paused)}</h3>
              <p>{heroDescOf(done, bad, idle, paused, step, view)}</p>

              {/* 三格指标（设计稿 `.ed-metrics`）：没有真实来源的一律 `—`，不补"看起来合理"的数 */}
              <div className="ed-metrics">
                {metricsOf(view, running, status?.runtime?.requiredBytes ?? null, formatBytes).map((m) => (
                  <div key={m.label}>
                    <span className="ed-metric-label">
                      {m.label}
                      {/*
                        `?` 说明气泡（用户指定：解释「速度显示成 -」的两种成因）。
                        🔴 用通用 `Tooltip` 单元而不是原生 `title`：后者的延迟与样式
                           都由系统决定，且文字不可选中 —— 这里是一句要读懂的解释。
                      */}
                      {m.hint ? (
                        <Tooltip label={m.hint}>
                          <span className="ed-metric-hint" aria-label={m.hint} role="img">
                            ?
                          </span>
                        </Tooltip>
                      ) : null}
                    </span>
                    <strong>{m.value}</strong>
                  </div>
                ))}
              </div>

              <div className="ed-actions">
                {done ? (
                  <Btn kind="primary" onClick={onClose}>
                    关闭下载
                  </Btn>
                ) : paused ? (
                  <Btn kind="primary" onClick={onContinue}>
                    继续下载
                  </Btn>
                ) : failed ? (
                  <Btn kind="primary" onClick={() => setConfirmRedo(true)}>
                    重新下载
                  </Btn>
                ) : idle ? (
                  <Btn kind="primary" onClick={onContinue}>
                    开始下载
                  </Btn>
                ) : (
                  <Btn kind="primary" onClick={onPause} disabled={!view.running}>
                    暂停下载
                  </Btn>
                )}
                {paused ? (
                  <Btn kind="ghost" onClick={() => setConfirmRedo(true)}>
                    重新下载
                  </Btn>
                ) : null}
                {/* 设计稿的「后台运行」= 离开本页、下载继续在后台跑（返回箭头同一动作，这里给一句读得懂的字） */}
                <Btn kind="ghost" onClick={onBack}>
                  后台运行
                </Btn>
                {idle ? null : (
                  <Btn kind="ghost" ariaExpanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
                    {logOpen ? '收起日志' : '查看日志'}
                  </Btn>
                )}
              </div>
            </div>
          </section>

          {/* ── 下载前检查（设计稿 `.ed-preflight`）：只在等待开始时出现 ── */}
          {idle ? (
            <Preflight
              view={view}
              data={preflight}
              checking={checking}
              onRecheck={() => void recheck()}
              onOpenDir={openDir}
            />
          ) : null}

          {/* ── 五段进度（设计稿 `.ed-timeline`）：状态取自 `assemblyNotes()`，与引导页同一处算 ── */}
          <section className="ed-timeline">
            <div className="ed-timeline-head">
              <h3>装配进度</h3>
              <span>五段完成后即可开始翻译</span>
            </div>
            <ol className="ed-steps">
              {ASSEMBLY_PHASES.map((phase, i) => {
                const note = notes[i] ?? 'waiting';
                const state = note === 'failed' && paused ? 'paused' : note;
                return (
                  <li key={phase.id} className="ed-step" data-state={state}>
                    <span className="ed-step-node" />
                    <strong>{phase.text}</strong>
                    <small>{stepStateText(note, paused)}</small>
                  </li>
                );
              })}
            </ol>
          </section>

          {/* ── 当前文件 + 日志（设计稿 `.ed-detail`）── */}
          <section className="ed-detail">
            <div className="ed-detail-head">
              <h3>当前文件</h3>
              {/*
                固定两行、超出省略号：文件 id / 路径可能很长（HF 的 blobs 是 64 位十六进制），
                不限制会把这一行撑到十几行，把下面的日志顶出视口。
                不补 `title` / Tooltip —— 全名去日志块里看（那里本来就能全文复制）。
              */}
              <span className="ed-detail-current">{currentText}</span>
            </div>
            {/* `.ed-bar` 已移除：它和环是同一个数（整体装配）的两次表达 */}
            {logOpen ? (
              <LogBlock
                variant="tall"
                copy={copyText}
                text={logText}
                emptyText="（暂无输出）"
                onCopied={() => toast('日志已复制', '已复制全部可见行', 'good')}
                onCopyError={(e) => push(errorText(e), 'bad')}
              />
            ) : (
              <p className="ed-foot-note">日志原样转发下载进程的输出，不做改名映射。</p>
            )}
          </section>
        </div>
      </div>

      {/*
        「重新下载」的二次确认（设计稿这里就是**居中弹窗**，不是原地变按钮）。
        标题用设计稿原句 `从头重新下载？`；正文按**产品的真实语义**写：
        `fresh=true` 会清掉 `.part` 续传断点**与已解包的目标目录**、本次从头下
        （「继续下载」才复用断点续传），所以设计稿那句"已就绪的文件会被复用"不能照搬 ——
        那是另一条路径的行为。
        🔴 解包目标必须一并说清：真机上「重新下载后仍报同样的错」的根因就是
           只清了断点、没清已解包的 `python-3.11/`，而解包是原地覆盖。
      */}
      {confirmRedo ? (
        <Modal
          title="从头重新下载？"
          kicker="LOCAL ENGINE"
          onClose={() => setConfirmRedo(false)}
          actions={
            <>
              <Btn kind="ghost" onClick={() => setConfirmRedo(false)}>
                取消
              </Btn>
              <Btn
                kind="danger"
                onClick={() => {
                  setConfirmRedo(false);
                  onRedownload();
                }}
              >
                重新下载
              </Btn>
            </>
          }
        >
          会清掉已下载的续传断点与已解包的目录，本次从头下载全部文件。
          <br />
          已下好的归档缓存与模型权重会保留，不需要重新下载。
          <br />
          想接着上次继续，请选「继续下载」。
        </Modal>
      ) : null}
    </div>
  );
}
