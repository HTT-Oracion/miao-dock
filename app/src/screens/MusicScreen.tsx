import { useEffect, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { fmtTime, useMusicStore } from '../music/store';

/**
 * 音乐应用屏 —— ver2.0 第二个独立应用，按设计稿《音乐模块-设计稿-ver2.0》M1 实现。
 *
 * 结构：顶行（标题 + 当前平台）→ 左右 50/50（左「我的音乐」/ 右「搜索」）→ 底部播放条。
 *
 * 本轮范围（可验收的 MVP，PD-1「界面重写」）：
 * - 本地导入（多选文件 / 文件夹）→ 本地歌单 → 点击播放
 * - 网易云搜索 → 结果列表 → 点击播放（在线，走音频代理）
 * - 推荐歌单（musicPersonalized）→ 点击加载歌单曲目 → 播放
 * - 底部播放条：播放/暂停、上一首/下一首、进度条、音量、播放模式
 * 后续（遗留）：在线账号扫码登录、官方榜单、展开播放器六皮肤、队列抽屉、桌面歌词。
 *
 * 关键排版（设计稿注）：播放条控制组相对整条**绝对居中**（left:50% + translateX(-50%)），
 * 不随左右两侧宽度偏移 —— 这里沿用该布局，而非 flex 自动分配。
 */

/** 本地导入的 LocalSongInfo → 可播放的统一 Song（provider = "local"） */
export function MusicScreen() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const {
    localSongs,
    localQueue,
    currentSong,
    isPlaying,
    playUrl,
    progressMs,
    durationMs,
    volume,
    playMode,
    searchText,
    searchResults,
    searching,
    searchError,
    recommendPlaylists,
    loadingRecommend,
    currentPlaylist,
    loadingPlaylist,
    loginInfo,
    importLocal,
    importFolder,
    playQueue,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    cycleMode,
    search,
    setSearchText,
    setProgress,
    setDuration,
    loadRecommend,
    openPlaylist,
    closePlaylist,
    loadLoginStatus,
  } = useMusicStore();

  // ---- 挂载时加载推荐歌单 + 登录状态 ----
  useEffect(() => {
    void loadRecommend();
    void loadLoginStatus();
  }, [loadRecommend, loadLoginStatus]);

  // ---- 同步 store → <audio>：源、播放态、音量 ----
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.src !== playUrl) {
      a.src = playUrl;
      a.load();
    }
  }, [playUrl]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = volume;
  }, [volume]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) void a.play().catch(() => {});
    else a.pause();
  }, [isPlaying, playUrl]);

  // ---- <audio> 事件 → store：进度 / 时长 / 播完自动下一首 ----
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setProgress(a.currentTime * 1000);
    const onMeta = () => setDuration(a.duration * 1000);
    const onEnded = () => next();
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnded);
    };
  }, [next, setProgress, setDuration]);

  // ---- 本地导入：多选文件 / 文件夹 ----
  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma', 'aiff', 'ape'] }],
    });
    if (Array.isArray(picked) && picked.length > 0) await importLocal(picked);
  };

  const pickFolder = async () => {
    const picked = await open({ multiple: false, directory: true });
    if (typeof picked === 'string') await importFolder(picked);
  };

  const onSeek = (v: number) => {
    seek(v);
    const a = audioRef.current;
    if (a) a.currentTime = v / 1000;
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void search(searchText);
  };

  return (
    <div className="music">
      {/* 顶行：标题 + 当前平台 + 登录状态 */}
      <div className="music-top">
        <div className="music-top-l">
          <span className="music-title">音乐播放器</span>
          <span className="music-plat">当前平台：网易云音乐</span>
        </div>
        <div className="music-top-r">
          {loginInfo ? (
            <>
              <span className="music-ava">{loginInfo.avatar ? <img src={loginInfo.avatar} alt="" /> : loginInfo.nickname?.slice(0, 1)}</span>
              <span className="music-nick">{loginInfo.nickname}</span>
            </>
          ) : (
            <span className="music-nick muted">未登录</span>
          )}
        </div>
      </div>

      {/* 左右 50/50 */}
      <div className="music-cols">
        {/* 左：我的音乐（本地） */}
        <section className="music-card">
          <div className="music-card-hd">
            <span className="music-card-title">我的音乐</span>
            <span className="music-card-sub">{localSongs.length} 首</span>
            <div className="grow" />
            <button type="button" className="music-btn pri" onClick={() => void pickFiles()}>
              本地导入
            </button>
            <button type="button" className="music-btn out" onClick={() => void pickFolder()}>
              导入文件夹
            </button>
          </div>

          {localSongs.length === 0 ? (
            <div className="music-empty">
              还没有本地歌曲 —— 点「本地导入」选几首 mp3/flac，或「导入文件夹」整夹导入。
            </div>
          ) : (
            <div className="music-list">
              {localQueue.map((s) => (
                <div
                  key={s.id}
                  className={currentSong?.id === s.id ? 'music-row is-hot' : 'music-row'}
                  onClick={() => void playQueue(localQueue, localQueue.indexOf(s))}
                >
                  <div className="music-cover">{s.cover ? <img src={s.cover} alt="" /> : null}</div>
                  <div className="music-row-tx">
                    <b>{s.name}</b>
                    <span>{s.artist}</span>
                  </div>
                  <span className="music-dur">{s.duration ? fmtTime(s.duration * 1000) : ''}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 右：搜索 + 推荐 / 歌单曲目 */}
        <section className="music-card">
          {currentPlaylist ? (
            <>
              <div className="music-card-hd">
                <button type="button" className="music-btn out" onClick={closePlaylist}>
                  ← 返回
                </button>
                <span className="music-card-title">{currentPlaylist.playlist.name}</span>
                <span className="music-card-sub">{currentPlaylist.songs.length} 首</span>
                <div className="grow" />
                <button type="button" className="music-btn pri" onClick={() => void playQueue(currentPlaylist.songs, 0)}>
                  播放全部
                </button>
              </div>
              {loadingPlaylist ? (
                <div className="music-empty">加载歌单曲目中…</div>
              ) : currentPlaylist.songs.length === 0 ? (
                <div className="music-empty">歌单是空的。</div>
              ) : (
                <div className="music-list">
                  {currentPlaylist.songs.map((s) => (
                    <div
                      key={s.id}
                      className={currentSong?.id === s.id ? 'music-row is-hot' : 'music-row'}
                      onClick={() => void playQueue(currentPlaylist.songs, currentPlaylist.songs.indexOf(s))}
                    >
                      <div className="music-cover">{s.cover ? <img src={s.cover} alt="" /> : null}</div>
                      <div className="music-row-tx">
                        <b>{s.name}</b>
                        <span>{s.artist} · {s.album || '网易云音乐'}</span>
                      </div>
                      <span className="music-dur">{s.duration ? fmtTime(s.duration * 1000) : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="music-search-row">
                <input
                  className="music-search"
                  placeholder="搜索歌曲、歌手、歌单…（回车查看全部）"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={onSearchKey}
                />
                <button type="button" className="music-btn pri" onClick={() => void search(searchText)} disabled={searching}>
                  {searching ? '搜索中…' : '搜索'}
                </button>
              </div>

              {searchError ? <div className="music-empty is-bad">搜索失败：{searchError}</div> : null}

              {searchResults.length > 0 ? (
                <div className="music-list">
                  {searchResults.map((s) => (
                    <div
                      key={s.id}
                      className={currentSong?.id === s.id ? 'music-row is-hot' : 'music-row'}
                      onClick={() => void playQueue(searchResults, searchResults.indexOf(s))}
                    >
                      <div className="music-cover">{s.cover ? <img src={s.cover} alt="" /> : null}</div>
                      <div className="music-row-tx">
                        <b>{s.name}</b>
                        <span>{s.artist} · {s.album || '网易云音乐'}</span>
                      </div>
                      <span className="music-dur">{s.duration ? fmtTime(s.duration * 1000) : ''}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="music-card-hd">
                    <span className="music-card-title">推荐歌单</span>
                    <div className="grow" />
                    <button type="button" className="music-btn out" onClick={() => void loadRecommend()}>
                      刷新
                    </button>
                  </div>
                  {loadingRecommend ? (
                    <div className="music-empty">加载推荐歌单中…</div>
                  ) : recommendPlaylists.length === 0 ? (
                    <div className="music-empty">
                      暂无推荐歌单（可能需要登录或网络）。可直接在搜索框搜歌曲播放。
                    </div>
                  ) : (
                    <div className="music-list">
                      {recommendPlaylists.map((p) => (
                        <div key={p.id} className="music-row" onClick={() => void openPlaylist(p)}>
                          <div className="music-cover">{p.cover ? <img src={p.cover} alt="" /> : null}</div>
                          <div className="music-row-tx">
                            <b>{p.name}</b>
                            <span>{p.track_count} 首</span>
                          </div>
                          <span className="music-dur">›</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>

      {/* 底部播放条 */}
      <div className="music-player">
        <div className="music-player-row">
          <div className="music-pb-cover">{currentSong?.cover ? <img src={currentSong.cover} alt="" /> : null}</div>
          <div className="music-pb-tx">
            <b>{currentSong?.name ?? '未在播放'}</b>
            <span>{currentSong?.artist ?? '从左侧歌单或搜索结果选一首'}</span>
          </div>

          {/* 绝对居中控制组 */}
          <div className="music-ctrl">
            <button type="button" className="music-cbtn" title="播放模式" onClick={cycleMode}>
              {playMode === 'one' ? '🔂' : playMode === 'shuffle' ? '🔀' : '🔁'}
            </button>
            <button type="button" className="music-cbtn" title="上一首" onClick={prev}>
              <PrevIcon />
            </button>
            <button type="button" className="music-cbtn main" title={isPlaying ? '暂停' : '播放'} onClick={togglePlay}>
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button type="button" className="music-cbtn" title="下一首" onClick={next}>
              <NextIcon />
            </button>
          </div>

          <div className="music-vol">
            <span className="music-vol-icon">🔊</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
        </div>

        {/* 进度条 */}
        <div className="music-prog">
          <span className="music-prog-t">{fmtTime(progressMs)}</span>
          <input
            type="range"
            className="music-prog-bar"
            min={0}
            max={Math.max(durationMs, 1)}
            step={1000}
            value={Math.min(progressMs, durationMs)}
            onChange={(e) => onSeek(Number(e.target.value))}
          />
          <span className="music-prog-t">{fmtTime(durationMs)}</span>
        </div>
      </div>

      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5q-1-1-2 0v14q1 1 2 0l11-6q1-1 0-2z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="2" />
      <rect x="14" y="4" width="4" height="16" rx="2" />
    </svg>
  );
}
function PrevIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
      <rect x="4" y="5" width="3" height="14" rx="1.5" fill="currentColor" stroke="none" />
      <path d="M17 6L8 12 17 18" />
    </svg>
  );
}
function NextIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
      <path d="M7 6L16 12 7 18" />
      <rect x="17" y="5" width="3" height="14" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
