// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMusicStore } from '@music/store';
import { Btn, ColorPicker, Range, Segmented, Select, Swatches, Switch } from '@components/units';
import { CtlNote, GroupNote, ReadOnly } from '@screens/settings/parts';
import {
  SKINS,
  QUALITY_OPTIONS,
  LYRICS_SIZE,
  LYRICS_COLORS,
  LYRICS_COLOR_NAMES,
  LYRICS_MODE_OPTIONS,
} from '@music/player-options';
import { MEDIA } from '@screens/settings/catalog';
import type { SettingItem } from '@screens/settings/catalog';
import { Group } from './shared';

/**
 * 桌面歌词「锁定」在**主窗侧读写的那个 localStorage 键**。
 *
 * 锁定态的**权威副本在 Rust 侧**（`save_lyrics_window_state`，跨进程重启保留），
 * 歌词窗自己维护它。但歌词窗每次打开时会先读一次这个键来恢复上次状态，
 * 而主窗与歌词窗**同 origin、共享同一份 localStorage**（实测见台账 D-47），
 * 所以主窗能读到当前锁定态、也能预写下一次打开时要用的值。
 *
 * ⚠️ 刻意**不**在这里调 `save_lyrics_window_state`：那条命令要求连窗口位置 `y` 一起写，
 * 而主窗不知道窗口被拖到了哪（写 `y: 0` 会把用户拖好的位置弹回屏幕左上角）。
 * 要主窗成为锁定的权威写入方，得给 Rust 加一条「只改 locked」的窄命令 —— 那是改动
 * 冻结侧的事，本轮不做，也不该在这里绕。
 */
const LS_LYRICS_LOCKED = 'miaodock.lyrics.locked';

/** 读当前锁定态；读不到（隐私模式 / JSON 坏了）按未锁定处理，不让一项偏好拖垮整个设置页 */
function readLyricsLocked(): boolean {
  try {
    return localStorage.getItem(LS_LYRICS_LOCKED) === 'true';
  } catch {
    return false;
  }
}

/** 预写锁定态。只改锁定、不碰位置（见上面 LS_LYRICS_LOCKED 的注释） */
function writeLyricsLocked(locked: boolean): void {
  try {
    localStorage.setItem(LS_LYRICS_LOCKED, JSON.stringify(locked));
  } catch {
    // 禁写场景（隐私模式）下退化：本次设置不生效，但不该因此报错打断用户
  }
}

/** ③ 播放·媒体 —— 11 项全部接真实能力，横跨「播放 / 歌词 / 透明彩胶」三小节 */
export function MediaSection() {
  /*
   * 全部偏好都从音乐模块的全局 store 读，setter 回写同一份。
   *
   * 为什么视图直接读 store 而不是接 props：播放器（screens/music）与设置页读写的是
   * **同一份偏好**，两边各持一份就会长出"设置页说高清、播放器放标准"的两套事实。
   * store 的 setter 自己负责持久化，本组件不缓存、不落盘。
   *
   * 唯一的例外是「锁定歌词窗口」：它的权威副本不在 store（见下面 lyricsLocked 的注释），
   * 所以那一项由本组件自己读 localStorage。
   */
  const quality = useMusicStore((s) => s.playbackQuality);
  const setQuality = useMusicStore((s) => s.setPlaybackQuality);
  const skin = useMusicStore((s) => s.skin);
  const setSkin = useMusicStore((s) => s.setSkin);
  const dynamicEnabled = useMusicStore((s) => s.dynamicEnabled);
  const setDynamicEnabled = useMusicStore((s) => s.setDynamicEnabled);
  const discMode = useMusicStore((s) => s.discMode);
  const setDiscMode = useMusicStore((s) => s.setDiscMode);
  const lyricsMode = useMusicStore((s) => s.lyricsMode);
  const setLyricsMode = useMusicStore((s) => s.setLyricsMode);
  const lyricsFontSize = useMusicStore((s) => s.lyricsFontSize);
  const setLyricsFontSize = useMusicStore((s) => s.setLyricsFontSize);
  const lyricsHighlightColor = useMusicStore((s) => s.lyricsHighlightColor);
  const setLyricsHighlightColor = useMusicStore((s) => s.setLyricsHighlightColor);
  const vinylColorMode = useMusicStore((s) => s.vinylColorMode);
  const setVinylColorMode = useMusicStore((s) => s.setVinylColorMode);
  const vinylCustomColor = useMusicStore((s) => s.vinylCustomColor);
  const setVinylCustomColor = useMusicStore((s) => s.setVinylCustomColor);
  const lyricsWindowOpen = useMusicStore((s) => s.lyricsWindowOpen);
  const setLyricsWindowOpen = useMusicStore((s) => s.setLyricsWindowOpen);

  /**
   * 锁定态是**读一次 localStorage 得到的快照**，不是 store 字段。
   *
   * 为什么不放 store：锁定态的权威副本在歌词窗与 Rust 侧，放进 store 就成了第三份
   * 需要同步的副本 —— 而它恰恰是本项目最反对的那种「同一个偏好两个事实」。
   * 用局部 state 承接本组件读到的值，改动时只写 localStorage（下次开窗生效）。
   */
  const [lyricsLocked, setLyricsLockedState] = useState(readLyricsLocked);

  /** 按 id 分派控件。id 对不上 = catalog 与本组件不同步，明确抛错而非渲染成空行 */
  const render = (item: SettingItem): ReactNode => {
    switch (item.id) {
      case 'quality':
        return (
          <Select
            label={item.label}
            value={quality}
            options={QUALITY_OPTIONS}
            // setPlaybackQuality 是 async（会当场重取地址续播），void 收口避免未处理 Promise
            onChange={(q) => void setQuality(q)}
          />
        );
      case 'skin':
        return (
          <Select
            label={item.label}
            value={skin}
            options={SKINS.map((s) => ({ value: s.id, label: s.label }))}
            onChange={setSkin}
          />
        );
      case 'dynamic-bg':
        return <Switch on={dynamicEnabled} onToggle={() => setDynamicEnabled(!dynamicEnabled)} label={item.label} />;
      case 'disc-mode':
        return <Switch on={discMode} onToggle={() => setDiscMode(!discMode)} label={item.label} />;
      case 'lyrics-mode':
        // 设计稿这里是 `.seg` 分段控件而不是下拉：两档要一眼看全、点一下就换
        return (
          <Segmented label={item.label} value={lyricsMode} options={LYRICS_MODE_OPTIONS} onChange={setLyricsMode} />
        );
      case 'lyrics-size':
        return (
          <Range
            label={item.label}
            min={LYRICS_SIZE.min}
            max={LYRICS_SIZE.max}
            step={LYRICS_SIZE.step}
            value={lyricsFontSize}
            suffix="px"
            onChange={setLyricsFontSize}
          />
        );
      case 'lyrics-color':
        // 预设色点 + 取色器：两者写同一个 store 字段，取色器让用户能挑预设之外的颜色
        return (
          <>
            <Swatches
              label={item.label}
              colors={LYRICS_COLORS}
              names={LYRICS_COLOR_NAMES}
              value={lyricsHighlightColor}
              onPick={setLyricsHighlightColor}
            />
            <ColorPicker
              label={`${item.label}（自定义）`}
              value={lyricsHighlightColor}
              onChange={setLyricsHighlightColor}
            />
          </>
        );
      case 'lyrics-window':
        // 窗口生死归主窗管：这一项与播放条上的按钮调的是同一个 action，
        // 两处读同一份 store 状态，不会出现「设置页说开着、播放条说关着」。
        // 本平台不提供桌面歌词窗时（mac）**仍渲染且可点**，只是 action 直接空转 ——
        // 用户要求设置项保持可交互，不给一个点了没反应的禁用控件。
        return (
          <Switch
            on={lyricsWindowOpen}
            onToggle={() => void setLyricsWindowOpen(!lyricsWindowOpen)}
            label={item.label}
          />
        );
      case 'lyrics-locked':
        /*
         * 这一项是「**读当前值 + 改了要重开窗口才生效**」，不是即时生效的开关。
         *
         * 为什么不能做成看起来立刻生效的开关（那才是假控件）：锁定态由**歌词窗自己**
         * 在启动时从 localStorage 读一次，之后只认自己的双击手势；设置页此刻改这个键，
         * 对**已经开着**的那个窗口没有任何作用。做成即时开关，用户拨完发现窗口还能拖 ——
         * 这比没有控件更伤（假控件比缺控件更伤）。
         *
         * 所以形态是：如实显示当前锁定态 + 一个「切到锁定/切到解锁」按钮 +
         * 一行说明「改动会在下次打开桌面歌词时生效」。
         *
         * 关着窗口时整项 disabled：没有窗口可锁，此时按钮点了也无处生效。
         */
        return (
          <>
            <ReadOnly>{lyricsLocked ? '已锁定' : '未锁定'}</ReadOnly>
            <Btn
              size="sm"
              disabled={!lyricsWindowOpen}
              title={lyricsWindowOpen ? `下次打开桌面歌词时${lyricsLocked ? '解锁' : '锁定'}` : '请先开启桌面歌词窗口'}
              onClick={() => {
                const next = !lyricsLocked;
                writeLyricsLocked(next);
                setLyricsLockedState(next);
              }}
            >
              {lyricsLocked ? '切到解锁' : '切到锁定'}
            </Btn>
            <CtlNote>
              {lyricsWindowOpen ? '改动会在下次打开桌面歌词时生效（也可在歌词窗上双击直接切换）' : '先开启桌面歌词窗口'}
            </CtlNote>
          </>
        );
      case 'vinyl-color-mode':
        // 同 `lyrics-mode`：设计稿用分段控件（两档），不是下拉
        return (
          <Segmented
            label={item.label}
            value={vinylColorMode}
            options={[
              { value: 'auto', label: '跟随封面' },
              { value: 'custom', label: '固定颜色' },
            ]}
            onChange={setVinylColorMode}
          />
        );
      case 'vinyl-color':
        // 跟随封面主色时本项无意义 → 置灰而非隐藏（可见性由 catalog 决定，藏了行数就对不上）
        return (
          <>
            <ColorPicker
              label={item.label}
              value={vinylCustomColor}
              disabled={vinylColorMode !== 'custom'}
              onChange={setVinylCustomColor}
            />
            {vinylColorMode !== 'custom' ? <CtlNote>跟随封面主色时不可用</CtlNote> : null}
          </>
        );
      default:
        throw new Error(`[settings] ③ 播放·媒体 有未接线的项：${item.id} —— catalog 与本组件不同步`);
    }
  };

  return (
    <>
      {/*
       * 「音乐账号」卡**已移除**（本轮需求）：账号是音乐屏自己的事 ——
       * 工具条右侧那枚按钮就是登录入口，点开还会弹登录框。
       * 设置页再摆一张四格卡，等于把同一个身份状态做了两套界面，
       * 而且这一页的主语是"播放与媒体"，不是"账号"。
       */}
      {/* 按 catalog 的 groups 顺序渲染三小节：写死第一组会静默漏掉「歌词 / 透明彩胶」 */}
      {MEDIA.groups.map((g) => (
        <Group key={g.id} group={g} render={render} />
      ))}
      {/* 组说明缺省即不渲染（GroupNote 自守）：catalog 未给 MEDIA.note 时这一行自动消失 */}
      <GroupNote>{MEDIA.note as string}</GroupNote>
    </>
  );
}
