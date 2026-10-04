import { RefreshCw, Sparkles } from 'lucide-react';
import type { WheelEvent } from 'react';
import { capsOf } from '../../music/platform';
import { coverProxyUrl, useMusicStore } from '../../music/store';
import type { Playlist } from '../../music/types';
import { Empty } from '../../components/units';

/**
 * 官方榜单区。两种形态由能力矩阵决定（不在 UI 里写 if(provider===...)）：
 *  · chartGrid  → 3 列网格铺满（酷狗 / QQ）
 *  · 否则        → 横向滚动小卡片（网易云 / 咪咕）
 * 网易云额外在横滚区最前面插一张「每日推荐」入口卡。
 *
 * 横滚区有一个刻意还原的交互：容器纵向 overflow 为 hidden，鼠标滚轮（deltaY）转成 scrollLeft，
 * 否则在这一条横向卡片上滚轮什么也不会发生，用户只能去拖滚动条。
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
  // chartByName（咪咕）：无可用封面 → 不摆空图，直接把榜单名写在主题色渐变卡上（多行居中）
  if (byName) {
    return (
      <div className="music-chart is-name" title={pl.name} onClick={onOpen}>
        <div className="music-chart-name">{pl.name}</div>
      </div>
    );
  }
  const cover = coverProxyUrl(pl.cover, proxyPort);
  return (
    <div className="music-chart" title={pl.name} onClick={onOpen}>
      <div className="music-chart-cv">
        {cover ? <img src={cover} alt="" loading="lazy" /> : pl.name.slice(0, 1)}
      </div>
      <span>{pl.name}</span>
    </div>
  );
}

export function Charts() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const charts = useMusicStore((s) => s.officialCharts);
  const loading = useMusicStore((s) => s.loadingCharts);
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
    <div className="music-sec">
      <div className="music-card-hd">
        <span className="music-card-title">官方榜单</span>
        <div className="grow" />
        <button type="button" className="music-btn out" disabled={loading} onClick={() => void loadCharts()}>
          <RefreshCw size={12} /> {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {charts.length === 0 && !caps.dailySongs ? (
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
