import type { ReactNode } from 'react';
import { fmtTime } from '../../music/store';
import { providerLabel } from '../../music/platform';
import type { Song } from '../../music/types';

/**
 * 音乐屏共享小组件 —— 只放**音乐语义**的东西。
 *
 * 分界线（《09》§2.2）：凡是与 `Song` / 平台概念绑定的，留在这里；
 * 与音乐无关的通用件（`IconButton` / `Empty` / `useEsc`）已移到
 * `components/units/`，需要时从那里引 —— 不要让"音乐屏共享件"重新长成杂物间。
 */

/**
 * 相对时间（播放历史时间线）。
 * 为什么不用库里现成的：设计稿只要求「12 分钟前」这一档中文粒度，
 * 引一个 i18n/日期库只为这一处不划算；超过一个月退回具体日期，避免「37 天前」这种读不出远近的表述。
 */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 平台展示名：providerLabel 不认本地来源（'local'），这里补一个中文名，避免界面出现英文 "local" */
export function providerName(p: string): string {
  return p === 'local' ? '本地' : providerLabel(p);
}

/** 封面块（无封面时留一块主题渐变占位，不塌陷） */
export function Cover({ url, className }: { url: string; className?: string }) {
  return (
    <div className={className ? `music-cover ${className}` : 'music-cover'}>
      {url ? <img src={url} alt="" loading="lazy" /> : null}
    </div>
  );
}

/**
 * 通用歌曲行（音乐语义 —— 参数是 `Song`，所以留在这里而不是 units）。
 * leading 给「序号 / 平台来源点」；meta 覆盖副标题（默认歌手）；actions 放右侧操作按钮，
 * 由调用方在小按钮上自行 stopPropagation —— 这里不替调用方假设哪些点击要冒泡。
 */
export function SongRow({
  song,
  cover,
  active,
  leading,
  meta,
  actions,
  onClick,
  showCover = true,
  duration,
}: {
  song: Song;
  cover?: string;
  active?: boolean;
  leading?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  showCover?: boolean;
  duration?: number;
}) {
  // Song.duration 的单位是**毫秒**（与 Rust models.rs 的契约一致），不要再乘 1000
  const durMs = duration ?? song.duration;
  return (
    <div className={active ? 'music-row is-hot' : 'music-row'} onClick={onClick}>
      {leading}
      {showCover ? <Cover url={cover ?? ''} /> : null}
      <div className="music-row-tx">
        <b>{song.name}</b>
        <span>{meta ?? song.artist}</span>
      </div>
      {durMs ? <span className="music-dur">{fmtTime(durMs)}</span> : null}
      {actions ? <div className="music-row-act">{actions}</div> : null}
    </div>
  );
}
