import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { songKey } from '@music/convert';
import { Btn, Empty, IconButton, VirtualList } from '@components/units';
import { SongRow } from '@screens/music/shared';

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
    <div className="music-body">
      {/* 组头（设计稿 `.ms-caption`）：小节名 + 一枚导入按钮；导入与清空分两处，不再挤一行 */}
      <div className="ms-caption">
        本地音乐
        <Btn
          kind="bare"
          className="text-btn"
          ariaLabel="导入文件"
          disabled={importing}
          title="导入文件"
          onClick={() => void pickFiles()}
        >
          <FolderOpen size={11} />
        </Btn>
        <Btn
          kind="bare"
          className="text-btn"
          ariaLabel="导入文件夹"
          disabled={importing}
          title="导入文件夹"
          onClick={() => void pickFolder()}
        >
          <FolderPlus size={11} />
        </Btn>
        {localSongs.length > 0 ? (
          <Btn kind="bare" className="text-btn" ariaLabel="清空本地音乐" title="清空本地音乐" onClick={clearLocalSongs}>
            <Trash2 size={11} />
          </Btn>
        ) : null}
      </div>

      {importing ? (
        <Empty>正在导入本地音乐…</Empty>
      ) : localSongs.length === 0 ? (
        <Empty sub="把 MP3 / FLAC / WAV 拖进来，或者选择文件夹批量导入。">还没有本地音乐</Empty>
      ) : (
        <VirtualList
          items={localSongs}
          resetKey="local"
          itemKey={(info) => info.id}
          renderItem={(info, i) => {
            const s = localQueue[i];
            if (!s) return null; // 理论上同序等长；不同步时跳过而不是崩
            // 本地曲库本身就是一个**独立的播放列表**（需求第 6 条）：整份本地列表设为队列，
            // 并从点中的这一首开始。走 playPlaylist 而非 playQueue，是为了让"切换列表"
            // 的联动（离开心动模式要切回顺序播放）在这里也生效。
            const play = () => void playPlaylist(localQueue, { index: i });
            return (
              <SongRow
                song={s}
                cover={s.cover}
                active={currentSong ? songKey(currentSong) === songKey(s) : false}
                onClick={play}
                onPlay={play}
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
