import { Plus, Trash2, X } from 'lucide-react';
import { providerColor } from '../../music/platform';
import { coverProxyUrl, songKey, useMusicStore } from '../../music/store';
import { Empty, IconButton, VirtualList } from '../../components/units';
import { SongRow, providerName, relTime } from './shared';

/**
 * 播放历史 —— 跨平台同一条时间线（网易云/酷狗/QQ/咪咕/本地各一条混排）。
 * 每条左侧用平台品牌色圆点做来源标签：品牌色在此只承担「一眼分辨来源」，不参与主题。
 */
export function HistoryView() {
  const history = useMusicStore((s) => s.playHistoryList);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const currentSong = useMusicStore((s) => s.currentSong);
  const playSong = useMusicStore((s) => s.playSong);
  const appendToQueue = useMusicStore((s) => s.appendToQueue);
  const removeEntry = useMusicStore((s) => s.removePlayHistoryEntry);
  const clear = useMusicStore((s) => s.clearPlayHistoryList);

  return (
    <div className="music-body">
      <div className="music-card-hd">
        <span className="music-card-sub">{history.length} 条 · 跨平台</span>
        <div className="grow" />
        {history.length > 0 ? (
          <button type="button" className="music-btn out" onClick={clear}>
            <Trash2 size={12} /> 清空
          </button>
        ) : null}
      </div>

      {history.length === 0 ? (
        <Empty>还没有播放记录 —— 播一首歌就会记在这里（跨平台同一条时间线）。</Empty>
      ) : (
        <VirtualList
          items={history}
          resetKey="history"
          itemKey={(entry) => `${entry.song.provider}:${entry.song.id}`}
          renderItem={(entry) => {
            const s = entry.song;
            return (
              <SongRow
                song={s}
                cover={coverProxyUrl(s.cover, proxyPort)}
                active={currentSong ? songKey(currentSong) === songKey(s) : false}
                // 来源标签：圆点取平台品牌色 + 平台名，避免只靠颜色传达信息
                leading={
                  <span className="his-src">
                    <i className="his-dot" style={{ background: providerColor(s.provider) }} />
                    {providerName(s.provider)}
                  </span>
                }
                meta={`${s.artist} · ${relTime(entry.playedAt)}`}
                onClick={() => void playSong(s, undefined, { fromHistory: true })}
                actions={
                  <>
                    <IconButton
                      title="加入队列"
                      onClick={(e) => {
                        e.stopPropagation();
                        appendToQueue([s]);
                      }}
                    >
                      <Plus size={13} />
                    </IconButton>
                    <IconButton
                      title="从历史移除"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeEntry(s.provider, s.id);
                      }}
                    >
                      <X size={13} />
                    </IconButton>
                  </>
                }
              />
            );
          }}
        />
      )}
    </div>
  );
}
