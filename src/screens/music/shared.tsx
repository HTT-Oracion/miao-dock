import { useState } from 'react';
import type { ReactNode } from 'react';
import { ListEnd, Play } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { fmtTime } from '@music/convert';
import { providerLabel } from '@music/platform';
import type { Song } from '@music/types';
import { ContextMenu, MenuItem } from '@components/units';

/**
 * 音乐屏共享小组件 —— 只放**音乐语义**的东西。
 *
 * 分界线（《09》§2.2）：凡是与 `Song` / 平台概念绑定的，留在这里；
 * 与音乐无关的通用件（`IconButton` / `Empty`）从 `@components/units` 引，
 * 通用 hook（`useEsc`）从 `@hooks/useEsc` 引 —— 不要让"音乐屏共享件"重新长成杂物间。
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
 *
 * ## `onPlay` 为什么与 `onClick` 分开给（而不是让右键菜单直接复用 onClick）
 * 两个参数**通常指向同一个回调**，但语义不同：`onClick` 是"左键点这一行"，
 * `onPlay` 是"菜单里选播放"。分开的意义在于——宿主不传 `onPlay` 时，
 * 菜单要退回 `playSong(song)`，而不是去猜行点击的语义（有些列表的行点击是下钻，
 * 比如歌单行点击=打开歌单，那时候 onPlay 就绝不能等于 onClick）。
 * 所以这里只做一件事：宿主给了就原样用，没给就走兜底。
 */
export function SongRow({
  song,
  cover,
  active,
  leading,
  meta,
  aside,
  actions,
  onClick,
  onPlay,
  showCover = true,
  duration,
}: {
  song: Song;
  cover?: string;
  active?: boolean;
  leading?: ReactNode;
  meta?: ReactNode;
  /** 附加列（设计稿 `.song-album`）：曲目表里的"专辑"列，与副标题行的歌手是两处内容 */
  aside?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  onPlay?: () => void;
  showCover?: boolean;
  duration?: number;
}) {
  const playSong = useMusicStore((s) => s.playSong);
  const playNext = useMusicStore((s) => s.playNext);
  // 一行一个菜单实例：开关 / 定位 / 关闭时机全交给通用单元 ContextMenu，行只负责"什么时候开"
  const [menu, setMenu] = useState<{ x: number; y: number; song: Song; onPlay?: () => void } | null>(null);
  // Song.duration 的单位是**毫秒**（与 Rust models.rs 的契约一致），不要再乘 1000
  const durMs = duration ?? song.duration;
  return (
    <div
      className={active ? 'music-row is-hot' : 'music-row'}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault(); // 关掉系统右键菜单，否则两层菜单叠在一起
        setMenu({ x: e.clientX, y: e.clientY, song, onPlay });
      }}
    >
      {leading}
      {showCover ? <Cover url={cover ?? ''} /> : null}
      <div className="music-row-tx">
        <b>{song.name}</b>
        {/* 副标题行默认给**歌手**（设计稿 `.song-tx small`）—— 不给 meta 时就是它 */}
        <span>{meta ?? song.artist}</span>
      </div>
      {/* 附加列（设计稿 `.song-album`）：曲目表里的"专辑"列。
          它与副标题行是**两处不同内容**：副标题永远是歌手，这一列才放专辑。 */}
      {aside}
      {durMs ? <span className="music-dur">{fmtTime(durMs)}</span> : null}
      {actions ? <div className="music-row-act">{actions}</div> : null}
      {/* 菜单 portal 到 body（列表是滚动容器，挂在行内会被裁掉） */}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(close) => (
            <>
              <MenuItem
                icon={<Play size={13} />}
                label="播放"
                onClick={() => {
                  close(); // 先关再执行：动作里可能弹 toast / 换视图，留着菜单会挡住
                  if (menu.onPlay) menu.onPlay();
                  else void playSong(menu.song);
                }}
              />
              <MenuItem
                icon={<ListEnd size={13} />}
                label="下一首播放"
                onClick={() => {
                  close();
                  playNext(menu.song);
                }}
              />
            </>
          )}
        </ContextMenu>
      ) : null}
    </div>
  );
}
