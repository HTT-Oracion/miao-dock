import { RefreshCw } from 'lucide-react';
import { capsOf } from '@music/platform';
import { useMusicStore } from '@music/store';
import { coverProxyUrl } from '@music/convert';
import type { Playlist } from '@music/types';
import { Btn, Empty } from '@components/units';

/**
 * 官方榜单区（设计稿 `.mc-section` + `.chart-grid` + `.chart-card`）。
 *
 * 形态：**四列网格**，每张卡 = 卡头（封面 + 榜单名）+ **前 5 名排行**（序号 / 歌名 / 歌手）。
 * 这是"直接铺排行"而不是"榜单入口列表" —— 设计稿的首页要让用户一眼看出各榜在流行什么，
 * 点卡片才进完整榜单。
 *
 * 两种能力档仍由能力矩阵决定（不在 UI 里写 if(provider===...)）：
 *  · `chartByName`（咪咕）→ 没有可用封面，卡头改用主题色底 + 榜单名；
 *  · 其余平台 → 有封面就用封面。
 * 排行数据来自 `loadCharts` 为每个榜单并发取的 `preview`（见 actions/right.ts 的 withPreview）。
 */

/**
 * 榜单卡的展示名。
 *
 * 为什么要有兜底：榜单条目来自平台接口，`name` 在个别平台的个别条目上可能缺失
 * （接口字段改名 / 空榜单占位）。原写法 `pl.name.slice(0, 1)` 会在 `name` 缺失时
 * 抛异常、把**整个音乐屏**打空 —— 一条脏数据不该有这么大的爆炸半径。
 */
function chartName(pl: Playlist): string {
  const raw = typeof pl?.name === 'string' ? pl.name.trim() : '';
  return raw || '未命名榜单';
}

/**
 * 一张榜单卡（设计稿 `.chart-card`）：卡头（封面 + 榜单名）+ 前 5 名排行。
 *
 * 排行三列：序号（`i`）/ 歌名（`b`，占满）/ 歌手（`em`，右端）。
 * 设计稿的 `chart-head` 右侧还有一枚刷新图标 —— 那是"这张榜单可以单独刷新"的暗示，
 * 但产品没有单榜刷新接口，所以**不放**一个点了没反应的图标（假控件比缺控件更伤）。
 */
function ChartCard({
  pl,
  byName,
  proxyPort,
  onOpen,
}: {
  pl: Playlist;
  byName: boolean;
  proxyPort: number;
  onOpen: () => void;
}) {
  const name = chartName(pl);
  const cover = byName ? '' : coverProxyUrl(pl.cover, proxyPort);
  const rows = pl.preview ?? [];
  return (
    <div
      className="chart-card"
      role="button"
      tabIndex={0}
      title={`打开「${name}」`}
      onClick={onOpen}
      onKeyDown={(e) => {
        // 键盘可达：设计稿给的是 role=button + 回车/空格触发
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="chart-head">
        {cover ? (
          <span className="chart-head-cv">
            <img src={cover} alt="" loading="lazy" />
          </span>
        ) : (
          <span className="chart-head-cv is-name">{Array.from(name)[0]}</span>
        )}
        <strong>{name}</strong>
      </div>
      {rows.map((r, i) => (
        <div className="chart-row" key={`${r.title}-${i}`}>
          <i>{i + 1}</i>
          <b>{r.title}</b>
          <em>{r.artist}</em>
        </div>
      ))}
    </div>
  );
}

export function Charts() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const charts = useMusicStore((s) => s.officialCharts);
  const loading = useMusicStore((s) => s.loadingCharts);
  const error = useMusicStore((s) => s.chartsError);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const loadCharts = useMusicStore((s) => s.loadCharts);
  const openLeftPlaylist = useMusicStore((s) => s.openLeftPlaylist);

  const caps = capsOf(playbackSource);
  if (!caps.charts) return null;

  return (
    <div className="mc-section">
      <div className="mc-section-head">
        <span className="music-card-title">官方榜单</span>
        {/* 副标题按设计稿：说清"这些榜单是从哪来的" */}
        <span className="music-card-sub">来自四个平台的每日榜单</span>
        <div className="grow" />
        <Btn kind="bare" className="link-btn" disabled={loading} onClick={() => void loadCharts()}>
          <RefreshCw size={12} /> {loading ? '刷新中…' : '刷新'}
        </Btn>
      </div>

      {/*
        读取失败**先于**「有没有内容」判断：旧条件里带了 `!caps.dailySongs`，
        而网易云有每日推荐 ⇒ 那支错误分支在默认平台上根本到不了（死代码）。
        失败就是失败，与"这个平台有没有每日推荐"无关。
      */}
      {error ? (
        <Empty bad inline sub={`${error}（点右上「刷新」重试）`}>
          榜单读取失败
        </Empty>
      ) : charts.length === 0 ? (
        <Empty inline>{loading ? '加载榜单中…' : '暂无榜单'}</Empty>
      ) : (
        <div className="chart-grid">
          {charts.map((pl) => (
            // 榜单点开与歌单点开**同一个详情组件**（`PlaylistDetail`）——
            // 设计稿里两者是同一个视图，只是数据来源不同（见 `openLeftPlaylist`）。
            // 此前榜单走 `openRightChart` 渲染另一个 `RightTracksView`，
            // 于是同一个"详情"有两套代码、两套样式，改一处漏一处。
            <ChartCard
              key={pl.id}
              pl={pl}
              byName={caps.chartByName}
              proxyPort={proxyPort}
              onOpen={() => void openLeftPlaylist(pl)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
