import { Trash2 } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { songKey } from '@music/convert';
import { Empty, IconButton, VirtualList } from '@components/units';
import { SongRow } from '@screens/music/shared';

/**
 * 本地曲库视图。
 * 文件/文件夹选择走 @tauri-apps/plugin-dialog 的 open()，与 DropScreen 同一套用法。
 * localSongs 与 localQueue 在 store 里同序生成，故按下标即可取到可播放的统一 Song。
 */
export function LocalView() {
  const localSongs = useMusicStore((s) => s.localSongs);
  const localQueue = useMusicStore((s) => s.localQueue);
  const importing = useMusicStore((s) => s.importingLocal);
  const removeLocalSong = useMusicStore((s) => s.removeLocalSong);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const currentSong = useMusicStore((s) => s.currentSong);

  return (
    <div className="music-body">
      {/*
       * 组头（设计稿 `.ms-caption`）：**只有小节名，没有按钮**。
       *
       * 设计稿的 `.ms-caption` 就是一行小标签。导入动作在右侧「本地音乐」视图里
       * （`LocalPanel` 的「选择文件 / 选择文件夹」），左栏这一组只是导航 ——
       * 两处都放导入按钮，等于同一个动作有两个入口，且左栏这一组会被按钮挤窄。
       */}
      <div className="ms-caption">本地音乐</div>

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
