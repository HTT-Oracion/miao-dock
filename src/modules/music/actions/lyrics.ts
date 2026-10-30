// 歌词 / 评论切片 —— 「歌词 / 评论」段（D-156 从 store.ts 按 action 段切出）。
import * as ipc from '@music/ipc';
import * as platform from '@music/platform';
import { songKey } from '@music/convert';
import { mergeTranslation, parseLrc, parseYrc } from '@tools/lyrics';
import type { ParsedLyricLine } from '@tools/lyrics';
import type { MusicProvider, Song } from '@music/types';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

export const createLyricsSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'loadLyrics'> => ({
  loadLyrics: async (song) => {
    try {
      let lines: ParsedLyricLine[] = [];
      if (song._localPath) {
        // 本地导入的歌词是磁盘上的 .lrc（行级），没有 yrc → 走 LRC 解析（同样会补 duration）
        const raw = await ipc.getLocalLyric(song._localPath);
        lines = parseLrc(raw);
      } else {
        const l = await platform.lyric(song.provider as MusicProvider, song);
        // 后端（netease/qqmusic 等）**已经返回 yrc 逐字歌词**，但此前只取了 l.lyric，
        // 这正是"有 yrc 却没有逐字高亮"的直接原因。这里改为 yrc 优先：
        //   有 yrc → parseYrc（精确到字）；否则 → parseLrc（行级 + 时间差推断 duration）。
        lines = l.yrc ? parseYrc(l.yrc) : parseLrc(l.lyric || '');
        // 兜底：yrc 字段非空但解析出来是空（格式异常/平台给了空骨架）时退回 LRC，
        // 避免"明明有词却显示暂无歌词"。
        if (l.yrc && lines.length === 0) lines = parseLrc(l.lyric || '');
        // 合并翻译（仅网络歌曲；本地 .lrc 无 translation）—— 后端 netease/qqmusic 已返回
        // `l.translation`，此前被整段丢弃。翻译行数常与原文不一致（重复句被合并），故按时间匹配。
        mergeTranslation(lines, l.translation || '');
      }
      // 只应用当前歌曲的歌词，避免切歌后旧歌词覆盖
      if (get().currentSong && songKey(get().currentSong as Song) !== songKey(song)) return;
      set({ parsedLyrics: lines });
    } catch {
      if (get().currentSong && songKey(get().currentSong as Song) === songKey(song)) set({ parsedLyrics: [] });
    }
    // 歌词是**异步**取回来的：playSong 那次推送发出时 lines 往往还是空的。
    // 这里补推一次，歌词窗才真的显示出词。
    await get().pushLyricsState();
  },
});
