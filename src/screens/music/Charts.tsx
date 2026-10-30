import { RefreshCw } from 'lucide-react';
import { capsOf } from '@music/platform';
import { useMusicStore } from '@music/store';
import { coverProxyUrl } from '@music/convert';
import type { Playlist } from '@music/types';
import { Btn, Empty } from '@components/units';
import { ChartGridSkeleton } from '@screens/music/skeletons';

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
 * 一张榜单卡：卡头（榜名 + 可选的更新说明）→ 正文两栏（大封面 + 前 3 名排行）。
 *
 * ## 正文为什么是"大封面 + 3 行"两栏
 * 封面是榜单的**面孔**（一眼认出这是哪个榜），给它 100px 的整块而不是 22px 的小图，
 * 卡片才有"这是一张专辑/榜单"的重量；右侧 3 行是"它现在在流行什么"的摘要。
 * 行进详情后有完整曲目，所以这里 3 行足够（再多会把卡片撑高、挤掉同排的另一张卡）。
 *
 * ## 行是"序号 歌名 - 歌手"单行横排
 * 两行式（歌名在上、歌手在下）在 380px 宽的卡里会让 3 行占掉近一半高度，
 * 且歌手被压成第二行的小字后几乎读不到。单行横排 + 省略号更适合"摘要"这一层。
 *
 * ## 升降标 / 更新频率：**拿不到就不显示**
 * 平台接口没有返回升降数据（`lastRank` 之类）与更新频率文案，
 * 与其编一个假的变化，不如**不显示** —— 假控件比缺控件更伤。
 * 等接口有了这两个字段，直接在这里渲染即可（数据驱动的两种可选形态）。
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
  const rows = (pl.preview ?? []).slice(0, 3);
  const update = pl.updateFrequency;
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
        <strong>{name}</strong>
        {update ? <span className="chart-update">{update}</span> : null}
      </div>

      <div className="chart-body">
        {/* 封面：有图用图，没图退回榜名首字（与歌曲封面同一套降级） */}
        <span className="chart-art" aria-hidden="true">
          {cover ? <img src={cover} alt="" loading="lazy" /> : Array.from(name)[0]}
        </span>
        <div className="chart-rows">
          {rows.map((r, i) => (
            <div className="chart-row" key={`${r.title}-${i}`}>
              <i>{i + 1}</i>
              <b>{r.title}</b>
              <span className="chart-sep">-</span>
              <em>{r.artist}</em>
            </div>
          ))}
        </div>
      </div>
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
      ) : loading ? (
        /* 加载中：4 组榜单卡骨架（形状与真实榜单卡一致） */
        <ChartGridSkeleton count={4} />
      ) : charts.length === 0 ? (
        <Empty inline>暂无榜单</Empty>
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
