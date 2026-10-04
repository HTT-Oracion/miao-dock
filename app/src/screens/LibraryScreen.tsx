import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { apiBytes, apiGet, apiPost, errorText, isApiError, openPath } from '@/ipc';
import { LIBRARY } from '@/theme/tokens';
import type { ComicEntry, LibraryResponse } from '@/types';
import { formatBytes, sniffMime } from '@/util';
import { Btn } from '@components/units';
import { FolderUp } from 'lucide-react';

/** 库内文件路径（`GET /library/{comicName}/files/{seq}?variant=…`） */
function filePath(comicName: string, seq: number, variant: 'original' | 'translated'): string {
  return `/library/${encodeURIComponent(comicName)}/files/${seq}?variant=${variant}`;
}

/** blob 取图的结果：`missing` = 文件不存在（含未发起请求），与 `loading` 必须分开 */
type BlobState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'missing' };

/**
 * 取库内图片并转成 blob URL。
 *
 * 必须 revoke —— 一屏 20 张图、来回翻页会很快把内存吃满。
 *
 * 返回**三态**而不是 `string | null`：`null` 同时表达了「还在取」和「取不到」，
 * 调用方无从区分，于是只能一律显示「加载中…」—— 文件根本不存在时就会**永远**停在加载中。
 */
function useBlobUrl(path: string | null): BlobState {
  const [state, setState] = useState<BlobState>({ kind: 'loading' });
  useEffect(() => {
    if (!path) {
      setState({ kind: 'missing' });
      return;
    }
    let alive = true;
    let created: string | null = null;
    setState({ kind: 'loading' });
    apiBytes(path)
      .then((buf) => {
        if (!alive) return;
        created = URL.createObjectURL(new Blob([buf], { type: sniffMime(buf) }));
        setState({ kind: 'ready', url: created });
      })
      .catch(() => {
        if (alive) setState({ kind: 'missing' });
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);
  return state;
}

/**
 * 网格卡三态 —— 判定依据是 `/library` 给出的**逐页**集合（`translatedSeqs` / `missingSeqs`），
 * 不是张数。张数只能回答「译了几页」，回答不了「译了哪几页」；缺页落在中间时，
 * 用张数推出来的结论会把后面每一页整体前移一位，见 spec-notes G-10。
 */
type GridState = 'done' | 'pending' | 'missing';

const GRID_LABEL: Record<GridState, string> = { done: '已译', pending: '待译', missing: '缺页' };

/**
 * 左栏每部漫画的状态短语。
 *
 * 原先这里只写 `缺 ${imageCount - translatedCount}`，而那个数其实是**没有译文的**页数
 * —— 于是同一屏上冒出两个含义相反的「缺」：左栏说「缺 1」（那一页其实有原图，只是待译），
 * 网格卡说「缺页」（专指**没有原图**）。字面同源、意思不同，正是 G-11 里
 * 「同一张图、两屏两个故事」的翻版。逐页集合（G-10）已经能分开算，就没理由继续含糊。
 */
function progressLabel(c: ComicEntry): string {
  if (c.imageCount === 0) return '空目录';
  const missing = c.missingSeqs.length;
  const pending = c.imageCount - c.translatedCount - missing;
  if (pending <= 0 && missing <= 0) return '已译完';
  const parts: string[] = [];
  if (pending > 0) parts.push(`待译 ${pending}`);
  if (missing > 0) parts.push(`缺页 ${missing}`);
  return parts.join(' · ');
}

/**
 * 网格缩略图。三态必须分开，且**只在确实有译文时才发请求** ——
 * 对已知没有译文的页仍去取一次、失败后显示「加载中…」，是把「不存在」伪装成「还没到」。
 */
function Thumb({ comicName, seq, state }: { comicName: string; seq: number; state: GridState }) {
  // hooks 不能条件调用，故把「要不要取」编码进 path（null = 不取）
  const blob = useBlobUrl(state === 'done' ? filePath(comicName, seq, 'translated') : null);
  if (state === 'done') {
    if (blob.kind === 'loading') return <div className="grid-placeholder">加载中…</div>;
    if (blob.kind === 'ready') {
      return <img className="grid-thumb" src={blob.url} alt={`第 ${seq} 页译文`} draggable={false} />;
    }
    // 库扫描说这页有译文、文件却取不到 —— 不装作没事
    return (
      <div className="grid-placeholder is-bad" title="库里有这一页的译文记录，但文件读不出来">
        读取失败
      </div>
    );
  }
  if (state === 'missing') return <div className="grid-placeholder">缺页</div>;
  return <div className="grid-placeholder">待译</div>;
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
  const blob = useBlobUrl(filePath(comicName, seq, variant));
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
        {blob.kind === 'ready' ? (
          <img src={blob.url} alt={`第 ${seq} 页${label}`} draggable={false} />
        ) : (
          // 取图中 / 确实没有，是两件事：前者会换成图，后者不会
          <span className="muted" style={{ fontSize: 11 }}>
            {blob.kind === 'loading' ? '加载中…' : '该侧文件缺失'}
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

  // 逐页判定用集合，不用张数（G-10）。`?? []` 只是防御：服务由本应用自己拉起，
  // 正常情况下这两个字段一定在；真缺了也只是退化成「全部待译」，不会白屏。
  const translatedSeqs = new Set(current?.translatedSeqs ?? []);
  const missingSeqs = new Set(current?.missingSeqs ?? []);

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
                {progressLabel(c)}
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
            <FolderUp size={14} />
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
            {Array.from({ length: current.seqMax }, (_, i) => i + 1).map((seq) => {
              const state: GridState = missingSeqs.has(seq)
                ? 'missing'
                : translatedSeqs.has(seq)
                  ? 'done'
                  : 'pending';
              return (
                <button
                  key={seq}
                  type="button"
                  className="grid-card"
                  style={{
                    width: LIBRARY.card.w,
                    height: LIBRARY.card.h,
                    borderRadius: LIBRARY.card.radius,
                  }}
                  disabled={state === 'missing'}
                  onClick={() => setCompareSeq(seq)}
                  title={
                    state === 'missing'
                      ? `第 ${seq} 页在本机没有原图，无法对照`
                      : `第 ${seq} 页 · 点开看原文 / 译文对照`
                  }
                >
                  <Thumb comicName={current.comicName} seq={seq} state={state} />
                  <span className="grid-foot">
                    <span className="num">{String(seq).padStart(3, '0')}</span>
                    <span
                      className={state === 'missing' ? 'is-bad' : undefined}
                      title={
                        state === 'done'
                          ? `第 ${seq} 页：本地已有译文`
                          : state === 'pending'
                            ? `第 ${seq} 页：有原图、缺译文 —— 点「继续翻译」可以补`
                            : `第 ${seq} 页：本机没有这一页`
                      }
                    >
                      {GRID_LABEL[state]}
                    </span>
                  </span>
                </button>
              );
            })}
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
