import { useEffect } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { fmtTime } from '../../music/store';
import { providerLabel } from '../../music/platform';
import type { Song } from '../../music/types';

/**
 * 音乐屏共享小组件 —— 只放**多处复用**的东西；一次性结构一律写在各自文件里，
 * 免得这里长成一个什么都塞的杂物间。
 */

/** Esc 关闭某个浮层（弹窗/菜单各自挂一个，互不干扰） */
export function useEsc(onEsc: () => void) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEsc();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onEsc]);
}

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

/** 空态 / 提示（is-inline 用于夹在内容流里的短提示，不吃 flex:1） */
export function Empty({
  children,
  bad,
  inline,
}: {
  children: ReactNode;
  bad?: boolean;
  inline?: boolean;
}) {
  const cls = ['music-empty', bad ? 'is-bad' : '', inline ? 'is-inline' : ''].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
}

/**
 * 圆形图标按钮（播放条、展开播放器、行内操作共用一套热区）。
 * onClick 收事件对象：行内的操作按钮需要 stopPropagation，避免顺带触发整行点击；
 * primary 给播放/暂停这个实心主按钮用。
 */
export function IconButton({
  title,
  onClick,
  disabled,
  active,
  primary,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  const cls = ['music-cbtn', primary ? 'main' : '', active ? 'is-on' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 通用歌曲行。
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
  const sec = duration ?? song.duration;
  return (
    <div className={active ? 'music-row is-hot' : 'music-row'} onClick={onClick}>
      {leading}
      {showCover ? <Cover url={cover ?? ''} /> : null}
      <div className="music-row-tx">
        <b>{song.name}</b>
        <span>{meta ?? song.artist}</span>
      </div>
      {sec ? <span className="music-dur">{fmtTime(sec * 1000)}</span> : null}
      {actions ? <div className="music-row-act">{actions}</div> : null}
    </div>
  );
}
