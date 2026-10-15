// 漫画库的**字节取用**收口：库内文件路径的构造 + blob URL 缓存 + `useBlobUrl`。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-119）：新增的「编辑信息」弹窗要预览封面，
// 而封面同样是"服务端发字节、前端转 blob"。留在屏内就得把它 export 出去让弹窗 import，
// 形成 LibraryScreen ↔ 弹窗 的**循环 import**；复制一份又是两份 LRU 缓存、
// 同一张图被取两次。字节取用本来就是一个独立关切，故单开本模块。
//
// 本文件的三个路径构造器**必须与服务端路由逐字对齐**（`service/src/server.mjs` 的
// `/library` 段）。路径字符串同时也是缓存键，所以这里的字节一旦与路由不同名，
// 症状不是报错而是 404 —— 缩略图永远停在「加载中…」。
import { useEffect, useState } from 'react';

import { apiBytes } from '@/ipc';
import { sniffMime } from '@tools';

/** 变体：原图 / 译文 */
export type Variant = 'original' | 'translated';

/**
 * 一屏页集合的**投影**：把「整本」「大类里的一话」两种页来源归一成同一个取图接口。
 *
 * 三种来源在此归一：旧口径的整本（`ComicEntry`，顶层取图）、大类里的一话
 * （`ChapterEntry`，话内取图）。没有这条投影，网格就得在自己体内判一遍
 * "我这一格是整本还是话" —— 那个判断只该有一处，就是这里的 `imagePath()` 闭包。
 *
 * 🔴 `imagePath` 返回的路径**必须含「书 + 话 + 页」三段**：路径同时是 `URL_CACHE`
 * 的键（D-117），只按页号做键会让《A》第 1 话第 1 页与《B》第 1 话第 1 页命中
 * 同一条缓存 —— 跨书串图，且是"看起来正常、内容错了"的最难发现的那类缺陷。
 *
 * D-148：从 `LibraryScreen.tsx` 移来（`Compare`/`viewer.tsx` 也要用它；留在屏内会成环）。
 */
export interface PageView {
  /** 操作端点基址：`/library/{名}` 或 `/library/{书}/chapters/{话}`（续做 / 返工都挂在它下面） */
  base: string;
  /** 归因显示名（对照头部 / 全屏回显 / Toast）：编码过的目录名不能直接给人看 */
  comicName: string;
  seqMax: number;
  translatedSeqs: number[];
  missingSeqs: number[];
  /** 第 `seq` 页 `variant` 侧的字节路径 */
  imagePath(seq: number, variant: Variant): string;
}

/**
 * **顶层目录**内的文件路径（未归并单话、以及旧「一目录 = 一漫画」的成品都走这里）。
 *
 * `GET /library/{comicName}/files/{seq}?variant=…`
 */
export function filePath(comicName: string, seq: number, variant: Variant): string {
  return `/library/${encodeURIComponent(comicName)}/files/${seq}?variant=${variant}`;
}

/**
 * **话内**文件路径：`GET /library/{book}/chapters/{no}/files/{seq}?variant=…`
 *
 * ⚠️ 缓存键必须含「书 + 话 + 页」三段。只按 `seq` 做键会让《A》第 1 话第 1 页与
 * 《B》第 1 话第 1 页命中同一条缓存 —— 那是"看起来正常、内容错了"这类最难发现的缺陷（D-117）。
 */
export function chapterFilePath(bookName: string, no: number, seq: number, variant: Variant): string {
  return `/library/${encodeURIComponent(bookName)}/chapters/${no}/files/${seq}?variant=${variant}`;
}

/**
 * 封面字节路径：`GET /library/{book}/cover[?v=…]`
 *
 * `revision` 是**缓存失效用的版本号**（传书籍的 `modifiedAt`）。封面文件名固定叫
 * `cover.png|jpg|…`，换一张 png 后路径完全不变 ⇒ 不带上版本号就会一直显示旧图
 * （缓存按路径命中）。服务端按 pathname 路由，查询串本就被忽略。
 */
export function coverPath(bookName: string, revision?: string | null): string {
  const base = `/library/${encodeURIComponent(bookName)}/cover`;
  return revision ? `${base}?v=${encodeURIComponent(revision)}` : base;
}

/**
 * 一话 / 一部 / 一个大类的**页集合**（按结构收参，不 import 业务类型）。
 *
 * `ChapterEntry`、`ComicEntry`、未归并单话的扫描结果三者都**结构兼容**这个形状，
 * 所以屏里可以直接互相传递、不必断言或转换。字段名一律照抄服务端（`scanChapterPages`），
 * 免得出现"这里叫 pages、那里叫 count"的第二套说法。
 */
export interface PageSet {
  seqMax: number;
  /** 有原图的页数 */
  imageCount: number;
  /** 有译文的页数（**只能用来报数**，不能用它推「哪几页已译」，见 G-10） */
  translatedCount: number;
  missingSeqs: number[];
  translatedSeqs: number[];
}

/** 数组最小值；空数组 ⇒ `null`。手写循环而不用 `Math.min(...arr)`：页数上千时展开会爆栈 */
function minOf(xs: number[]): number | null {
  let min: number | null = null;
  for (const x of xs) if (min === null || x < min) min = x;
  return min;
}

/**
 * 「第一张**有原图**的页」的页号（从 1 开始扫，跳过缺页）；一页都没有 ⇒ `null`。
 *
 * 为什么不能直接取 `1`：`missingSeqs` 正是"1..seqMax 内没有原图"的那批页码（G-11），
 * 目录没拷全时第 1 页就可能是空的。取 1 会得到一个必然 404 的路径 ——
 * 界面上表现为缩略图永远停在占位，且**看不出原因**。
 */
function firstPageOf(ch: PageSet): number | null {
  const missing = new Set(ch.missingSeqs);
  for (let s = 1; s <= ch.seqMax; s++) {
    if (!missing.has(s)) return s;
  }
  return null;
}

/** 该页该用译文还是原图 —— 与 `progressLabel`/网格卡同一口径：用**逐页集合**判，不用张数（G-10） */
function variantOf(ch: PageSet, seq: number): Variant {
  return ch.translatedSeqs.includes(seq) ? 'translated' : 'original';
}

/**
 * **顶层目录**（未归并单话）首图路径。
 *
 * 服务端 `pickFirstChapterImage()` 是同一口径的服务端版本（用于「取第 1 话首图」落盘），
 * 这里是它的前端只读孪生。两处必须同判据：否则"预览看到的那张"与"落盘的那张"会不是同一张。
 */
export function topLevelFirstImagePath(dirName: string, ch: PageSet): string | null {
  const seq = firstPageOf(ch);
  return seq === null ? null : filePath(dirName, seq, variantOf(ch, seq));
}

/**
 * **大类**首话首图的路径：取话号最小的话（服务端已按话号升序）里的第一张有图页。
 *
 * 用作「无封面时显示首话首图」的回退（设计稿 §7.1 左上缩略、§7.3 头部卡封面）。
 * 全书一话都没有图 ⇒ `null` ⇒ 调用方显示占位（`line-soft` 底 + 书名首字）。
 */
export function bookFirstImagePath(bookName: string, chapters: ({ no: number | null } & PageSet)[]): string | null {
  for (const ch of chapters) {
    if (ch.no === null) continue; // 大类里的话恒有话号；防御非话目录混进来
    const seq = firstPageOf(ch);
    if (seq === null) continue; // 这一话是空话 ⇒ 往后找下一话
    return chapterFilePath(bookName, ch.no, seq, variantOf(ch, seq));
  }
  return null;
}

/**
 * **话卡缩略图**路径（设计稿 §7.3）：该话**第一张译文图**；整话还没译完则退回首张原图；
 * 一张原图都没有（空话）⇒ `null`，由调用方显示「空话」占位。
 *
 * 为什么不是「第一张有原图页」那个口径（`bookFirstImagePath` 用的）：话卡要回答的是
 * "翻过这一话你大概会看到什么"。一话里只有第 3 页译完时，缩略图该是那张**译文**
 * ——拿第 1 页原图当缩略图会让"这一话已经译了"这件事在列表里完全看不出来。
 * 两者在"整话未译"时结果相同，因此算不上第二套判据。
 */
export function chapterImagePath(bookName: string, ch: { no: number | null } & PageSet): string | null {
  if (ch.no === null) return null; // 话号都没有 ⇒ 它不是话目录，拼不出路径
  const seq = minOf(ch.translatedSeqs) ?? firstPageOf(ch);
  return seq === null ? null : chapterFilePath(bookName, ch.no, seq, variantOf(ch, seq));
}

/**
 * 取图结果的 blob URL 缓存（**跨组件、跨卸载**）。
 *
 * ## 为什么必须有它
 * 从对照视图点「返回」回到网格时，网格里每一张缩略图都会被**重新挂载**，
 * 于是每个 `useBlobUrl` 都会重新走一次 IPC 取字节 —— 表现就是"返回后整片网格刷一下、
 * 先闪一片『加载中…』再逐张出图"。缓存把已经取到的 blob URL 留下来，
 * 重新挂载时**同步命中**（useState 惰性初始化里就能拿到），于是不再有那一下闪烁。
 *
 * ## 所有权：缓存持有 URL，组件不再 revoke
 * 旧实现是"组件挂载时建 URL、卸载时 revoke"。一旦引入缓存，这条所有权就不成立了 ——
 * 组件卸载后 revoke 掉，缓存里就成了死链。所以改为：**由缓存统一持有并管理 revoke**，
 * 组件只借用。淘汰（LRU）时才 revoke 掉最旧的一条。
 *
 * ## 为什么在途请求也要去重
 * 同一页可能被网格卡与对照视图**同时**请求（返回时更是如此）。不去重就会为同一条路径
 * 建出两个 object URL，其中一个永远不会被引用、也永远不会被 revoke —— 纯泄漏。
 */
const URL_CACHE = new Map<string, string>(); // path → objectURL；Map 的插入序即 LRU 序
const URL_CACHE_MAX = 160;
const INFLIGHT = new Map<string, Promise<string>>();

/** 命中缓存（并把该条移到 LRU 末尾）；未命中返回 null */
function cachePeek(path: string): string | null {
  const url = URL_CACHE.get(path);
  if (url === undefined) return null;
  URL_CACHE.delete(path);
  URL_CACHE.set(path, url);
  return url;
}

/** 存入缓存并在超限时淘汰最旧的一条（连同 revoke） */
function cachePut(path: string, url: string): void {
  URL_CACHE.set(path, url);
  while (URL_CACHE.size > URL_CACHE_MAX) {
    const oldest = URL_CACHE.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const dead = URL_CACHE.get(oldest);
    URL_CACHE.delete(oldest);
    if (dead) URL.revokeObjectURL(dead);
  }
}

/** 取一条路径的 blob URL：先查缓存，再查在途，最后才真发一次请求 */
function fetchBlobUrl(path: string): Promise<string> {
  const hit = cachePeek(path);
  if (hit) return Promise.resolve(hit);
  const inflight = INFLIGHT.get(path);
  if (inflight) return inflight;
  const p = apiBytes(path)
    .then((buf) => {
      const url = URL.createObjectURL(new Blob([buf], { type: sniffMime(buf) }));
      cachePut(path, url);
      return url;
    })
    .finally(() => {
      INFLIGHT.delete(path);
    });
  INFLIGHT.set(path, p);
  return p;
}

/** blob 取图的结果：`missing` = 文件不存在（含未发起请求），与 `loading` 必须分开 */
export type BlobState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'missing' };

/**
 * 取库内图片并转成 blob URL（经上面的缓存）。
 *
 * 返回**三态**而不是 `string | null`：`null` 同时表达了「还在取」和「取不到」，
 * 调用方无从区分，于是只能一律显示「加载中…」—— 文件根本不存在时就会**永远**停在加载中。
 */
export function useBlobUrl(path: string | null): BlobState {
  // 惰性初始化：**重新挂载时若缓存已命中，首帧就是 ready**，不经过 loading —— 这就是"不闪"的来源
  const [state, setState] = useState<BlobState>(() => {
    if (!path) return { kind: 'missing' };
    const hit = cachePeek(path);
    return hit ? { kind: 'ready', url: hit } : { kind: 'loading' };
  });

  useEffect(() => {
    if (!path) {
      setState({ kind: 'missing' });
      return;
    }
    const hit = cachePeek(path);
    if (hit) {
      setState({ kind: 'ready', url: hit });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    fetchBlobUrl(path)
      .then((url) => {
        if (alive) setState({ kind: 'ready', url });
      })
      .catch(() => {
        if (alive) setState({ kind: 'missing' });
      });
    // ⚠️ 故意**不 revoke** —— URL 归缓存所有（见上面 URL_CACHE 的说明）
    return () => {
      alive = false;
    };
  }, [path]);

  return state;
}
