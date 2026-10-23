import { Skeleton } from '@components/units/Skeleton';

/**
 * 骨架屏（音乐域）—— **形状与真实组件一一对应**。
 *
 * ## 为什么形状要对齐
 * 骨架屏的全部价值是"加载完成时布局不跳"。形状对不上（行数不同、封面大小不同、
 * 少一列文字），加载完成那一帧就会整块位移 —— 那比转圈更糟。
 * 所以每个骨架的每一块都取自**真实组件的实测尺寸**。
 *
 * ## 尺寸来源（真机实测，1600 宽窗口）
 * - 榜单卡 `.chart-card` 419×167（pad 15/16 · r16）；卡头 385×25；
 *   封面 `.chart-art` 100×100（r16）；3 行排行各 273×19。
 * - 推荐歌单卡 `.playlist-card` 203×247（pad 9 · r16）；封面 1:1 铺满卡宽。
 * - 曲目行：序号 + 38 封面 + 标题/歌手两行 + 专辑 + 时长。
 *
 * 这些是**基准值**（未乘 `--ui-scale` 的那一份口径）；实际渲染由 CSS 的
 * `aspect-ratio` / `flex` 决定，跟着卡宽走，窗口变宽时骨架与内容一起伸缩。
 */

/**
 * 一张榜单卡的骨架：左封面 + 右侧三行排行。
 *
 * ## 三行的长度：最长 → 最短 → 第二长
 * 骨架屏看起来"像不像真的"，靠的就是**每行长短不一** ——
 * 三条等长的灰条读起来像一张表格被清空了，而长短参差才像"几行文字"。
 *
 * ## 为什么保留真实卡的两栏结构
 * 真实卡是"左封面 / 右排行"两栏。若骨架改成上下排列，卡会从 207 高缩回真实的 164 高，
 * 加载完成那一帧整张卡会"塌"一下 —— 骨架屏的第一要务是不跳版。
 */
export function ChartCardSkeleton() {
  return (
    <div className="chart-card is-skel" aria-hidden="true">
      <div className="chart-body is-centered">
        <Skeleton height={100} width={100} radius={16} className="chart-skel-art" />
        <div className="chart-rows is-centered">
          {/* 最长 → 最短 → 第二长 */}
          {(['82%', '46%', '66%'] as const).map((w, i) => (
            /*
             * 条不能直接放在 .chart-row（flex 容器）里用百分比宽度 ——
             * flex 子项的百分比宽度会按剩余空间再收缩，实测塌成 0 宽
             *（只剩 10px 高的一条竖线，视觉上就是三个「点」）。
             * 所以外面套一层普通块，百分比宽度按它算。
             */
            <div className="chart-skel-bar" key={i}>
              <Skeleton height={10} width={w} radius={5} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 榜单区的骨架：4 组（两列两行） */
export function ChartGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="chart-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <ChartCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * 一张推荐歌单卡的骨架：封面 + 歌名 + 一行说明。
 *
 * 文字块的**行高必须与真实一致**（实测：歌名行 16px、次行 15px、间距 1px）——
 * 骨架的灰条比真实文字矮，加载完成那一帧卡片会长高一截。
 */
export function PlaylistCardSkeleton() {
  return (
    <div className="playlist-card is-skel" aria-hidden="true">
      {/*
       * 封面占位：**不传 height**，由 CSS 的 `aspect-ratio: 1` 决定（与真实
       * `.playlist-card-cv` 同规则）—— 卡片多宽，封面就多高。
       * 传 `height={0}` 会把内联高度写死，aspect-ratio 就被覆盖成 0 了。
       */}
      <Skeleton height="auto" width="100%" className="playlist-skel-cv" />
      <Skeleton height={16} width="78%" radius={5} className="playlist-skel-name" />
    </div>
  );
}

/** 推荐歌单区的骨架：6 组 */
export function PlaylistGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="card-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <PlaylistCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * 曲目表的骨架：一行 = 序号 + 封面 + 标题 + 歌手 + 时长。
 * 行高与真实行一致（`.song-table .music-row` 的 10px 上下内距 + 内容）。
 */
export function SongTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="song-table is-skel" aria-hidden="true">
      <div className="song-head" aria-hidden="true">
        <span />
        <span>歌曲</span>
        <span>专辑</span>
        <span>时长</span>
        <span />
      </div>
      <div className="song-skel-rows">
        {Array.from({ length: rows }, (_, i) => (
          <div className="song-skel-row" key={i}>
            <Skeleton height={9} width={10} radius={3} className="song-skel-no" />
            <Skeleton height={38} width={38} radius={9} className="song-skel-cv" />
            <div className="song-skel-tx">
              <Skeleton height={11} width={i % 3 === 2 ? '52%' : '70%'} radius={5} />
              <Skeleton height={9} width={i % 3 === 2 ? '38%' : '48%'} radius={5} />
            </div>
            <Skeleton height={9} width={i % 2 ? '40%' : '58%'} radius={5} className="song-skel-album" />
            <Skeleton height={10} width={30} radius={5} className="song-skel-dur" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 左栏「我的歌单」列表的骨架：几行"封面 + 标题 + 说明"。
 * 与真实行同形（`.ms-group .music-row`：32 封面 + 两行文字）。
 */
export function PlaylistListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="ms-skel-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="ms-skel-row" key={i}>
          <Skeleton height={32} width={32} radius={9} />
          <div className="ms-skel-tx">
            <Skeleton height={10} width={i % 3 === 2 ? '52%' : '72%'} radius={5} />
            <Skeleton height={9} width={i % 2 ? '34%' : '44%'} radius={5} />
          </div>
        </div>
      ))}
    </div>
  );
}
