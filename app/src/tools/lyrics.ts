// 歌词解析的**纯函数**收口：LRC / YRC(逐字) 解析 · 逐字时长补齐 · 译文合并 · 按秒定位行。
//
// 为什么从 `music/store.ts` 抽出来（D-149）：这些是**零依赖纯函数**（进出都是字符串 / 数组），
// 却被 store 独占 —— 而 `tools/index.ts` 头注释明说「纯函数便于在规格自检里单独验证」，
// 这个约定在歌词解析上原先没遵守。抽出来后播放器 / 歌词窗 / 灵动岛可共用，也能单独测。

/**
 * 逐字歌词里的一个词（yrc / qrc 词级数据）。
 *
 * ⚠️ 口径统一用**秒**（与 `ParsedLyricLine.time` 一致）——本项目踩过
 * `ParsedLyricLine` 字段「一处秒一处毫秒」的坑，逐字数据不能再引入第三种口径。
 */
export interface LyricWord {
  /** 该词起始时间（秒） */
  t: number;
  /** 该词持续时长（秒），下限 0.06s（见 parseYrc） */
  d: number;
  /** 该词首个字符在所在行 `text` 中的下标（含） */
  c0: number;
  /** 该词末尾字符在所在行 `text` 中的下标（不含） */
  c1: number;
}

/**
 * 解析后的歌词行。
 *
 * `duration` / `words` / `hasKaraoke` 是逐字高亮引入的**可选扩展** ——
 * 必填的只有 `time` + `text`，所以既有的 `lyricIndexAt`（只读 time）与
 * `pushLyricsState`（只读 time/text）无需改动即继续工作，向后兼容。
 *
 * `duration` 的单位是**秒**，且**总是有值**：parseLrc / parseYrc 收尾都会走
 * `finalizeLineDurations` 补一个由相邻行时间差推断的值 —— 这是「无 yrc 也能逐字推进」
 * 的前提（没有它，没有逐字数据的歌就退化成"整行高亮、毫无推进感"）。
 */
export interface ParsedLyricLine {
  time: number;
  text: string;
  /** 本行持续秒数（无逐字数据时用它做行级插值）；由 finalizeLineDurations 保证 > 0 */
  duration?: number;
  /** 逐字数据；仅 yrc/qrc 有。空/缺省 = 无逐字数据，退回行级插值 */
  words?: LyricWord[];
  /** 是否含逐字数据（等价于 words 非空；显式写出便于渲染层直接判定，不必二次求长度） */
  hasKaraoke?: boolean;
  /** 本行的翻译（外语歌的译文；`loadLyrics` 合并 `Lyrics.translation` 时按时间匹配填上，无翻译的歌缺省） */
  translation?: string;
}

/** 解析 LRC 歌词文本 → 带时间戳的行（按时间排序，过滤空行与元信息标签） */
export function parseLrc(lrc: string): ParsedLyricLine[] {
  const lines: ParsedLyricLine[] = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (text) lines.push({ time: min * 60 + sec + ms / 1000, text });
  }
  lines.sort((a, b) => a.time - b.time);
  // ⚠️ LRC **只有行级时间**，没有逐字数据 —— 必须在这里补出行持续时长，
  // 否则「无 yrc 的歌」在渲染层没有可插值的跨度，逐字推进会整体失效。
  return finalizeLineDurations(lines);
}

/**
 * 排序 + 补齐每行 duration + 夹紧到合理区间。
 *
 * ## 为什么必须补 duration（本任务最容易漏、后果最隐蔽的一步）
 * 平台返回的逐字歌词（yrc）是少数派，**绝大多数歌只有行级 LRC 时间戳**。
 * 若 duration 缺失/为 0，渲染层的行级插值就拿不到跨度，只能整行一次点亮 ——
 * 用户看到的效果与「没有逐字高亮」完全一样，而所有断言却都可能全绿
 *（因为代码"看起来"实现了插值）。所以这一函数是「退化路径」的真正支点。
 *
 * 推断规则（参考实现的 finalizeLineDurations）：
 *   · 有下一行且时间更大 → 用「下一行起点 − 本行起点」当作本行时长（最贴近实际唱速）；
 *   · 末行 / 时间并列 → 回落到 4.8s（一个不刺眼的经验值，避免末行瞬间填满）。
 * 夹紧 `[0.45, 12]`：
 *   · 下限 0.45s：太短会让逐字推进"一闪而过"，看不清；
 *   · 上限 12s：太长（常见于末尾长间奏、或两行间隔过大）会让"未唱"部分像卡住。
 * 已是正数的 duration（yrc 自带）**保留原值**，只做夹紧 —— 逐字数据比行距推断更可信。
 */
function finalizeLineDurations(lines: ParsedLyricLine[]): ParsedLyricLine[] {
  lines.sort((a, b) => a.time - b.time);
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const inferred = next && next.time > lines[i].time ? next.time - lines[i].time : 4.8;
    if (!Number.isFinite(lines[i].duration) || (lines[i].duration ?? 0) <= 0) {
      lines[i].duration = inferred;
    }
    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration as number));
  }
  return lines;
}

/**
 * 解析 YRC 逐字歌词。
 *
 * 格式：`[lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)word(wordStartMs,wordDurMs,0)word...`
 *
 * ## 绝对 / 相对时间戳的判定（参考实现同款）
 * 各平台 yrc 的 word 时间戳口径不统一：网易云是**绝对毫秒**，另有平台给的是
 * **相对行头的偏移**。判据：`rawStart >= lineStartMs - 500` 视为绝对，否则视为相对
 *（加上行头）。500ms 的容差用来吸收平台间的毫秒级抖动 —— 相对偏移不可能接近行头
 * 那么大的数值，而绝对时间戳也不会比行头小 500ms 以上（词总在行内）。
 *
 * 产出的行同样走 `finalizeLineDurations`：yrc 自带行时长时保留，仅夹紧；
 * 缺失时才用行距推断 —— 两条路径共用同一个收尾，行为一致。
 */
export function parseYrc(yrc: string): ParsedLyricLine[] {
  if (!yrc || !yrc.trim()) return [];

  const lines: ParsedLyricLine[] = [];

  for (const rawLine of yrc.split(/\r?\n/)) {
    // 行头：[startMs,durMs]
    const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) continue;

    const lineStartMs = parseInt(lineMatch[1], 10) || 0;
    const lineDurMs = parseInt(lineMatch[2], 10) || 0;
    const body = lineMatch[3] || '';

    // 逐词：(startMs,durMs,0)text
    const wordRegex = /\((\d+),(\d+),\d+\)([^()]*)/g;
    const words: LyricWord[] = [];
    let fullText = '';
    let wm: RegExpExecArray | null;

    while ((wm = wordRegex.exec(body)) !== null) {
      const txt = (wm[3] || '').replace(/\s+/g, ' ');
      if (!txt) continue;

      const rawStart = parseInt(wm[1], 10) || 0;
      const rawDur = parseInt(wm[2], 10) || 0;
      // 绝对 / 相对判定，见函数头注释
      const absStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;

      const c0 = fullText.length;
      fullText += txt;
      words.push({
        t: absStartMs / 1000,
        // 下限 0.06s：个别平台会给 0 时长词，直接除会得到除零/瞬时跳帧
        d: Math.max(0.06, rawDur / 1000),
        c0,
        c1: fullText.length,
      });
    }

    // 没匹配到词（纯文本行）时，清掉残留的时间标记再取文本
    if (!fullText) {
      fullText = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    }

    // 逐词拼接可能带来首尾空白；词的字符下标要按**清理后的文本**重新校正，
    // 否则 c0/c1 会整体偏移，高亮落在错误的字上。
    const leading = (fullText.match(/^\s+/) || [''])[0].length;
    fullText = fullText.replace(/\s+/g, ' ').trim();
    if (!fullText) continue;

    let validWords: LyricWord[] | undefined;
    if (words.length) {
      for (const w of words) {
        w.c0 = Math.max(0, Math.min(fullText.length, w.c0 - leading));
        w.c1 = Math.max(w.c0, Math.min(fullText.length, w.c1 - leading));
      }
      const kept = words.filter((w) => w.c1 > w.c0);
      if (kept.length) validWords = kept;
    }

    lines.push({
      time: lineStartMs / 1000,
      text: fullText,
      duration: lineDurMs / 1000,
      words: validWords,
      hasKaraoke: !!validWords,
    });
  }

  return finalizeLineDurations(lines);
}

/**
 * 把翻译 LRC 合并进解析后的歌词行（按时间精确匹配 + 0.5s 容差模糊匹配）。
 *
 * 参考实现 `buildKaraokeLines` 的合并逻辑：翻译 LRC 先解析成 `Map<时间,文本>`，
 * 再对每行按时间匹配。为什么不能按 index 对齐 —— 翻译通常把重复句（副歌）合并成一行，
 * 行数与原文不一致，按 index 会整体错位。0.5s 容差吸收平台间毫秒级抖动。
 */
export function mergeTranslation(lines: ParsedLyricLine[], translationLrc: string): void {
  if (!translationLrc || !translationLrc.trim()) return;
  const transMap = new Map<number, string>();
  for (const line of translationLrc.split('\n')) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
    if (!m) continue;
    const time = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0);
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (text) transMap.set(time, text);
  }
  if (transMap.size === 0) return;
  for (const line of lines) {
    if (transMap.has(line.time)) {
      line.translation = transMap.get(line.time);
      continue;
    }
    let best: string | undefined;
    let bestDiff = Infinity;
    for (const [t, txt] of transMap) {
      const diff = Math.abs(t - line.time);
      if (diff < bestDiff && diff < 0.5) {
        bestDiff = diff;
        best = txt;
      }
    }
    if (best) line.translation = best;
  }
}

/** 根据当前播放秒数定位高亮歌词行索引（-1 表示尚未到第一句） */
export function lyricIndexAt(lines: ParsedLyricLine[], seconds: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= seconds) idx = i;
    else break;
  }
  return idx;
}

