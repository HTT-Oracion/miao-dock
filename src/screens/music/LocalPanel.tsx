import { open } from '@tauri-apps/plugin-dialog';
import { FolderPlus, Upload } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { songKey } from '@music/convert';
import { Btn, Empty, Notice, VirtualList } from '@components/units';
import { SongRow } from '@screens/music/shared';

/** 与 Rust 侧解析器支持的扩展名保持一致（多列无害，选不中会被后端忽略） */
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma', 'aiff', 'ape'];

/**
 * 右侧「本地音乐」主体（设计稿 `renderLocal()`）。
 *
 * 设计稿把本地曲库放在**右侧主体**，左栏只留一个「本地」页签作为入口 ——
 * 因为「本地」是一个**视图**（有表头、有导入动作、有说明），不是左栏里的一小段列表。
 *
 * 结构照设计稿三件：
 *   ① `.search-result-head`：标题「本地音乐」+ 「N 首 · 只保存在本机，不计入缓存」+ 右侧动作组；
 *   ② 有歌 → `.song-table`；没歌 → 带插画的空态（主行动是「选择文件」）；
 *   ③ 底部 `.notice`：说明"只记录路径、不复制到缓存"。
 */
export function LocalPanel() {
  const localSongs = useMusicStore((s) => s.localSongs);
  const localQueue = useMusicStore((s) => s.localQueue);
  const importing = useMusicStore((s) => s.importingLocal);
  const importLocal = useMusicStore((s) => s.importLocal);
  const importFolder = useMusicStore((s) => s.importFolder);
  const clearLocalSongs = useMusicStore((s) => s.clearLocalSongs);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const currentSong = useMusicStore((s) => s.currentSong);

  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [{ name: '音频', extensions: AUDIO_EXT }],
    });
    if (Array.isArray(picked) && picked.length > 0) await importLocal(picked);
  };

  const pickFolder = async () => {
    const picked = await open({ multiple: false, directory: true });
    if (typeof picked === 'string') await importFolder(picked);
  };

  return (
    <>
      <div className="search-result-head">
        <div>
          <h2>本地音乐</h2>
          <p>{localSongs.length} 首 · 只保存在本机，不计入缓存</p>
        </div>
        <div className="local-actions">
          <Btn kind="ghost" size="sm" disabled={importing} onClick={() => void pickFiles()}>
            <Upload size={12} /> 选择文件
          </Btn>
          <Btn kind="ghost" size="sm" disabled={importing} onClick={() => void pickFolder()}>
            <FolderPlus size={12} /> 选择文件夹
          </Btn>
          {localSongs.length ? (
            <Btn kind="text" size="sm" onClick={() => clearLocalSongs()}>
              清空
            </Btn>
          ) : null}
        </div>
      </div>

      {localSongs.length ? (
        <div className="song-table">
          <div className="song-head" aria-hidden="true">
            <span>#</span>
            <span>歌曲</span>
            <span>文件</span>
            <span>时长</span>
            <span />
          </div>
          <VirtualList
            items={localSongs}
            resetKey="local-panel"
            itemKey={(info) => info.id}
            renderItem={(_info, i) => {
              const song = localQueue[i];
              if (!song) return null; // 同序等长；不同步时跳过而不是崩
              const play = () => void playPlaylist(localQueue, { index: i });
              return (
                <SongRow
                  song={song}
                  cover={song.cover}
                  active={currentSong ? songKey(currentSong) === songKey(song) : false}
                  leading={<span className="song-index">{i + 1}</span>}
                  meta={<span className="song-album">{song.album || '—'}</span>}
                  onClick={play}
                  onPlay={play}
                />
              );
            }}
          />
        </div>
      ) : (
        <Empty
          art
          sub="把 MP3 / FLAC / WAV 拖进来，或者选择文件夹批量导入。"
          actions={
            <Btn kind="primary" size="sm" disabled={importing} onClick={() => void pickFiles()}>
              <Upload size={12} /> 选择文件
            </Btn>
          }
        >
          还没有本地音乐
        </Empty>
      )}

      <Notice className="local-note">本地文件只记录路径，不会复制到音乐缓存；删除文件需要你自己在系统里操作。</Notice>
    </>
  );
}
