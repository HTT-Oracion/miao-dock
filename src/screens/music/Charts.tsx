import { RefreshCw, Sparkles } from 'lucide-react';
import type { WheelEvent } from 'react';
import { capsOf } from '@music/platform';
import { useMusicStore } from '@music/store';
import { coverProxyUrl } from '@music/convert';
import type { Playlist } from '@music/types';
import { Btn, Empty } from '@components/units';

/**
 * 官方榜单区。两种形态由能力矩阵决定（不在 UI 里写 if(provider===...)）：
 *  · chartGrid  → 3 列网格铺满（酷狗 / QQ）
 *  · 否则        → 横向滚动小卡片（网易云 / 咪咕）
 * 网易云额外在横滚区最前面插一张「每日推荐」入口卡。
 *
 * 横滚区有一个刻意还原的交互：容器纵向 overflow 为 hidden，鼠标滚轮（deltaY）转成 scrollLeft，
 * 否则在这一条横向卡片上滚轮什么也不会发生，用户只能去拖滚动条。
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
  // chartByName（咪咕）：无可用封面 → 不摆空图，直接把榜单名写在主题色渐变卡上（多行居中）
  if (byName) {
    return (
      <div className="music-chart is-name" title={name} onClick={onOpen}>
        <div className="music-chart-name">{name}</div>
      </div>
    );
  }
  const cover = coverProxyUrl(pl.cover, proxyPort);
  return (
    <div className="music-chart" title={name} onClick={onOpen}>
      <div className="music-chart-cv">{cover ? <img src={cover} alt="" loading="lazy" /> : Array.from(name)[0]}</div>
      <span>{name}</span>
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
  const openRightChart = useMusicStore((s) => s.openRightChart);
  const setRightView = useMusicStore((s) => s.setRightView);

  const caps = capsOf(playbackSource);
  if (!caps.charts) return null;

  const grid = caps.chartGrid;
  // 滚轮 → 横向滚动（grid 形态不套用：网格本身纵向排布，没有横轴）
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.currentTarget.scrollLeft += e.deltaY;
  };

  return (
    <div className="mc-section">
      <div className="mc-section-head">
        <span className="music-card-title">官方榜单</span>
        {/* 副标题按设计稿：说清"这些榜单是从哪来的" */}
        <span className="music-card-sub">来自四个平台的每日榜单</span>
        <div className="grow" />
        <Btn kind="bare" className="music-btn out" disabled={loading} onClick={() => void loadCharts()}>
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
      ) : charts.length === 0 && !caps.dailySongs ? (
        <Empty inline>{loading ? '加载榜单中…' : '暂无榜单'}</Empty>
      ) : (
        <div className={grid ? 'music-charts is-grid' : 'music-charts'} onWheel={grid ? undefined : onWheel}>
          {caps.dailySongs ? (
            <div className="music-chart is-daily" title="每日推荐" onClick={() => setRightView('daily')}>
              <div className="music-chart-cv is-daily">
                <Sparkles size={20} />
              </div>
              <span>每日推荐</span>
            </div>
          ) : null}
          {charts.map((pl) => (
            <ChartCard
              key={pl.id}
              pl={pl}
              byName={caps.chartByName}
              proxyPort={proxyPort}
              onOpen={() => void openRightChart(pl)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
