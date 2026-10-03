import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { apiBytes, apiGet, apiPost, errorText, isApiError, openPath } from '../ipc';
import { LIBRARY } from '../theme/tokens';
import type { ComicEntry, LibraryResponse } from '../types';
import { formatBytes, sniffMime } from '../util';
import { Btn, IconFolder } from '../components/atoms';

/** 库内文件路径（`GET /library/{comicName}/files/{seq}?variant=…`） */
function filePath(comicName: string, seq: number, variant: 'original' | 'translated'): string {
  return `/library/${encodeURIComponent(comicName)}/files/${seq}?variant=${variant}`;
}

/**
 * 取库内图片并转成 blob URL。
 *
 * 必须 revoke —— 一屏 20 张图、来回翻页会很快把内存吃满。
 */
function useBlobUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let alive = true;
    let created: string | null = null;
    apiBytes(path)
      .then((buf) => {
        if (!alive) return;
        created = URL.createObjectURL(new Blob([buf], { type: sniffMime(buf) }));
        setUrl(created);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);
  return url;
}

function Thumb({ comicName, seq }: { comicName: string; seq: number }) {
  const url = useBlobUrl(filePath(comicName, seq, 'translated'));
  return url ? (
    <img className="grid-thumb" src={url} alt={`第 ${seq} 页译文`} draggable={false} />
  ) : (
    <div className="grid-placeholder">加载中…</div>
  );
}

function Pane({
  comicName,
  seq,
  variant,
}: {
  comicName: string;
  seq: number;
  variant: 'original' | 'translated';
}) {
  const url = useBlobUrl(filePath(comicName, seq, variant));
  const label = variant === 'original' ? '原图' : '译文';
  const file = `${String(seq).padStart(3, '0')}${variant === 'translated' ? '_translated' : ''}.png`;
  return (
    <div className="pane">
      <div className="pane-title">
        <span>{label}</span>
        <span className="muted num" style={{ fontSize: 10.5 }}>
          {file}
        </span>
      </div>
      <div className="pane-body">
        {url ? (
          <img src={url} alt={`第 ${seq} 页${label}`} draggable={false} />
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            该侧文件缺失
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 画面 X-D2 · 原文 / 译文对照（《02》§5.6）。
 *
 * 双图对照 + 左右翻页 + 序号显示。序号按 §5.8「N / M 计数拆两个文本节点」实现为 `N / M`，
 * 与队列页计数一致（G-03）。左右方向键可翻页，Esc 返回。
 */
function Compare({
  comic,
  seq,
  onSeq,
  onBack,
}: {
  comic: ComicEntry;
  seq: number;
  onSeq: (s: number) => void;
  onBack: () => void;
}) {
  const canPrev = seq > 1;
  const canNext = seq < comic.seqMax;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && canPrev) onSeq(seq - 1);
      if (e.key === 'ArrowRight' && canNext) onSeq(seq + 1);
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seq, canPrev, canNext, onSeq, onBack]);

  return (
    <div className="compare">
      <div className="compare-head card">
        <Btn kind="ghost" onClick={onBack}>
          返回网格
        </Btn>
        <span className="compare-seq">
          <span className="num">{seq}</span>
          <span> / </span>
          <span className="num">{comic.seqMax}</span>
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {comic.comicName}
        </span>
        <div style={{ flex: 1 }} />
        <Btn kind="ghost" disabled={!canPrev} onClick={() => canPrev && onSeq(seq - 1)}>
          ← 上一张
        </Btn>
        <Btn kind="ghost" disabled={!canNext} onClick={() => canNext && onSeq(seq + 1)}>
          下一张 →
        </Btn>
      </div>
      <div className="compare-panes">
        <Pane comicName={comic.comicName} seq={seq} variant="original" />
        <Pane comicName={comic.comicName} seq={seq} variant="translated" />
      </div>
    </div>
  );
}

/**
 * 画面 X-D1 · 本地漫画库（《02》§5.5）。
 *
 * 左栏 260 以漫画名为索引（目录即索引，不维护第二份），右栏为头行 + 110×165 网格卡。
 * 「继续翻译」走契约外增量的 `POST /library/{name}/resume`（spec-notes G-07）：
 * 它只补「有原图、缺译文」的页，且**不新增编号、不覆盖原图**。
 */
export function LibraryScreen({
  lib,
  onRefresh,
  onToast,
  refreshKey,
}: {
  lib: LibraryResponse | null;
  onRefresh: () => void;
  onToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
  refreshKey: number;
}): ReactElement {
  const [active, setActive] = useState<string | null>(null);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const comics = lib?.comics ?? [];
  const current = comics.find((c) => c.comicName === active) ?? comics[0] ?? null;

  // 切库或刷新后，若当前选中的漫画没了就回到第一本
  useEffect(() => {
    if (current && current.comicName !== active) setActive(current.comicName);
  }, [current, active]);

  // 选中漫画后拉一次「缺页清单」，用于给「继续翻译」置灰 / 显示待续做张数
  useEffect(() => {
    if (!current) {
      setPending(null);
      return;
    }
    let alive = true;
    apiGet<{ pendingCount: number }>(`/library/${encodeURIComponent(current.comicName)}/resume`)
      .then((p) => {
        if (alive) setPending(p.pendingCount);
      })
      .catch((e: unknown) => {
        // 目录不存在（404）等价于「没有待续做的页」
        if (alive) setPending(isApiError(e) && e.status === 404 ? 0 : null);
      });
    return () => {
      alive = false;
    };
  }, [current, refreshKey]);

  const resume = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const res = await apiPost<{ comicName: string; queuePosition: number }>(
        `/library/${encodeURIComponent(current.comicName)}/resume`,
        {},
      );
      onToast(`已加入队列：${res.comicName}（第 ${res.queuePosition} 位）`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (!current) {
    return <div className="notice">漫画库还是空的。翻译完成后，成品会出现在这里的根目录下。</div>;
  }

  if (compareSeq !== null) {
    return (
      <Compare comic={current} seq={compareSeq} onSeq={setCompareSeq} onBack={() => setCompareSeq(null)} />
    );
  }

  return (
    <div className="lib">
      <aside
        className="lib-left"
        style={{ width: LIBRARY.leftColumnWidth, flexBasis: LIBRARY.leftColumnWidth }}
      >
        <div className="lib-left-list">
          {comics.map((c) => (
            <button
              key={c.comicName}
              type="button"
              className={c.comicName === current.comicName ? 'lib-item is-active' : 'lib-item'}
              onClick={() => setActive(c.comicName)}
            >
              <span className="lib-item-name" title={c.comicName}>
                {c.comicName}
              </span>
              <span className="lib-item-meta">
                <span className="num">{c.imageCount}</span> 张 ·{' '}
                {c.translatedCount === c.imageCount ? '已译完' : `缺 ${c.imageCount - c.translatedCount}`}
              </span>
            </button>
          ))}
        </div>
        <div className="lib-left-foot">
          <span>已用容量</span>
          <span className="num">{formatBytes(lib?.totalBytes ?? 0)}</span>
        </div>
      </aside>

      <section className="lib-right">
        <div className="lib-head card">
          <div className="lib-head-titles">
            <div className="lib-head-name" title={current.comicName}>
              {current.comicName}
            </div>
            <div className="lib-head-path" title={current.outputDir}>
              {current.outputDir}
            </div>
          </div>
          <Btn
            kind="ghost"
            onClick={() =>
              openPath(current.outputDir).catch((e: unknown) => onToast(errorText(e), 'bad'))
            }
          >
            <IconFolder />
            打开目录
          </Btn>
          <Btn
            kind="primary"
            disabled={busy || pending === 0}
            title={pending === 0 ? '该漫画没有待续做的页' : `待续做 ${pending ?? '…'} 张`}
            onClick={resume}
          >
            继续翻译{pending ? `（${pending}）` : ''}
          </Btn>
        </div>

        <div className="card lib-grid-wrap">
          <div className="lib-grid">
            {Array.from({ length: current.seqMax }, (_, i) => i + 1).map((seq) => (
              <button
                key={seq}
                type="button"
                className="grid-card"
                style={{
                  width: LIBRARY.card.w,
                  height: LIBRARY.card.h,
                  borderRadius: LIBRARY.card.radius,
                }}
                onClick={() => setCompareSeq(seq)}
                title={`第 ${seq} 页`}
              >
                <Thumb comicName={current.comicName} seq={seq} />
                <span className="grid-foot">
                  <span className="num">{String(seq).padStart(3, '0')}</span>
                  <span>{seq <= current.translatedCount ? '已译' : '待译'}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="lib-foot-note">
          <span>
            显示 <span className="num">{current.seqMax}</span> /{' '}
            <span className="num">{current.seqMax}</span> 组
          </span>
          <span>点任意一格看原文 / 译文对照</span>
        </div>
      </section>
    </div>
  );
}
