import { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { runSpecCheck, type SpecResult } from '@/tools/spec-check';
import type { ThemeMode } from '@/themes/tokens';
import { LIBRARY, QUEUE_TABLE } from '@/themes/tokens';
import type { TaskRow } from '@/types';
import { STATUS_DOT_VAR, STATUS_LABEL, SOURCE_LABEL } from '@/types';
import { Btn, Dot, MagicCircle } from '@components/units';
import { QuitConfirm } from '@components/QuitConfirm';
import { emphasis } from '@screens/settings/parts';

const noop = () => {};

/** 离屏样张用的假数据：四条覆盖到 C3 要求的四种状态点色相 */
const SAMPLE_ROWS: TaskRow[] = [
  {
    taskId: 'sample-running',
    comicName: '第12话 · 学园祭',
    source: 'extension',
    status: 'running',
    queuePosition: 0,
    progress: { total: 20, done: 12, failed: 0, current: 13 },
    outputDir: '/示例/第12话 · 学园祭',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  },
  {
    taskId: 'sample-queued',
    comicName: 'C97 同人本 · 第 3 册',
    source: 'desktop',
    status: 'queued',
    queuePosition: 1,
    progress: { total: 6, done: 0, failed: 0, current: 0 },
    outputDir: '/示例/C97 同人本 · 第 3 册',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  },
  {
    taskId: 'sample-partial',
    comicName: '第08话 · 海边',
    source: 'extension',
    status: 'partial_failed',
    queuePosition: 0,
    progress: { total: 20, done: 19, failed: 1, current: 0 },
    outputDir: '/示例/第08话 · 海边',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  },
  {
    taskId: 'sample-done',
    comicName: '第07话 · 文化祭',
    source: 'desktop',
    status: 'done',
    queuePosition: 0,
    progress: { total: 2, done: 2, failed: 0, current: 0 },
    outputDir: '/示例/第07话 · 文化祭',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  },
  {
    taskId: 'sample-failed',
    comicName: '第03话 · 转学生',
    source: 'unknown',
    status: 'failed',
    queuePosition: 0,
    progress: { total: 3, done: 0, failed: 3, current: 0 },
    outputDir: '/示例/第03话 · 转学生',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  },
];

/** 样张行动作：与真表同构（状态 → 按钮），避免内联长链三元 */
function sampleActionBtn(status: TaskRow['status']) {
  if (status === 'running' || status === 'queued')
    return (
      <Btn kind="danger" size="sm">
        取消
      </Btn>
    );
  if (status === 'failed' || status === 'partial_failed')
    return (
      <Btn kind="primary" size="sm">
        重试
      </Btn>
    );
  return (
    <Btn kind="ghost" size="sm">
      查看
    </Btn>
  );
}

/**
 * 规格样张 —— 以离屏方式渲染一份队列表、空态与漫画库几何件。
 *
 * 必须真的**参与布局**（不能用 `display:none`），否则 `getBoundingClientRect` 全是 0，
 * 自检会退化成永远失败。用 `position:fixed; left:-10000px` 让它布局但不可见。
 */
export function SpecFixture() {
  return (
    <div
      style={{ position: 'fixed', left: -10000, top: 0, width: 900, pointerEvents: 'none', opacity: 0 }}
      aria-hidden="true"
    >
      <div className="queue">
        <div className="qt-head">
          <div className="qt-no">#</div>
          <div className="qt-name">
            <span className="qt-cover qt-cover-ghost" aria-hidden="true" />
            <div className="qt-name-col">任务 / 漫画名</div>
          </div>
          <div className="qt-c-source" style={{ width: QUEUE_TABLE.colSource }}>
            来源
          </div>
          <div className="qt-c-progress" style={{ width: QUEUE_TABLE.colProgress }}>
            进度
          </div>
          <div className="qt-c-status" style={{ width: QUEUE_TABLE.colStatus }}>
            状态
          </div>
          <div className="qt-c-action" style={{ width: QUEUE_TABLE.colAction }}>
            操作
          </div>
        </div>
        <div className="qt-body">
          {SAMPLE_ROWS.map((t, i) => (
            <div
              key={t.taskId}
              className={t.status === 'running' ? 'qt-row is-running' : 'qt-row'}
              style={{ height: QUEUE_TABLE.rowHeight }}
              data-status={t.status}
            >
              <div className="qt-no">
                <span className="num">{i + 1}</span>
              </div>
              <div className="qt-name">
                <span className="qt-cover" aria-hidden="true">
                  {Array.from(t.comicName)[0] ?? '?'}
                </span>
                <div className="qt-name-col">
                  <div className="qt-name-main">{t.comicName}</div>
                  <div className="qt-name-sub">{SOURCE_LABEL[t.source]}</div>
                </div>
              </div>
              <div className="qt-c-source" style={{ width: QUEUE_TABLE.colSource }}>
                {SOURCE_LABEL[t.source]}
              </div>
              <div className="qt-c-progress" style={{ width: QUEUE_TABLE.colProgress }}>
                <span className="num">{t.progress.done}</span>
                <span> / </span>
                <span className="num">{t.progress.total}</span>
                <div className="bar">
                  <i style={{ width: '50%' }} />
                </div>
              </div>
              <div className="qt-c-status" style={{ width: QUEUE_TABLE.colStatus }}>
                <Dot colorVar={STATUS_DOT_VAR[t.status]} />
                <span>{STATUS_LABEL[t.status]}</span>
              </div>
              <div className="qt-c-action" style={{ width: QUEUE_TABLE.colAction }}>
                {sampleActionBtn(t.status)}
                {/* R3：每行尾部都有 [更多]（打开目录 / 删除）—— 样张与真表同构 */}
                <Btn kind="ghost" size="sm">
                  更多
                </Btn>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="empty" style={{ height: 320 }}>
        <MagicCircle />
      </div>

      <div className="lib" style={{ height: 260 }}>
        <aside className="lib-left" style={{ width: LIBRARY.leftColumnWidth, flexBasis: LIBRARY.leftColumnWidth }}>
          <div className="lib-left-list" />
        </aside>
        <section className="lib-right">
          {/*
            样张必须与**真实页卡**同构：页卡已按设计稿改成 `.page-card`（宽度交给网格、
            缩略图按 3/4.16 自适应），样张若还留着 `.grid-card`，C5 就会一直量一个
            真实界面里不存在的元素 —— 那是空断言，比没有更坏。
          */}
          <div className="page-grid">
            <div className="page-card">
              <span className="page-thumb" />
              <span className="page-label">
                <b>第 1 页</b>
                <em>001.png</em>
              </span>
            </div>
          </div>
        </section>
      </div>

      {/*
        退出确认层（B3）。它内部是 position:fixed 的遮罩 —— 若直接放进这个 left:-10000 的
        容器里，fixed 会以**视口**为包含块，遮罩就盖住整屏了（虽然 opacity:0，但已不再是「离屏」）。
        给中间这层加 transform，遮罩的包含块就变成它，才真正停在离屏位置。
        刻意放在队列**之后**：C3c 取的是 root 里第一个 .btn-danger（队列行的「取消」），
        顺序一变它就会误取到这里的「退出喵坞」。
      */}
      <div style={{ transform: 'translateZ(0)' }}>
        <QuitConfirm onStay={noop} onQuit={noop} />
      </div>
    </div>
  );
}

/**
 * 规格自检的运行器 —— 把「样张 → 等布局就绪 → 量尺寸」这段逻辑从 `SettingsScreen`
 * 里搬出来单独一份。
 *
 * `fixtureRef` 由壳层持有：样张必须**常驻挂载**（切到别的分组也不能卸载），
 * 否则用户点「运行自检」时样张刚挂上、还没排版完，量出来全是 0 —— 一次假失败比
 * 没有这个功能更让人怀疑这套断言。所以本组件只接管运行与展示，挂载责任留给壳。
 */
export function useSpecCheck(fixtureRef: RefObject<HTMLDivElement>, mode: ThemeMode) {
  const [results, setResults] = useState<SpecResult[] | null>(null);
  const [revealed, setRevealed] = useState(false);

  const failed = useMemo(() => (results ?? []).filter((r) => !r.ok).length, [results]);

  const run = () => {
    if (!fixtureRef.current) return;
    void (async () => {
      // 等字体真正加载完再量 —— 否则 C7b「字体是否加载成功」会在首次运行时误报
      try {
        await document.fonts?.ready;
      } catch {
        /* 浏览器不支持则跳过等待 */
      }
      // 样张必须先完成布局，否则 getBoundingClientRect 全是 0。
      //
      // 但**不能只靠 `requestAnimationFrame` 等这一帧**：窗口被遮挡或屏幕锁屏时
      // rAF 根本不触发（WKWebView 会把合成/动画整块挂起），于是自检结果永远不 setState ——
      // 表现就是「点运行自检没反应」，而且只在锁屏/后台复现，白天手点一切正常。
      // 真正需要的是「布局已就绪」，而 `getBoundingClientRect` 自己就会强制同步布局，
      // 所以补一个定时器兜底：谁先到谁生效，语义等价，且后台不再静默不跑。
      let fired = false;
      const fire = () => {
        if (fired) return;
        fired = true;
        if (!fixtureRef.current) return;
        setRevealed(true);
        setResults(runSpecCheck(fixtureRef.current, mode));
      };
      requestAnimationFrame(fire);
      setTimeout(fire, 120);
    })();
  };

  return { results, revealed, failed, run };
}

/**
 * 规格自检的结果展示（按钮 + 逐条结果）。
 *
 * `fixtureRef` 只做参数传递 —— 离屏样张本身由**壳层**常驻挂载（`SettingsScreen`），
 * 不在这里渲染。理由：自检面板只在①通用组里，切到别的分组时这一支会卸载；
 * 样张若跟着卸载，用户切回来点「运行自检」时样张刚挂上还没排版完，
 * 量出来全是 0 —— 一次假失败比没有这个功能更让人怀疑这套断言。
 */
export function SpecCheckBlock({
  results,
  revealed,
  failed,
  onRun,
}: {
  results: SpecResult[] | null;
  revealed: boolean;
  failed: number;
  onRun: () => void;
}) {
  return (
    <div className="set-spec">
      <div className="set-spec-actions">
        <Btn kind="primary" onClick={onRun}>
          运行自检
        </Btn>
        {results ? (
          <span className="muted set-spec-count">
            通过 <span className="num">{results.length - failed}</span> / <span className="num">{results.length}</span>
            {failed ? (
              <>
                {' · '}
                <span className="set-spec-failed">
                  失败 <span className="num">{failed}</span>
                </span>
              </>
            ) : null}
          </span>
        ) : (
          /* 未跑过 = 「尚未运行」（设计稿 `.inline-result` 的空态文案），不是"通过 0 / 0" */
          <span className="muted set-spec-count">尚未运行</span>
        )}
        {revealed ? null : <span className="muted set-spec-hint">（首次运行会先让样张完成布局）</span>}
      </div>

      {results ? (
        <div className="spec-list">
          {results.map((r) => (
            <div key={r.id} className={r.ok ? 'spec-row is-ok' : 'spec-row is-bad'}>
              <i>{r.ok ? '✓' : '✗'}</i>
              <span>
                {/* `label` 与 `detail` 都是**给用户看的文案**（`spec-check.ts` 里写的），
                    同样含 `**重点**` 标记 —— 不走 emphasis 就会原样显示两个星号。
                    与 catalog 的 note/why 是同一类缺陷，所以共用同一个解析器。 */}
                <b>{r.id}</b> {emphasis(r.label)}
                <br />
                <span className="muted" style={{ fontSize: 10.5 }}>
                  {emphasis(r.detail)}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 离屏样张的挂载点。由壳层渲染一次并常驻（切分组不卸载），ref 交给 `useSpecCheck` */
export function SpecFixtureHost({ fixtureRef }: { fixtureRef: RefObject<HTMLDivElement> }) {
  return (
    <div ref={fixtureRef}>
      <SpecFixture />
    </div>
  );
}
