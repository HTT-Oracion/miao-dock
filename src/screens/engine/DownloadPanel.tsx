import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, RefreshCw } from 'lucide-react';
import { Btn, LogBlock, Modal, ProgressRing } from '@components/units';
import { copyText, formatBytes } from '@tools';
import { errorText, openPath } from '@/ipc';
import { toastBus } from '@/stores/toastBus';
import { useToasts } from '@hooks';
import { ASSEMBLY_PHASES, assemblySizes, type StageNote } from '@screens/manga/assembly';
import type { ServiceStatus } from '@/ipc';
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

function fmtEta(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `约 ${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `约 ${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `约 ${h} 小时 ${m % 60} 分`;
}

/**
 * 五段标题（与装配流程页同一套段号）。
 *
 * `models` 是全量 CLI 的兼容值，文案与 `llm` 一致；`stage` 只负责上面的
 * 「第 N 轮 / 共 2 轮」小字 —— 两者不是同一台状态机。
 */
const STEP_TEXT: Record<string, { title: string; sub: string }> = {
  prepare: {
    title: '正在准备装配环境',
    sub: '校验清单、探测落点 —— 这段没有可量化的进度，走完即进入下载。',
  },
  runtime: {
    title: '正在装配运行环境',
    sub: 'Python 运行时 → venv → 引擎源码 → 补丁 → 依赖。',
  },
  visual: {
    title: '正在下载视觉模型',
    sub: '检测 / OCR / 抹字 / 字体，以及 llama.cpp 与 CUDA 运行库。',
  },
  llm: {
    title: '正在下载翻译模型',
    sub: 'Sakura 权重与 nllb（英译中）；期间可先用在线翻译，下完可在设置里切回本地引擎。',
  },
  models: {
    title: '正在下载翻译模型',
    sub: 'Sakura 权重与 nllb（英译中）；期间可先用在线翻译，下完可在设置里切回本地引擎。',
  },
};

const ROUND_TEXT: Record<string, string> = {
  stage1: '第 1 轮 / 共 2 轮',
  stage2: '第 2 轮 / 共 2 轮',
};

/** 五段状态条的小字（设计稿 `.ed-step small`）；`已暂停` 只在"中断且可续传"时说 */
function stepStateText(note: StageNote, paused: boolean): string {
  if (note === 'done') return '完成';
  if (note === 'failed') return paused ? '已暂停' : '失败';
  if (note === 'active') return '进行中';
  return '等待';
}

/** 预检的一格：图标 + 标题 + 主值 + 副行（设计稿 `.ed-check`）。 */
function CheckCell({
  label,
  value,
  hint,
  ok,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  ok: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={ok ? 'ed-check is-ok' : 'ed-check is-bad'}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>
        {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
        {hint}
      </small>
      {children}
    </div>
  );
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
  const [logOpen, setLogOpen] = useState(false);
  const [confirmRedo, setConfirmRedo] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 两级文案（标题 + 说明）走总线；`useToasts` 的 push 只出标题，说明在这里补齐 */
  const toast = (title: string, detail: string, kind: 'info' | 'bad' | 'good') => toastBus.push(title, kind, detail);

  const interrupted = view.state === 'interrupted' || view.state === 'failed';
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

  const ringColor = interrupted ? '--md-error' : '--md-blue';

  // 页标题 / 状态胶囊 / 环心小字（设计稿 `edTitle` / `edStateChip` / `edRingLabel`）
  const pageTitle = done
    ? '本地引擎已就绪'
    : interrupted
      ? '本地引擎装配中断'
      : idle
        ? '本地引擎装配'
        : '正在装配本地引擎';
  const chip = done
    ? { text: '已完成', cls: 'chip-success' }
    : interrupted
      ? { text: '下载中断', cls: 'chip-danger' }
      : running
        ? { text: '下载中', cls: 'chip-soft' }
        : { text: '等待开始', cls: 'chip-soft' };
  const activeIdx = notes.findIndex((n) => n === 'active' || n === 'failed');
  const ringLabel = done
    ? '完成'
    : interrupted
      ? '已中断'
      : activeIdx >= 0
        ? ASSEMBLY_PHASES[activeIdx].text
        : '等待开始';

  // 当前文件行：把 id 拆成「文件名 + 序号」—— 没有真实来源时不美化（如实显示 id 或留空）。
  const currentLabel = view.currentId ?? null;
  // 占位句由 `LogBlock` 的 `emptyText` 负责：这里只传**真实内容**，空就是空
  const logText = view.tail.slice(-40).join('\n');

  const sizes = assemblySizes(status);
  /*
   * 下载链路的两项判据（执行体 / 清单）。
   *
   * 🔴 预检态（`state='idle'`，还没有任何下载记录）里 `view.runner` / `view.manifest` 是空的 ——
   *    那两个字段由**下载进程**报出，没跑过就还没报。但这两样东西此刻**确实存在或不存在**，
   *    问 `engineStatus` 的 `runtime` 那一份即可（它与下载器读的是同一个清单）。
   *    所以判据取「有 view 就用 view，没有就退到服务状态」，而不是让预检格永远显示 `—`。
   */
  const runnerPath = view.runner || status?.runtime?.items.find((i) => i.id === 'llm')?.path || '';
  const runnerOk = view.runner ? view.runnerExists : !!status?.runtime;
  const manifestPath = view.manifest || '';
  const manifestOk = view.manifest ? true : !!status?.runtime;

  /** 「重新检测」：本页能自己复查的只有下载链路的两个前提（执行体 / 清单），不伪造磁盘与网络结论。 */
  const recheck = () => {
    if (checking) return;
    setChecking(true);
    window.setTimeout(() => {
      setChecking(false);
      if (view.runnerExists && view.manifest) {
        toast('下载链路正常', '下载器与模型清单都在位', 'good');
      } else {
        toast('下载链路不完整', view.runnerExists ? '模型清单读不到' : '下载器不在位', 'bad');
      }
    }, 600);
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
              <strong>{done ? '完成' : overall == null ? '准备中' : `${Math.round(overall)}%`}</strong>
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
            <h3>
              {done
                ? '全部文件校验通过'
                : interrupted
                  ? '下载中断 · 已完成的部分会保留'
                  : idle
                    ? '准备好后开始装配'
                    : (step?.title ?? '准备好后开始装配')}
            </h3>
            <p>
              {done
                ? '引擎已可以启动，重启本地服务后生效。'
                : interrupted
                  ? (view.interruptedReason ??
                    (view.tail.length ? view.tail[view.tail.length - 1] : '原因未知；已完成的部分不会丢失。'))
                  : idle
                    ? '下载约 3.6 GB，支持断点续传。确认保存位置与模型源后再开始。'
                    : paused
                      ? '已下载的部分会保留，随时可以从断点继续。'
                      : (step?.sub ?? '进度只来自真实下载事件。')}
            </p>

            {/* 四格指标（设计稿 `.ed-metrics`）：没有真实来源的一律 `—`，不补"看起来合理"的数 */}
            <div className="ed-metrics">
              <div>
                <span>已下载</span>
                <strong>{view.receivedBytes != null ? formatBytes(view.receivedBytes) : '—'}</strong>
              </div>
              <div>
                <span>总大小</span>
                <strong>
                  {view.totalBytes != null
                    ? formatBytes(view.totalBytes)
                    : sizes.total != null
                      ? formatBytes(sizes.total)
                      : '—'}
                </strong>
              </div>
              <div>
                <span>速度</span>
                <strong>{running && view.speedBps != null ? `${formatBytes(view.speedBps)}/s` : '—'}</strong>
              </div>
              <div>
                <span>剩余</span>
                <strong>{running ? fmtEta(view.etaMs) : '—'}</strong>
              </div>
            </div>

            <div className="ed-actions">
              {done ? (
                <Btn kind="primary" onClick={onClose}>
                  关闭下载
                </Btn>
              ) : interrupted ? (
                <Btn kind="primary" onClick={onContinue}>
                  继续下载
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
              {interrupted ? (
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
          <section className="ed-preflight">
            <div className="ed-preflight-head">
              <div>
                <span className="modal-kicker">PRE-FLIGHT</span>
                <h3>下载前检查</h3>
                <p>确认保存位置与网络状态后开始；下载中可关闭此页，进度会保留。</p>
              </div>
              <Btn kind="ghost" size="sm" disabled={checking} onClick={recheck}>
                <RefreshCw size={13} />
                {checking ? '检测中' : '重新检测'}
              </Btn>
            </div>
            <div className="ed-preflight-grid">
              <CheckCell
                label="总下载"
                value={sizes.total != null ? formatBytes(sizes.total) : '—'}
                hint={
                  sizes.total != null
                    ? [
                        sizes.visual != null ? `视觉 ${formatBytes(sizes.visual)}` : null,
                        sizes.translation != null ? `翻译 ${formatBytes(sizes.translation)}` : null,
                        sizes.runtime != null ? `运行环境 ${formatBytes(sizes.runtime)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : '清单未读到'
                }
                ok={sizes.total != null}
              />
              <div className="ed-check ed-check-dir">
                <span>保存位置</span>
                <strong className="ed-path" title={view.rootDir}>
                  {view.rootDir || '—'}
                </strong>
                <div className="ed-check-actions">
                  <Btn kind="text" onClick={openDir} disabled={!view.rootDir}>
                    打开目录
                  </Btn>
                </div>
              </div>
              <CheckCell
                label="下载器"
                value={runnerPath ? runnerPath.split(/[\\/]/).pop()! : '—'}
                hint={runnerOk ? '执行体在位' : '执行体缺失'}
                ok={runnerOk}
              />
              <CheckCell
                label="模型清单"
                value={manifestPath ? manifestPath.split(/[\\/]/).pop()! : 'models.manifest.json'}
                hint={manifestOk ? '清单可读' : '清单缺失'}
                ok={manifestOk}
              />
            </div>
            <div className="ed-preflight-note">
              <Info size={11} />
              下载支持断点续传；完成后可在本页启动本地服务。
            </div>
          </section>
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

        {/* ── 当前文件 + 细条 + 日志（设计稿 `.ed-detail`）── */}
        <section className="ed-detail">
          <div className="ed-detail-head">
            <h3>当前文件</h3>
            <span>{done ? '全部文件已校验' : (currentLabel ?? '—')}</span>
          </div>
          {/* 细条与环同一口径（整体装配）；没有真实阶段事件时不画，不给一条假动画 */}
          {overall != null ? (
            <div className="ed-bar">
              <span style={{ width: `${Math.min(100, overall)}%` }} />
            </div>
          ) : null}
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

      {/*
        「重新下载」的二次确认（设计稿这里就是**居中弹窗**，不是原地变按钮）。
        标题用设计稿原句 `从头重新下载？`；正文按**产品的真实语义**写：
        `fresh=true` 会清掉 `.part` 续传断点、本次从头下（「继续下载」才复用断点续传），
        所以设计稿那句"已就绪的文件会被复用"不能照搬 —— 那是另一条路径的行为。
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
          会清掉已下载的续传断点，本次从头下载全部文件。
          <br />
          想接着上次继续，请选「继续下载」。
        </Modal>
      ) : null}
    </div>
  );
}
