import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import { songKey, useMusicStore } from '../../music/store';
import { Empty, IconButton, VirtualList } from '../../components/units';
import { SongRow } from './shared';

/** 与 Rust 侧解析器支持的扩展名保持一致（多列无害，选不中会被后端忽略） */
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma', 'aiff', 'ape'];

/**
 * 本地曲库视图。
 * 文件/文件夹选择走 @tauri-apps/plugin-dialog 的 open()，与 DropScreen 同一套用法。
 * localSongs 与 localQueue 在 store 里同序生成，故按下标即可取到可播放的统一 Song。
 */
export function LocalView() {
  const localSongs = useMusicStore((s) => s.localSongs);
  const localQueue = useMusicStore((s) => s.localQueue);
  const importing = useMusicStore((s) => s.importingLocal);
  const importLocal = useMusicStore((s) => s.importLocal);
  const importFolder = useMusicStore((s) => s.importFolder);
  const removeLocalSong = useMusicStore((s) => s.removeLocalSong);
  const clearLocalSongs = useMusicStore((s) => s.clearLocalSongs);
  const playQueue = useMusicStore((s) => s.playQueue);
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
    <div className="music-body">
      <div className="music-card-hd">
        <span className="music-card-sub">{localSongs.length} 首</span>
        <div className="grow" />
        <button type="button" className="music-btn pri" disabled={importing} onClick={() => void pickFiles()}>
          <FolderOpen size={12} /> 选择文件
        </button>
        <button type="button" className="music-btn out" disabled={importing} onClick={() => void pickFolder()}>
          <FolderPlus size={12} /> 选择文件夹
        </button>
        {localSongs.length > 0 ? (
          <button type="button" className="music-btn out" onClick={clearLocalSongs}>
            <Trash2 size={12} /> 清空
          </button>
        ) : null}
      </div>

      {importing ? (
        <Empty>正在导入本地音乐…</Empty>
      ) : localSongs.length === 0 ? (
        <Empty>还没有本地歌曲 —— 点「选择文件」选几首 mp3/flac，或「选择文件夹」整夹导入。</Empty>
      ) : (
        <VirtualList
          items={localSongs}
          resetKey="local"
          itemKey={(info) => info.id}
          renderItem={(info, i) => {
            const s = localQueue[i];
            if (!s) return null; // 理论上同序等长；不同步时跳过而不是崩
            return (
              <SongRow
                song={s}
                cover={s.cover}
                active={currentSong ? songKey(currentSong) === songKey(s) : false}
                onClick={() => void playQueue(localQueue, i)}
                actions={
                  <IconButton
                    title="从本地曲库移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeLocalSong(info.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                }
              />
            );
          }}
        />
      )}
    </div>
  );
}
