import { useMemo, useRef, useState } from 'react';
import type { ServiceStatus } from '../ipc';
import { runSpecCheck, type SpecResult } from '../spec-check';
import type { ThemeMode } from '../theme/tokens';
import { LIBRARY, QUEUE_TABLE } from '../theme/tokens';
import type { TaskRow } from '../types';
import { STATUS_DOT_VAR, STATUS_LABEL, SOURCE_LABEL } from '../types';
import { Btn, Dot, MagicCircle } from '../components/atoms';
import { QuitConfirm } from '../components/QuitConfirm';

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
    finishedAt: new Date().toISOString(),
  },
];

/**
 * 规格样张 —— 以离屏方式渲染一份队列表、空态与漫画库几何件。
 *
 * 必须真的**参与布局**（不能用 `display:none`），否则 `getBoundingClientRect` 全是 0，
 * 自检会退化成永远失败。用 `position:fixed; left:-10000px` 让它布局但不可见。
 */
function SpecFixture() {
  return (
    <div
      style={{ position: 'fixed', left: -10000, top: 0, width: 900, pointerEvents: 'none', opacity: 0 }}
      aria-hidden="true"
    >
      <div className="queue">
        <div className="qt-head">
          <div className="qt-name">任务 / 漫画名</div>
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
          {SAMPLE_ROWS.map((t) => (
            <div
              key={t.taskId}
              className={t.status === 'running' ? 'qt-row is-running' : 'qt-row'}
              style={{ height: QUEUE_TABLE.rowHeight }}
            >
              <div className="qt-name">
                <div className="qt-name-main">{t.comicName}</div>
                <div className="qt-name-sub">{SOURCE_LABEL[t.source]}</div>
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
                {t.status === 'running' || t.status === 'queued' ? (
                  <span className="btn btn-danger btn-sm">取消</span>
                ) : t.status === 'failed' || t.status === 'partial_failed' ? (
                  <span className="btn btn-primary btn-sm">重试</span>
                ) : (
                  <span className="btn btn-ghost btn-sm">查看</span>
                )}
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
          <div className="lib-grid">
            <div
              className="grid-card"
              style={{ width: LIBRARY.card.w, height: LIBRARY.card.h, borderRadius: LIBRARY.card.radius }}
            />
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
 * 设置页 —— 令牌配对（F-09）+ 外观 + 生命周期说明 + 规格自检。
 *
 * 规格自检放在这里而不是单独的调试页，是因为它要回答的正是用户/评审最关心的那句话：
 * 「界面跟方案文档对得上吗？」—— 那就让它和设置放在一起，随时能点。
 */
export function SettingsScreen({
  status,
  mode,
  onMode,
  onToast,
}: {
  status: ServiceStatus | null;
  mode: ThemeMode;
  onMode: (m: ThemeMode) => void;
  onToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
}) {
  const fixture = useRef<HTMLDivElement>(null);
  const [results, setResults] = useState<SpecResult[] | null>(null);
  const [revealed, setRevealed] = useState(false);

  const failed = useMemo(() => (results ?? []).filter((r) => !r.ok).length, [results]);

  const copyToken = async () => {
    if (!status?.token) return;
    try {
      await navigator.clipboard.writeText(status.token);
      onToast('令牌已复制，粘到插件设置里即可配对', 'good');
    } catch {
      onToast('复制失败，请手动选中复制', 'bad');
    }
  };

  const run = () => {
    if (!fixture.current) return;
    void (async () => {
      // 等字体真正加载完再量 —— 否则 C7b「字体是否加载成功」会在首次运行时误报
      try {
        await document.fonts?.ready;
      } catch {
        /* 浏览器不支持则跳过等待 */
      }
      // 样张必须先完成布局，否则 getBoundingClientRect 全是 0
      requestAnimationFrame(() => {
        if (!fixture.current) return;
        setRevealed(true);
        setResults(runSpecCheck(fixture.current, mode));
      });
    })();
  };

  return (
    <div className="settings">
      {/* 离屏样张：始终挂载，保证「点自检」时布局已就绪 */}
      <div ref={fixture}>
        <SpecFixture />
      </div>

      <section className="card section">
        <div className="section-title">本地服务</div>
        <div className="kv">
          <b>状态</b>
          <span>{status ? STATUS_TEXT[status.state] : '读取中…'}</span>
        </div>
        <div className="kv">
          <b>服务端口</b>
          <code>{status?.port ?? '—'}</code>
        </div>
        <div className="kv">
          <b>引擎端口</b>
          <code>{status?.sidecar_port ?? '—'}</code>
        </div>
        <div className="kv">
          <b>落盘根目录</b>
          <code>{status?.root_dir ?? '—'}</code>
        </div>
        {status?.last_error ? (
          <div className="notice is-bad">最近一次错误：{status.last_error}</div>
        ) : null}
      </section>

      <section className="card section">
        <div className="section-title">令牌配对（浏览器插件）</div>
        <div className="notice">
          插件靠这个令牌提交翻译任务。令牌由本机生成、权限 0600，只存在这台机器上，
          不会上传到任何远端；换令牌等于让旧令牌立即失效。
        </div>
        <div className="kv">
          <b>X-Box-Token</b>
          <code>{status?.token ?? '—'}</code>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="primary" disabled={!status?.token} onClick={() => void copyToken()}>
            复制令牌
          </Btn>
        </div>
      </section>

      <section className="card section">
        <div className="section-title">外观</div>
        <button
          type="button"
          className={mode === 'dark' ? 'switch is-on' : 'switch'}
          onClick={() => onMode(mode === 'dark' ? 'light' : 'dark')}
        >
          <span className="switch-track">
            <i />
          </span>
          <span>深色模式（只换令牌变量，不换结构）</span>
        </button>
      </section>

      <section className="card section">
        <div className="section-title">生命周期</div>
        <div className="notice">
          关闭窗口只是把窗口收起来 —— 本地服务继续跑，浏览器插件照样能提交翻译任务，
          托盘图标常驻。要真正退出请用托盘菜单里的「退出喵坞…」，届时会有二次确认。
        </div>
      </section>

      <section className="card section">
        <div className="section-title">规格自检（C1–C7）</div>
        <div className="notice">
          对离屏样张量实际渲染尺寸与颜色，跟 design token 常量逐一比对。
          CSS 里改错了数值，这里会立刻报红 —— 让「界面与方案文档对得上」变成一条可复核的断言，
          而不是一句主观评价。
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Btn kind="primary" onClick={run}>
            运行自检
          </Btn>
          {results ? (
            <span style={{ fontSize: 11.5 }} className={failed ? 'muted' : 'muted'}>
              通过 <span className="num">{results.length - failed}</span> /{' '}
              <span className="num">{results.length}</span>
              {failed ? (
                <>
                  {' · '}
                  <span style={{ color: 'var(--md-error)' }}>
                    失败 <span className="num">{failed}</span>
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
          {revealed ? null : (
            <span className="muted" style={{ fontSize: 11 }}>
              （首次运行会先让样张完成布局）
            </span>
          )}
        </div>

        {results ? (
          <div className="spec-list">
            {results.map((r) => (
              <div key={r.id} className={r.ok ? 'spec-row is-ok' : 'spec-row is-bad'}>
                <i>{r.ok ? '✓' : '✗'}</i>
                <span>
                  <b>{r.id}</b> {r.label}
                  <br />
                  <span className="muted" style={{ fontSize: 10.5 }}>
                    {r.detail}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

const STATUS_TEXT: Record<ServiceStatus['state'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  error: '异常',
};
