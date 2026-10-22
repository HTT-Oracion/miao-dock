import { Plus, Trash2, X } from 'lucide-react';
import { providerColor } from '@music/platform';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, songKey } from '@music/convert';
import { Empty, IconButton, VirtualList } from '@components/units';
import { SongRow, providerName, relTime } from '@screens/music/shared';

/**
 * 播放历史 —— 跨平台同一条时间线（网易云/酷狗/QQ/咪咕/本地各一条混排）。
 * 每条左侧用平台品牌色圆点做来源标签：品牌色在此只承担「一眼分辨来源」，不参与主题。
 */
export function HistoryView() {
  const history = useMusicStore((s) => s.playHistoryList);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const currentSong = useMusicStore((s) => s.currentSong);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const appendToQueue = useMusicStore((s) => s.appendToQueue);
  const removeEntry = useMusicStore((s) => s.removePlayHistoryEntry);
  const clear = useMusicStore((s) => s.clearPlayHistoryList);

  /*
   * 历史本身就是一份**独立的播放列表**（需求第 6 条）：
   * 点其中一条 = 把整条历史设为队列、并从这一条开始播 —— 这样「下一首/上一首」
   * 才会沿着历史往下走。此前是"单曲播放 + 挂到当前队列"，队列与所点列表无关，
   * 点完下一首会跳到别的歌单的下一首（与用户看到的列表对不上）。
   */
  const historyQueue = history.map((e) => e.song);

  return (
    <div className="music-body">
      {/* 组头（设计稿 `.ms-caption`）：「最近播放」+ 清空（有记录时才出现） */}
      <div className="ms-caption">
        最近播放
        {history.length > 0 ? (
          <button type="button" className="text-btn" title="清空播放历史" onClick={clear}>
            <Trash2 size={11} />
          </button>
        ) : null}
      </div>

      {history.length === 0 ? (
        <Empty sub="播放一首歌之后，这里会留下脚印。">还没有播放记录</Empty>
      ) : (
        <VirtualList
          items={history}
          resetKey="history"
          itemKey={(entry) => `${entry.song.provider}:${entry.song.id}`}
          renderItem={(entry, i) => {
            const s = entry.song;
            // 历史是独立播放列表：整条历史入队，从这一条开始播（见上方 historyQueue 的注释）。
            // `fromHistory` 保留原语义：从历史点播**不**把这条重新置顶，
            // 否则用户正在浏览的列表会在脚下重排（原实现的刻意行为，不因本次改造丢失）。
            const play = () => void playPlaylist(historyQueue, { index: i, fromHistory: true });
            return (
              <SongRow
                song={s}
                cover={coverProxyUrl(s.cover, proxyPort)}
                active={currentSong ? songKey(currentSong) === songKey(s) : false}
                /*
                 * 元信息（设计稿 `.ms-row-meta small`）：**平台色点 + 平台名 + 相对时间**，
                 * 都收在第二行里。此前平台名是一枚独立的 leading 徽标（排在封面之前），
                 * 那一列会把每一行的封面整体右推、与其它列表对不齐 —— 来源是"第二行的事"。
                 */
                meta={
                  <span className="his-meta">
                    <i className="his-dot" style={{ background: providerColor(s.provider) }} />
                    {providerName(s.provider)} · {relTime(entry.playedAt)}
                  </span>
                }
                onClick={play}
                onPlay={play}
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
