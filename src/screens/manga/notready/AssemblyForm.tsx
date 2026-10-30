import { AlertTriangle, CheckCircle2, Download, Settings, Terminal } from 'lucide-react';
import { Btn, LogBlock } from '@components/units';
import { formatBytes } from '@tools';
import type { ServiceStatus } from '@/ipc';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import { AssemblyTimeline } from '@screens/manga/AssemblyTimeline';
import { ASSEMBLY_PHASES, type StageNote } from '@screens/manga/assembly';
import { errorText } from '@/ipc';
import { copyText } from '@tools';
import { toastBus } from '@/stores/toastBus';
import { assemblyNoteOf, downloadLabelOf } from '@screens/manga/notready/copy';
import { baseName, isDownloading, sizeCellsOf, type SizeCell } from '@screens/manga/notready/derive';
import { NotReadyCard } from '@screens/manga/notready/NotReadyCard';
import { DownloadPill, StateChip } from '@screens/manga/notready/chips';

/**
 * 形态② **装配流程页**（D1「运行时未装配」）。
 *
 * 结构照设计稿：说明 → 现状一行 → 五段时间线 → 动作行 → 左右两栏 → 缺件逐项。
 *
 * ## 两栏各回答什么
 * · 左「需要下载」：要下多少（三格体积 + 一句话）；
 * · 右「下载位置」：下到哪、以及**下载链路在不在**（下载器 / 清单）。
 *   设计稿那两行原本是"磁盘剩余 / 模型源延迟"，服务端没有出口 ⇒ 换成这两条真实判据（见 G-01）。
 */
export function AssemblyForm({
  status,
  download,
  notes,
  activeIndex,
  detail,
  logOpen,
  busy,
  onToggleLog,
  onPrimary,
  onOpenGuide,
}: {
  status: ServiceStatus;
  download: ModelDownloadView | null;
  notes: StageNote[];
  activeIndex: number;
  detail: string | null;
  logOpen: boolean;
  busy: boolean;
  onToggleLog: () => void;
  /** 唯一的下载入口：没开过 ⇒ 打开预检页；开过 ⇒ 续传 */
  onPrimary: () => void;
  onOpenGuide: () => void;
}) {
  const rt = status.runtime;
  const totalText = rt.requiredBytes > 0 ? formatBytes(rt.requiredBytes) : null;
  const sizes = sizeCellsOf({
    visual: rt.sets?.visual?.totalBytes ?? null,
    translation:
      rt.sets?.llm?.totalBytes == null && rt.sets?.translation?.totalBytes == null
        ? null
        : (rt.sets?.llm?.totalBytes ?? 0) + (rt.sets?.translation?.totalBytes ?? 0),
    runtime: rt.sets?.runtime?.totalBytes ?? null,
  });
  const sizeLine = sizes.map((c: SizeCell) => `${c.label} ${formatBytes(c.bytes)}`).join(' · ');
  const stepLabel = activeIndex >= 0 ? (ASSEMBLY_PHASES[activeIndex]?.text ?? null) : null;
  const downloading = isDownloading(download);
  const missing = rt.items.filter((i) => !i.ok);

  return (
    <NotReadyCard
      kicker={<StateChip state="unassembled" />}
      title="需要先装配本地引擎"
      desc={
        <>
          翻译引擎不随安装包分发 —— 第一次使用要在本机装配运行环境、视觉模型与翻译模型。 下面五段逐段推进，
          不需要懂命令行。
          {totalText ? ` 首次装配共约 ${totalText}。` : ''}
        </>
      }
    >
      <div className="nr-note">{assemblyNoteOf(downloading, activeIndex, stepLabel, status.state)}</div>

      <AssemblyTimeline notes={notes} detail={detail} />

      {/*
        时间线下方：唯一的下载入口。
        🔴 点了就走，按钮文本随下载态切换（「视觉模型下载中 / 翻译模型下载中」）——
           不再展开卡片，也不再让用户在「下载 / 在线」之间先选一条路。
      */}
      <div className="nr-actions">
        <Btn kind="primary" disabled={busy || download?.state === 'running'} onClick={onPrimary}>
          <Download size={14} />
          {downloadLabelOf(busy, download)}
        </Btn>
        <Btn kind="ghost" onClick={onOpenGuide}>
          <Settings size={14} />
          查看完整诊断
        </Btn>
        <Btn kind="ghost" ariaExpanded={logOpen} onClick={onToggleLog}>
          <Terminal size={14} />
          {logOpen ? '收起日志' : '查看日志'}
        </Btn>
        <DownloadPill state={download?.state} />
      </div>

      {/*
        日志块：通用单元（深底 + 等宽 + 悬停浮现的复制按钮）。
        两处日志此前各写一套，底色/圆角/行高都不相同 —— 现在只由 variant 分两档高度。
      */}
      {logOpen ? (
        <LogBlock
          variant="compact"
          copy={copyText}
          text={(status.log ?? []).slice(-120).join('\n')}
          emptyText="（暂无日志）"
          onCopied={() => toastBus.push('日志已复制', 'good', '已复制全部可见行')}
          onCopyError={(e) => toastBus.push('复制失败', 'bad', errorText(e))}
        />
      ) : null}

      <div className="nr-aside">
        <div className="nr-panel">
          <h4>需要下载</h4>
          <p>{sizeLine ? `${sizeLine}。` : '各档体积以清单为准。'}支持断点续传，失败的文件会单独重下。</p>
          {sizes.length ? (
            <div className="nr-diag">
              {sizes.map((c) => (
                <span key={c.label}>
                  {c.label}
                  <b>{formatBytes(c.bytes)}</b>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="nr-panel">
          <h4>下载位置</h4>
          <p className="nr-path">{download?.rootDir || '（服务未启动，位置未知）'}</p>
          <div className="nr-list">
            <div className="nr-list-row">
              {download?.runnerExists ? (
                <CheckCircle2 size={13} className="is-ok" />
              ) : (
                <AlertTriangle size={13} className="is-bad" />
              )}
              <span>{download?.runnerExists ? '下载器在位' : '下载器缺失'}</span>
              <code>{baseName(download?.runner)}</code>
            </div>
            <div className="nr-list-row">
              {download?.manifest ? (
                <CheckCircle2 size={13} className="is-ok" />
              ) : (
                <AlertTriangle size={13} className="is-bad" />
              )}
              <span>{download?.manifest ? '清单在位' : '清单缺失'}</span>
              <code>{baseName(download?.manifest)}</code>
            </div>
          </div>
        </div>
      </div>

      {/* 缺件逐项（D1）：detail 带绝对路径、fix 给装法 */}
      {missing.length ? (
        <div className="nr-rt">
          {missing.map((it) => (
            <div key={it.id} className="nr-rt-item">
              <div className="nr-rt-head">
                <span className="nr-rt-id">{it.id}</span>
                <span className="nr-rt-detail">{it.detail}</span>
              </div>
              {it.fix ? <div className="nr-rt-fix">{it.fix}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </NotReadyCard>
  );
}
