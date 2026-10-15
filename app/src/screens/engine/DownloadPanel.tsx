import { useState } from 'react';
import { Btn, ProgressRing } from '@components/units';
import { formatBytes } from '@tools';
import type { ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 屏 2 / 屏 3 · 引擎下载主视图（进度 / 中断）。
 *
 * ## 职责
 * - 把「等待」这件事说清楚：阶段、大进度、已下/总量、速度、预计剩余、当前文件、真实日志。
 * - **不阻塞**：本视图只是信息主场，下载在后台继续，用户随时可「关闭此页面」回其它屏。
 * - **不编造**：`percent === null` 显示「准备中」而非假的 0%；速度/剩余同样是 null 就如实留空。
 *
 * 中断态（`interrupted` / `failed`）严格区分两种动作：
 *   · 「继续下载」= 调同一端点续传（补齐 `.part` 缺口）；
 *   · 「重新下载」= 清 `.part` 从头再来（二次确认，避免误触丢进度）。
 */

interface DownloadPanelProps {
  view: ModelDownloadView;
  /** 运行时缺件体积（bytes），用于说明首次装配要下多大 */
  requiredBytes?: number;
  onContinue: () => void;
  onRedownload: () => void;
  onBack: () => void;
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

const STAGE_TEXT: Record<string, { step: string; title: string; sub: string }> = {
  stage1: {
    step: '第 1 步 / 共 2 步',
    title: '正在准备运行环境',
    sub: '下载并解包 Python 运行时、引擎源码与视觉模型 —— 这一步完成后本地引擎即可启动，翻译权重在后台继续。',
  },
  stage2: {
    step: '第 2 步 / 共 2 步',
    title: '正在下载翻译权重',
    sub: '翻译权重体积较大，正在后台下载；期间可先用在线翻译，下完自动切回本地引擎。',
  },
};

export function DownloadPanel({ view, requiredBytes, onContinue, onRedownload, onBack }: DownloadPanelProps) {
  const [logOpen, setLogOpen] = useState(false);
  const [confirmRedo, setConfirmRedo] = useState(false);

  const interrupted = view.state === 'interrupted' || view.state === 'failed';
  const percent = view.percent;
  const stage = view.stage ? STAGE_TEXT[view.stage] : null;

  // 当前文件行：把 id 拆成「文件名 + 序号」—— 没有真实来源时不美化（如实显示 id 或留空）。
  const currentLabel = view.currentId ?? null;

  const ringColor = interrupted ? '--md-error' : '--md-blue';

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 24px 40px' }}>
      {/* 顶部：阶段指示 */}
      {!interrupted && stage ? (
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--md-blue)', letterSpacing: '.04em' }}>
            {stage.step}
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--md-ink)', marginTop: 4 }}>
            {stage.title}
          </div>
          <div style={{ fontSize: 13, color: 'var(--md-muted)', marginTop: 6, lineHeight: 1.5 }}>
            {stage.sub}
          </div>
        </div>
      ) : null}

      {/* 中断原因行（屏 3） */}
      {interrupted ? (
        <div
          style={{
            marginBottom: 22,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'var(--md-error-soft, rgba(255,59,48,0.08))',
            border: '1px solid var(--md-error)',
            color: 'var(--md-ink)',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <b style={{ color: 'var(--md-error)' }}>下载中断</b>
          <div style={{ color: 'var(--md-muted)', marginTop: 4 }}>
            {view.interruptedReason ??
              (view.tail.length ? view.tail[view.tail.length - 1] : '原因未知；已完成的部分不会丢失。')}
          </div>
        </div>
      ) : null}

      {/* 中部：大环形进度 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '20px 0',
        }}
      >
        <div style={{ position: 'relative', width: 132, height: 132, flex: '0 0 auto' }}>
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <ProgressRing
              percent={percent}
              size={132}
              stroke={9}
              colorVar={ringColor}
              spinning={view.state === 'running' && percent == null}
            />
          </div>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              fontSize: 30,
              fontWeight: 700,
              color: 'var(--md-ink)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {percent == null ? '准备中' : `${Math.round(percent)}%`}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: 'var(--md-ink)', fontVariantNumeric: 'tabular-nums' }}>
            {view.receivedBytes != null
              ? `已下 ${formatBytes(view.receivedBytes)}${
                  view.totalBytes != null ? ` / ${formatBytes(view.totalBytes)}` : ''
                }`
              : '正在准备下载…'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--md-muted)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
            {view.speedBps != null ? `↓ ${formatBytes(view.speedBps)}/s` : '速度计算中…'}
            {view.speedBps != null ? ' · ' : ''}
            {`剩余 ${fmtEta(view.etaMs)}`}
          </div>
          {requiredBytes && view.receivedBytes == null ? (
            <div style={{ fontSize: 13, color: 'var(--md-muted)', marginTop: 6 }}>
              首次装配约需下载 {formatBytes(requiredBytes)}
            </div>
          ) : null}
        </div>
      </div>

      {/* 当前文件行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--md-row, rgba(128,128,128,0.06))',
          fontSize: 13,
          color: 'var(--md-ink)',
        }}
      >
        <span style={{ color: 'var(--md-muted)' }}>当前文件</span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {currentLabel ?? '—'}
        </span>
        {/* 极细行内进度：没有真实 percent 时不画 */}
        {percent != null ? (
          <span
            style={{
              width: 90,
              height: 4,
              borderRadius: 2,
              background: 'var(--md-track, rgba(128,128,128,0.22))',
              overflow: 'hidden',
              flex: '0 0 auto',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${Math.min(100, percent)}%`,
                background: `var(${ringColor})`,
              }}
            />
          </span>
        ) : null}
      </div>

      {/* 底部动作 */}
      <div style={{ display: 'flex', gap: 12, marginTop: 24, alignItems: 'center' }}>
        {interrupted ? (
          <>
            <Btn kind="primary" onClick={onContinue}>
              ▶ 继续下载
            </Btn>
            {confirmRedo ? (
              <Btn kind="ghost" onClick={onRedownload}>
                确认从头重下？
              </Btn>
            ) : (
              <Btn kind="ghost" onClick={() => setConfirmRedo(true)}>
                重新下载
              </Btn>
            )}
            <span style={{ fontSize: 12, color: 'var(--md-muted)', marginLeft: 'auto' }}>
              已完成的部分不会丢失
            </span>
          </>
        ) : (
          <Btn kind="ghost" onClick={onBack}>
            暂停并关闭此页面（下载在后台继续）
          </Btn>
        )}
      </div>

      {/* 详情：真实日志（默认收起） */}
      <div style={{ marginTop: 18 }}>
        <button
          type="button"
          onClick={() => setLogOpen(!logOpen)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--md-blue)',
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {logOpen ? '收起详情' : '查看详情'}
        </button>
        {logOpen ? (
          <pre
            style={{
              marginTop: 10,
              maxHeight: 200,
              overflow: 'auto',
              padding: 12,
              borderRadius: 8,
              background: 'var(--md-row, rgba(128,128,128,0.06))',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--md-muted)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {(view.tail.length ? view.tail.slice(-40).join('\n') : '（暂无输出）') || '（暂无输出）'}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
