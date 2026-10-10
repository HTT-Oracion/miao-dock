// 漫画库的三个弹窗（设计稿 §7.6.1 / §7.6.2 / §7.6.3）。
//
// ## 为什么抽到屏外
// `LibraryScreen.tsx` 已经被断言脚本按路径写死并读源码（`e2e/units-structure-check.mjs:71`、
// `e2e/service/retranslate-check.mjs:66`、`e2e/service/library-manage-check.mjs:426`），
// 搬动它有静默跳过断言的风险；但"三个弹窗 + 左栏分组 + 两屏"塞进同一个文件会把它推到
// 两千行以上。故按 plan Step 5 注意事项 1 的裁定：**新件**落 `app/src/screens/library/`，
// 老文件原地不动。
//
// ## 这三个弹窗的共同纪律
// 都是**受控视图**：自己只持"草稿"（输入框里的字、选中的封面来源、话号草稿），
// 一律不自己发请求 —— 提交交给屏（`LibraryScreen`），因为提交后要 `onRefresh()`、
// 要发 Toast、要在失败时把结构化错误翻译成人话，那些都在屏里。
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';

import { Btn, Select } from '@components/units';
import { chapterNoOf, coverFileName, dupKey, padChapterNo, shortPath } from '@tools';
import type { BookEntry } from '@/types';
import { bookFirstImagePath, coverPath, useBlobUrl } from '@screens/library/blob';

/** Windows/POSIX 双料的非法文件名字符（与 `tools.dupKey()` 剥的是同一批） */
const ILLEGAL_NAME_RE = /[/\\:*?"<>|]/;

/** 作者上限（设计稿 §7.6.2：0–40 字） */
const MAX_AUTHOR_CHARS = 40;

/** 弹窗外壳：三支弹窗共用，避免三次抄同一段蒙层/圆角/点外关闭 */
function Sheet({
  title,
  busy,
  onClose,
  children,
  actions,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 7.6.1 新建漫画

/**
 * 新建漫画弹窗。
 *
 * 校验分三层，**顺序即优先级**（后面那条不会盖住前面那条）：
 * ① 空名 → 「请填写漫画名」；② 非法字符；③ 同名（比对口径 = `dupKey`，与服务端规范化同源起手）。
 *
 * ⚠️ 客户端同名预检**不是**权威判据：真正的同名校验在服务端（`BOOK_NAME_TAKEN` 409）。
 * 这里只是"别让用户白跑一趟"；漏判时服务端仍然会拦，所以宁可靠近似比对多拦一次。
 */
export function NewBookModal({
  root,
  existing,
  busy,
  onCancel,
  onConfirm,
  onViewExisting,
}: {
  /** 库根目录（预览落点用） */
  root: string;
  /** 库里已有的目录名（`comics[].dirName`），用于同名预检 */
  existing: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (name: string, author: string) => void;
  /** 同名时「查看它」：关掉弹窗并选中库里那一本 */
  onViewExisting: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  /** 用户动过输入框才提示"必填" —— 一打开就红字是噪音，不是校验 */
  const [touched, setTouched] = useState(false);

  const trimmed = name.trim();
  const dup = useMemo(() => {
    if (!trimmed) return null;
    const k = dupKey(trimmed);
    return existing.find((n) => dupKey(n) === k) ?? null;
  }, [trimmed, existing]);

  const empty = trimmed.length === 0;
  const illegal = ILLEGAL_NAME_RE.test(trimmed);
  const error = illegal
    ? '漫画名不能包含 \\ / : * ? " < > |'
    : dup
      ? `本地已存在同名目录「${dup}」，不能重复创建`
      : empty && touched
        ? '请填写漫画名'
        : '';
  const canSubmit = !busy && !empty && !illegal && !dup;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm(trimmed, author.trim().slice(0, MAX_AUTHOR_CHARS));
  };

  return (
    <Sheet
      title="新建漫画"
      busy={busy}
      onClose={onCancel}
      actions={
        <>
          <Btn kind="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Btn>
          <Btn kind="primary" onClick={submit} disabled={!canSubmit}>
            {busy ? '创建中…' : '创建'}
          </Btn>
        </>
      }
    >
      <div className="modal-label">漫画名 *</div>
      <input
        className="input"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setTouched(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="例如：夏日重现"
        spellCheck={false}
        autoFocus
      />
      <div className="modal-hint">将在本地目录创建同名文件夹</div>
      <div className="pathpreview" style={{ margin: '6px 0 10px' }}>
        {shortPath(`${root}/${trimmed || '…'}`, 60)}
      </div>

      <div className="modal-label">作者（选填）</div>
      <input
        className="input"
        value={author}
        maxLength={MAX_AUTHOR_CHARS}
        onChange={(e) => setAuthor(e.target.value)}
        placeholder="未署名"
        spellCheck={false}
      />

      {error ? (
        <div className="modal-warn">
          ⚠️ {error}
          {dup ? (
            <Btn kind="ghost" size="sm" onClick={() => onViewExisting(dup)}>
              查看它
            </Btn>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ 7.6.2 编辑漫画信息

/**
 * 「编辑信息」提交的意图。
 *
 * 用一个判别联合而不是三个回调：封面与作者是**同一次保存**里的两件事，
 * 拆成三个回调就会出现"点了保存、封面成功、作者失败"这种半落盘状态无从表达。
 * 服务端也正是按"一次请求完成一类动作"设计的（`POST /cover` 同时带 author）。
 */
export type BookMetaIntent =
  | { kind: 'meta' }
  | { kind: 'cover-local'; srcPath: string }
  | { kind: 'cover-first' }
  | { kind: 'cover-remove' };

/** 封面来源：保留现状 / 换成本地图片 / 取第 1 话首图 / 移除 */
type CoverSource = 'keep' | 'local' | 'first' | 'remove';

/**
 * 编辑漫画信息弹窗（封面 + 作者）。
 *
 * ## 关键时序：**选图不落盘，保存才落盘**（plan §4.2）
 * 点「选择本地图片」只把路径存进 state，磁盘零变化；点「保存」才提交。
 * 于是"选了图又点取消"不会在书目录里留下半截 `cover.*`。
 *
 * ## 预览的三条来源
 * 都是"某个路径的字节"：`keep` → 当前封面（带 `modifiedAt` 版本号，避免换图后串旧缓存）；
 * `first` → 首话首图；`local` / `remove` → 不做预览（本地路径 WebView 读不了，
 * 见 plan §4.3 选项 B；选了本地图时退化成"文件名 + 大小 + 保存后生效"）。
 */
export function EditBookModal({
  book,
  busy,
  onCancel,
  onSubmit,
}: {
  book: BookEntry;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (intent: BookMetaIntent, author: string) => void;
}) {
  const [author, setAuthor] = useState(book.author);
  const [source, setSource] = useState<CoverSource>('keep');
  const [srcPath, setSrcPath] = useState<string | null>(null);

  const previewPath = (() => {
    if (source === 'keep') return coverPath(book.bookName, book.modifiedAt);
    if (source === 'first') return bookFirstImagePath(book.bookName, book.chapters);
    return null; // local 见下方说明；remove 就是"没有封面"
  })();
  const blob = useBlobUrl(previewPath);
  const canRemove =
    source !== 'remove' && (source !== 'keep' || book.coverPath !== null);

  const pickLocal = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (typeof picked !== 'string') return; // 取消 → 磁盘与弹窗状态都不动
    setSrcPath(picked);
    setSource('local');
  };

  const canSave = !busy && !(source === 'local' && !srcPath);
  const submit = () => {
    if (!canSave) return;
    const intent: BookMetaIntent =
      source === 'local'
        ? { kind: 'cover-local', srcPath: srcPath! }
        : source === 'first'
          ? { kind: 'cover-first' }
          : source === 'remove'
            ? { kind: 'cover-remove' }
            : { kind: 'meta' };
    onSubmit(intent, author.trim().slice(0, MAX_AUTHOR_CHARS));
  };

  return (
    <Sheet
      title={`编辑《${book.bookName}》`}
      busy={busy}
      onClose={onCancel}
      actions={
        <>
          <Btn kind="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Btn>
          <Btn kind="primary" onClick={submit} disabled={!canSave}>
            {busy ? '保存中…' : '保存'}
          </Btn>
        </>
      }
    >
      <div className="modal-label">封面</div>
      <div className="cover-box">
        <div className="cover-preview">
          {source === 'remove' ? (
            <div className="cover-ph">已移除</div>
          ) : source === 'local' ? (
            <div className="cover-ph">{srcPath ? coverFileName(srcPath) : '未选图'}</div>
          ) : blob.kind === 'ready' ? (
            <img className="cover-img" src={blob.url} alt="封面预览" draggable={false} />
          ) : (
            <div className="cover-ph">{blob.kind === 'loading' ? '加载中…' : '无封面'}</div>
          )}
        </div>
        <div className="cover-acts">
          <Btn kind="ghost" size="sm" onClick={() => void pickLocal()} disabled={busy}>
            <ImagePlus size={13} />
            选择本地图片
          </Btn>
          <Btn
            kind="ghost"
            size="sm"
            onClick={() => setSource('first')}
            disabled={busy || book.chapters.length === 0}
            title={book.chapters.length === 0 ? '这本还没有任何一话' : '用第 1 话的第一张图'}
          >
            取第 1 话首图
          </Btn>
          <Btn
            kind="ghost"
            size="sm"
            onClick={() => {
              setSrcPath(null);
              setSource('remove');
            }}
            // 「移除」只在"当前有封面可移"时可用：原本就没封面、或已经选了「移除」，
            // 这个按钮点下去不会有任何变化 —— 能点却没反应比置灰更让人困惑。
            disabled={busy || !canRemove}
          >
            <Trash2 size={13} />
            移除
          </Btn>
        </div>
      </div>
      {source === 'local' ? (
        <div className="modal-hint">
          {srcPath ? `已选：${coverFileName(srcPath)} · 保存后生效` : '选择一张图片作为封面'}
        </div>
      ) : null}
      <div className="modal-hint">支持 png / jpg / jpeg / webp，上限 10 MiB；扩展名由文件内容决定</div>

      <div className="modal-label">作者</div>
      <input
        className="input"
        value={author}
        maxLength={MAX_AUTHOR_CHARS}
        onChange={(e) => setAuthor(e.target.value)}
        placeholder="未署名"
        spellCheck={false}
      />
      <div className="modal-hint">
        留空则显示「未署名」（<span className="num">{author.length}</span> / {MAX_AUTHOR_CHARS}）
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ 7.6.3 归并

/** 目标大类里已被占用的话号集合（**从目录名反推** —— 与服务端 409 的判据同一个契约） */
function takenChapterNos(book: BookEntry): Set<number> {
  const out = new Set<number>();
  for (const c of book.chapters) {
    const no = chapterNoOf(c.dirName);
    if (no !== null) out.add(no);
  }
  return out;
}

/** 目标大类的默认话号 = `max(话号) + 1`；一话都没有 ⇒ 1（设计稿 §7.6.3） */
function nextChapterNo(book: BookEntry): number {
  let max = 0;
  for (const no of takenChapterNos(book)) {
    if (no > max) max = no;
  }
  return max + 1;
}

/**
 * 归并弹窗：把「其它」里的未归并单话挂到某本漫画的某一话。
 *
 * ## 冲突为什么是"三选一"而不是"服务端替我挑一个"
 * 目标话号被占用时服务端直接 409 `CHAPTER_NO_TAKEN` —— 它**不会**覆盖、也不会顺延。
 * 所以"改话号 / 顺延到下一空位"这两条路必须在**提交之前**由用户选：
 * 让服务端去猜"用户想要覆盖还是顺延"，猜错的后果是**静默毁掉一话的译文**。
 */
export function MergeModal({
  source,
  books,
  busy,
  onCancel,
  onConfirm,
}: {
  /** 待归并的未归并单话**目录名** */
  source: string;
  /** 可选目标：只有大类（「其它」不出现在这里，设计稿 §7.6.3） */
  books: BookEntry[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (target: string, no: number) => void;
}) {
  const [target, setTarget] = useState(books[0]?.bookName ?? '');
  const [noText, setNoText] = useState(() => (books[0] ? String(nextChapterNo(books[0])) : '1'));
  const noRef = useRef<HTMLInputElement>(null);

  const targetBook = books.find((b) => b.bookName === target) ?? null;
  const taken = useMemo(() => (targetBook ? takenChapterNos(targetBook) : new Set<number>()), [targetBook]);

  // 话号校验：整数且 ≥ 1（设计稿 §8.4「话号须为 ≥1 的整数」）
  const no = /^\d+$/.test(noText.trim()) ? Number(noText.trim()) : NaN;
  const noOk = Number.isInteger(no) && no >= 1;
  const conflict = noOk && taken.has(no);

  const noError = noOk ? '' : '话号须为 ≥1 的整数';
  const canSubmit = !busy && !!targetBook && noOk && !conflict;

  /** 顺延到「大于当前话号的最小空位」；再没有空位（连续占满）就顺延到 max+1 */
  const shiftToFree = () => {
    let n = noOk ? no + 1 : 1;
    while (taken.has(n)) n++;
    setNoText(String(n));
  };

  return (
    <Sheet
      title={`归并「${source}」`}
      busy={busy}
      onClose={onCancel}
      actions={
        <>
          <Btn kind="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Btn>
          <Btn kind="primary" onClick={() => canSubmit && onConfirm(target, no)} disabled={!canSubmit}>
            {busy ? '归并中…' : '确认归并'}
          </Btn>
        </>
      }
    >
      {books.length === 0 ? (
        <div className="modal-warn">⚠️ 库里还没有漫画（本），请先「新建漫画」，再把它归并进去。</div>
      ) : (
        <>
          <div className="modal-label">目标漫画 *</div>
          <Select
            value={target}
            options={books.map((b) => ({ value: b.bookName, label: `《${b.bookName}》` }))}
            onChange={setTarget}
            label="目标漫画"
          />

          <div className="modal-label">话号 *</div>
          <input
            ref={noRef}
            className="input"
            value={noText}
            inputMode="numeric"
            onChange={(e) => setNoText(e.target.value)}
            spellCheck={false}
          />
          {noError ? <div className="modal-warn">⚠️ {noError}</div> : null}

          <div className="modal-hint">
            预览：将《{source}》归并为《{target}》第 <span className="num">{noOk ? no : '?'}</span> 话（目录名{' '}
            {noOk ? `${padChapterNo(no)}_第${no}话` : '—'}）
          </div>

          {conflict ? (
            <div className="modal-warn">
              ⚠️ 第 <span className="num">{no}</span> 话已有内容。
              <div className="modal-warn-acts">
                <Btn kind="ghost" size="sm" onClick={() => noRef.current?.focus()} disabled={busy}>
                  改话号
                </Btn>
                <Btn kind="ghost" size="sm" onClick={shiftToFree} disabled={busy}>
                  顺延到下一空位
                </Btn>
                <Btn kind="ghost" size="sm" onClick={onCancel} disabled={busy}>
                  取消
                </Btn>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
