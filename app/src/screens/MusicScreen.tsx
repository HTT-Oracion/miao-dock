import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  FolderOpen,
  FolderPlus,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { QRCodeSVG } from 'qrcode.react';
import { fmtTime, lyricIndexAt, useMusicStore, type PlayerSkin } from '../music/store';

/**
 * 音乐应用屏 —— ver2.0 第二个独立应用，按设计稿《音乐模块-设计稿-ver2.0》实现。
 *
 * 结构：顶行（标题 + 当前平台 + 登录态）→ 左右 50/50（左「我的音乐」/ 右「搜索+发现」）
 * → 底部播放条 →（条件）队列抽屉 / 展开播放器。
 *
 * 图标：与参考实现一致，用 lucide-react（Play/Pause/SkipBack/SkipForward/Repeat/Shuffle/
 * Repeat1/Volume2/ListMusic/FolderOpen/FolderPlus/Search/ChevronLeft/Trash2/X）。
 */
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
    officialCharts,
    loginInfo,
    queueOpen,
    expanded,
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
    loadCharts,
    setQueueOpen,
    setExpanded,
    loginOpen,
    openLogin,
  } = useMusicStore();

  // ---- 挂载时加载推荐歌单 + 官方榜单 + 登录状态 ----
  useEffect(() => {
    void loadRecommend();
    void loadCharts();
    void loadLoginStatus();
  }, [loadRecommend, loadCharts, loadLoginStatus]);

  // ---- 同步 store → <audio> ----
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

  // ---- <audio> 事件 → store ----
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

  // ---- Esc 关闭展开播放器 / 队列抽屉 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
        setQueueOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setExpanded, setQueueOpen]);

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

  const modeIcon = playMode === 'one' ? <Repeat1 size={15} /> : playMode === 'shuffle' ? <Shuffle size={15} /> : <Repeat size={15} />;

  return (
    <div className="music">
      {/* 顶行 */}
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
            <button type="button" className="music-btn out" onClick={() => void openLogin()}>
              登录
            </button>
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
              <FolderOpen size={13} /> 本地导入
            </button>
            <button type="button" className="music-btn out" onClick={() => void pickFolder()}>
              <FolderPlus size={13} /> 导入文件夹
            </button>
          </div>

          {localSongs.length === 0 ? (
            <div className="music-empty">还没有本地歌曲 —— 点「本地导入」选几首 mp3/flac，或「导入文件夹」整夹导入。</div>
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

        {/* 右：搜索 + 发现 / 歌单曲目 */}
        <section className="music-card">
          {currentPlaylist ? (
            <>
              <div className="music-card-hd">
                <button type="button" className="music-btn out" onClick={closePlaylist}>
                  <ChevronLeft size={13} /> 返回
                </button>
                <span className="music-card-title">{currentPlaylist.playlist.name}</span>
                <span className="music-card-sub">{currentPlaylist.songs.length} 首</span>
                <div className="grow" />
                <button type="button" className="music-btn pri" onClick={() => void playQueue(currentPlaylist.songs, 0)}>
                  <Play size={13} /> 播放全部
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
                  <Search size={13} /> {searching ? '搜索中…' : '搜索'}
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
                  {/* 官方榜单 */}
                  {officialCharts.length > 0 && (
                    <>
                      <div className="music-card-hd">
                        <span className="music-card-title">官方榜单</span>
                      </div>
                      <div className="music-charts">
                        {officialCharts.map((c) => (
                          <div key={c.id} className="music-chart" onClick={() => void openPlaylist(c)}>
                            <div className="music-chart-cv">{c.cover ? <img src={c.cover} alt="" /> : c.name?.slice(0, 1)}</div>
                            <span>{c.name}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
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
                    <div className="music-empty">暂无推荐歌单（可能需要登录或网络）。可直接在搜索框搜歌曲播放。</div>
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
          <div className="music-pb-cover" onClick={() => setExpanded(true)} title="展开播放器">
            {currentSong?.cover ? <img src={currentSong.cover} alt="" /> : null}
          </div>
          <div className="music-pb-tx" onClick={() => setExpanded(true)} title="展开播放器">
            <b>{currentSong?.name ?? '未在播放'}</b>
            <span>{currentSong?.artist ?? '从左侧歌单或搜索结果选一首'}</span>
          </div>

          {/* 绝对居中控制组 */}
          <div className="music-ctrl">
            <button type="button" className="music-cbtn" title="播放模式" onClick={cycleMode}>
              {modeIcon}
            </button>
            <button type="button" className="music-cbtn" title="上一首" onClick={prev}>
              <SkipBack size={17} />
            </button>
            <button type="button" className="music-cbtn main" title={isPlaying ? '暂停' : '播放'} onClick={togglePlay}>
              {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button type="button" className="music-cbtn" title="下一首" onClick={next}>
              <SkipForward size={17} />
            </button>
          </div>

          <div className="music-vol">
            <Volume2 size={13} />
            <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
            <button type="button" className="music-cbtn" title="播放队列" onClick={() => setQueueOpen(true)}>
              <ListMusic size={15} />
            </button>
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

      {/* 队列抽屉 */}
      {queueOpen ? <QueueDrawer /> : null}

      {/* 展开播放器 */}
      {expanded ? <ExpandedPlayer /> : null}

      {/* 扫码登录 */}
      {loginOpen ? <LoginModal /> : null}

      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}

// ------------------------------------------------------------------ 评论行

function CommentRow({ c }: { c: { nickname: string; avatar: string; content: string; liked_count: number } }) {
  return (
    <div className="music-exp-cm">
      <span className="music-ava">{c.avatar ? <img src={c.avatar} alt="" /> : c.nickname?.slice(0, 1)}</span>
      <div className="music-exp-cm-body">
        <div className="music-exp-cm-hd">
          <b>{c.nickname}</b>
          <span>{c.liked_count} 赞</span>
        </div>
        <div className="music-exp-cm-txt">{c.content}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 扫码登录

function LoginModal() {
  const { qrUrl, qrStatus, qrLoading, closeLogin, openLogin } = useMusicStore();
  return (
    <div className="music-login-overlay" onClick={closeLogin}>
      <div className="music-login" onClick={(e) => e.stopPropagation()}>
        <div className="music-login-hd">
          <span className="music-card-title">登录网易云音乐</span>
          <button type="button" className="music-cbtn" title="关闭" onClick={closeLogin}>
            <X size={15} />
          </button>
        </div>
        {qrLoading ? (
          <div className="music-login-qr music-login-loading">获取二维码中…</div>
        ) : qrUrl ? (
          <div className="music-login-qr">
            <QRCodeSVG value={qrUrl} size={180} />
          </div>
        ) : (
          <div className="music-login-qr music-login-loading">二维码生成失败</div>
        )}
        <div className="music-login-status">{qrStatus || ' '}</div>
        {!qrLoading && qrStatus.includes('失败') && (
          <button type="button" className="music-btn pri" onClick={() => void openLogin()}>
            重新获取
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 队列抽屉

function QueueDrawer() {
  const { queue, currentSong, playQueue, removeFromQueue, clearQueue, setQueueOpen } = useMusicStore();
  return (
    <div className="music-drawer">
      <div className="music-drawer-hd">
        <ListMusic size={15} className="music-drawer-ic" />
        <span className="music-card-title">播放队列</span>
        <span className="music-card-sub">({queue.length} 首)</span>
        <div className="grow" />
        <button type="button" className="music-cbtn" title="清空队列" onClick={clearQueue}>
          <Trash2 size={15} />
        </button>
        <button type="button" className="music-cbtn" title="关闭" onClick={() => setQueueOpen(false)}>
          <X size={15} />
        </button>
      </div>
      {queue.length === 0 ? (
        <div className="music-empty">队列是空的。</div>
      ) : (
        <div className="music-drawer-list">
          {queue.map((s, i) => (
            <div
              key={s.id + i}
              className={currentSong === s ? 'music-qrow is-hot' : 'music-qrow'}
              onClick={() => void playQueue(queue, i)}
            >
              <span className="music-qrow-ix">{currentSong === s ? '♪' : i + 1}</span>
              <div className="music-row-tx">
                <b>{s.name}</b>
                <span>{s.artist}</span>
              </div>
              <span className="music-dur">{s.duration ? fmtTime(s.duration * 1000) : ''}</span>
              <button
                type="button"
                className="music-cbtn"
                title="从队列移除"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFromQueue(i);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 展开播放器

const SKINS: { id: PlayerSkin; label: string; cls: string }[] = [
  { id: 'modern', label: '现代', cls: 'sk-modern' },
  { id: 'glass', label: '通透', cls: 'sk-glass' },
  { id: 'immersive', label: '沉浸', cls: 'sk-immersive' },
  { id: 'spectrum', label: '音域回响', cls: 'sk-spectrum' },
  { id: 'vinyl', label: '透明彩胶', cls: 'sk-vinyl' },
  { id: 'cover', label: '封面渐染', cls: 'sk-cover' },
];

function ExpandedPlayer() {
  const {
    currentSong,
    isPlaying,
    progressMs,
    durationMs,
    volume,
    playMode,
    skin,
    setSkin,
    setExpanded,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    cycleMode,
    parsedLyrics,
    comments,
    loadingComments,
    loadComments,
  } = useMusicStore();
  const [skinPickerOpen, setSkinPickerOpen] = useState(false);
  const [tab, setTab] = useState<'lyrics' | 'comments'>('lyrics');
  const skinMeta = SKINS.find((s) => s.id === skin) ?? SKINS[0];
  const activeLine = lyricIndexAt(parsedLyrics, progressMs / 1000);
  const modeIcon = playMode === 'one' ? <Repeat1 size={15} /> : playMode === 'shuffle' ? <Shuffle size={15} /> : <Repeat size={15} />;

  return (
    <div className={`music-exp ${skinMeta.cls}`}>
      <div className="music-exp-topbar">
        <button type="button" className="music-exp-tbtn" title="收起" onClick={() => setExpanded(false)}>
          <ChevronLeft size={18} />
        </button>
      </div>

      <div className="music-exp-body">
        <div className="music-exp-cover">{currentSong?.cover ? <img src={currentSong.cover} alt="" /> : null}</div>
        <div className="music-exp-info">
          <b>{currentSong?.name ?? '未在播放'}</b>
          <span>{currentSong?.artist ?? ''}</span>
          <em>{currentSong?.album || ''}</em>
        </div>
        <div className="music-exp-lyrics">
          <div className="music-exp-ltabs">
            <button type="button" className={tab === 'lyrics' ? 'music-exp-ltab is-on' : 'music-exp-ltab'} onClick={() => setTab('lyrics')}>
              歌词
            </button>
            <button
              type="button"
              className={tab === 'comments' ? 'music-exp-ltab is-on' : 'music-exp-ltab'}
              onClick={() => {
                setTab('comments');
                if (currentSong && !comments) void loadComments(currentSong);
              }}
            >
              评论
            </button>
          </div>

          {tab === 'lyrics' ? (
            parsedLyrics.length === 0 ? (
              <div className="music-exp-lyr-empty">暂无歌词</div>
            ) : (
              <div className="music-exp-lyr-box">
                {parsedLyrics.map((line, i) => (
                  <div key={i} className={i === activeLine ? 'music-lyr-line is-on' : 'music-lyr-line'}>
                    {line.text}
                  </div>
                ))}
              </div>
            )
          ) : currentSong?.provider !== 'netease' ? (
            <div className="music-exp-lyr-empty">当前平台暂不支持评论</div>
          ) : loadingComments ? (
            <div className="music-exp-lyr-empty">加载评论中…</div>
          ) : !comments || (comments.comments.length === 0 && comments.hot_comments.length === 0) ? (
            <div className="music-exp-lyr-empty">暂无评论</div>
          ) : (
            <div className="music-exp-comments">
              {comments.hot_comments.length > 0 && <div className="music-exp-cm-sec">热门评论</div>}
              {comments.hot_comments.map((c) => (
                <CommentRow key={c.comment_id} c={c} />
              ))}
              {comments.comments.length > 0 && <div className="music-exp-cm-sec">最新评论</div>}
              {comments.comments.map((c) => (
                <CommentRow key={c.comment_id} c={c} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="music-exp-bottom">
        <div className="music-exp-brow">
          <div className="music-exp-l">
            <button type="button" className="music-exp-chip" onClick={() => setSkinPickerOpen(!skinPickerOpen)}>
              皮肤：{skinMeta.label}
            </button>
          </div>
          <div className="music-ctrl">
            <button type="button" className="music-cbtn" title="播放模式" onClick={cycleMode}>
              {modeIcon}
            </button>
            <button type="button" className="music-cbtn" title="上一首" onClick={prev}>
              <SkipBack size={17} />
            </button>
            <button type="button" className="music-cbtn main" title={isPlaying ? '暂停' : '播放'} onClick={togglePlay}>
              {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button type="button" className="music-cbtn" title="下一首" onClick={next}>
              <SkipForward size={17} />
            </button>
          </div>
          <div className="music-exp-vol">
            <Volume2 size={15} />
            <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </div>
        </div>
        <div className="music-prog">
          <span className="music-prog-t">{fmtTime(progressMs)}</span>
          <input
            type="range"
            className="music-prog-bar"
            min={0}
            max={Math.max(durationMs, 1)}
            step={1000}
            value={Math.min(progressMs, durationMs)}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <span className="music-prog-t">{fmtTime(durationMs)}</span>
        </div>
      </div>

      {skinPickerOpen ? (
        <div className="music-skin-picker">
          <div className="music-skin-hd">选择皮肤</div>
          <div className="music-skins">
            {SKINS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={skin === s.id ? 'music-skin is-on' : 'music-skin'}
                onClick={() => {
                  setSkin(s.id);
                  setSkinPickerOpen(false);
                }}
              >
                <span className={`music-skin-thumb ${s.cls}`} />
                <span className="music-skin-lb">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
