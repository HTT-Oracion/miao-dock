import { useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import type { ServiceStatus } from '@/ipc';
import type { ThemeMode } from '@/theme/tokens';
import { stateView } from '@/nav';
import { ColorPicker, Dot, Range, Select, Swatches, Switch } from '@components/units';
import { CtlNote, GroupNote, PendingRow, ReadOnly, Row, RowNote, SubTitle } from '@screens/settings/parts';
import { SKINS, QUALITY_OPTIONS, LYRICS_SIZE, LYRICS_COLORS } from '@music/player-options';
import { useMusicStore } from '@music/store';
import { ABOUT, GENERAL, MEDIA, RESOURCE, TRANSLATE } from '@screens/settings/catalog';
import type { SettingGroup, SettingItem } from '@screens/settings/catalog';
import { SpecCheckBlock, useSpecCheck } from '@screens/settings/SpecCheck';

const STATUS_TEXT: Record<ServiceStatus['state'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  error: '异常',
};

/** 按 id 从小节里取项。id 写错是编程错误，宁可崩也不要静默渲染成空行 */
function itemOf(g: SettingGroup, id: string): SettingItem {
  const hit = g.items.find((i) => i.id === id);
  if (!hit) throw new Error(`[settings] 小节 ${g.id} 里没有项 ${id} —— catalog 与本组件不同步`);
  return hit;
}

/** 整组小节按 catalog 顺序渲染；`live` 的项走 `render`，其余一律 PendingRow */
function Group({
  group,
  render,
}: {
  group: SettingGroup;
  render?: (item: SettingItem) => React.ReactNode;
}) {
  return (
    <div className="set-group">
      {group.title ? <SubTitle>{group.title}</SubTitle> : null}
      {group.items.map((item) => {
        // 没给 render 的组就是"整组待接入"（③/④）。这里不做兜底渲染控件 ——
        // 想要控件就在 render 里显式写，写漏了只会看到 PendingRow，不会静默出假控件。
        if (item.state === 'pending' || !render) return <PendingRow key={item.id} item={item} />;
        return <Row key={item.id} item={item}>{render(item)}</Row>;
      })}
    </div>
  );
}

/**
 * ① 通用 —— 4 项。
 *
 * live：深色模式（真切换 `onMode`）· 关闭窗口行为（真行为：收起到托盘）· 规格自检（C 组断言）
 * pending：侧栏图标标签（要改 Sidebar.tsx 的渲染分支，不在本轮范围）
 */
export function GeneralSection({
  mode,
  onMode,
  fixtureRef,
}: {
  mode: ThemeMode;
  onMode: (m: ThemeMode) => void;
  fixtureRef: RefObject<HTMLDivElement>;
}) {
  const spec = useSpecCheck(fixtureRef, mode);
  const g = GENERAL.groups[0];
  const darkItem = itemOf(g, 'dark-mode');
  const specItem = itemOf(g, 'spec-check');

  return (
    <>
      <GroupNote>{GENERAL.note as string}</GroupNote>
      <div className="set-group">
        <Row item={darkItem}>
          <Switch
            on={mode === 'dark'}
            onToggle={() => onMode(mode === 'dark' ? 'light' : 'dark')}
            label="深色模式"
          />
        </Row>

        <Row item={itemOf(g, 'close-window')}>
          <ReadOnly>收起到托盘</ReadOnly>
        </Row>
        <RowNote>
          关闭窗口只是把窗口收起来 —— 本地服务继续跑，浏览器插件照样能提交翻译任务，
          托盘图标常驻。要真正退出请用托盘菜单里的「退出喵坞…」，届时会有二次确认。
        </RowNote>

        {/*
          规格自检：标题走 Row（与其它项对齐），运行器与结果走通栏。
          不塞进 Row 的右列 —— 26 条结果列表挤在控件列里没法读。
        */}
        <Row item={specItem} />
        <div className="set-row-note set-row-note-body">
          对离屏样张量实际渲染尺寸与颜色，跟 design token 常量逐一比对。
          CSS 里改错了数值，这里会立刻报红 —— 让「界面与方案文档对得上」变成一条可复核的断言，
          而不是一句主观评价。
        </div>
        <SpecCheckBlock
          results={spec.results}
          revealed={spec.revealed}
          failed={spec.failed}
          onRun={spec.run}
        />

        <PendingRow item={itemOf(g, 'sidebar-labels')} />
      </div>
    </>
  );
}

/**
 * ② 翻译服务 —— 10 项 · 三小节（《09》§4.3）。
 *
 * 小节标题是这一组的**唯一分层手段**，也是 C11 的判据，所以标题写在 catalog 里、
 * 本组件只负责按 `groups` 顺序渲染 —— 少一组小节会直接体现为少一个 SubTitle。
 */
export function TranslateSection({
  status,
  onToast,
}: {
  status: ServiceStatus | null;
  onToast: (t: string, k?: 'info' | 'good' | 'bad') => void;
}) {
  const copyToken = async () => {
    if (!status?.token) return;
    try {
      await navigator.clipboard.writeText(status.token);
      onToast('令牌已复制，粘到插件设置里即可配对', 'good');
    } catch {
      onToast('复制失败，请手动选中复制', 'bad');
    }
  };

  const pairing = TRANSLATE.groups.find((x) => x.id === 'pairing') as SettingGroup;
  const state = status ? stateView(status.state) : null;

  return (
    <>
      <GroupNote>{TRANSLATE.note as string}</GroupNote>

      {/* 小节一：服务与配对（3）—— 本组唯一接了真实能力的小节 */}
      <div className="set-group">
        <SubTitle>服务与配对</SubTitle>

        <Row item={itemOf(pairing, 'service-endpoint')}>
          {state ? (
            <span className="set-state">
              <Dot colorVar={state.colorVar} pulse={status?.state === 'starting'} />
              <span className="set-state-text">
                {STATUS_TEXT[status?.state ?? 'stopped']} · 服务 :{status?.port ?? '—'} · 引擎 :
                {status?.sidecar_port ?? '—'}
              </span>
            </span>
          ) : (
            <ReadOnly>读取中…</ReadOnly>
          )}
        </Row>
        {status?.last_error ? (
          <div className="notice is-bad set-row-note">最近一次错误：{status.last_error}</div>
        ) : null}

        <Row item={itemOf(pairing, 'token-pairing')}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!status?.token}
            onClick={() => void copyToken()}
          >
            复制令牌
          </button>
        </Row>
        <div className="set-token">
          <span className="muted">X-Box-Token</span>
          <code>{status?.token ?? '—'}</code>
        </div>
        <RowNote>
          插件靠这个令牌提交翻译任务。令牌由本机生成、权限 0600，只存在这台机器上，
          不会上传到任何远端；换令牌等于让旧令牌立即失效。
        </RowNote>

        <Row item={itemOf(pairing, 'root-dir')}>
          <ReadOnly title={status?.root_dir ?? undefined}>{status?.root_dir ?? '—'}</ReadOnly>
        </Row>
      </div>

      {/* 小节二、三：整组待接入。刻意不预置任何控件 */}
      <Group group={TRANSLATE.groups.find((x) => x.id === 'inference') as SettingGroup} />
      <Group group={TRANSLATE.groups.find((x) => x.id === 'model') as SettingGroup} />
    </>
  );
}

/** ③ 播放·媒体 —— 8 项全部接真实能力，横跨「播放 / 歌词 / 透明彩胶」三小节 */
export function MediaSection() {
  /*
   * 全部偏好都从音乐模块的全局 store 读，setter 回写同一份。
   *
   * 为什么视图直接读 store 而不是接 props：播放器（screens/music）与设置页读写的是
   * **同一份偏好**，两边各持一份就会长出"设置页说高清、播放器放标准"的两套事实。
   * store 的 setter 自己负责持久化，本组件不缓存、不落盘。
   */
  const quality = useMusicStore((s) => s.playbackQuality);
  const setQuality = useMusicStore((s) => s.setPlaybackQuality);
  const skin = useMusicStore((s) => s.skin);
  const setSkin = useMusicStore((s) => s.setSkin);
  const dynamicEnabled = useMusicStore((s) => s.dynamicEnabled);
  const setDynamicEnabled = useMusicStore((s) => s.setDynamicEnabled);
  const discMode = useMusicStore((s) => s.discMode);
  const setDiscMode = useMusicStore((s) => s.setDiscMode);
  const lyricsFontSize = useMusicStore((s) => s.lyricsFontSize);
  const setLyricsFontSize = useMusicStore((s) => s.setLyricsFontSize);
  const lyricsHighlightColor = useMusicStore((s) => s.lyricsHighlightColor);
  const setLyricsHighlightColor = useMusicStore((s) => s.setLyricsHighlightColor);
  const vinylColorMode = useMusicStore((s) => s.vinylColorMode);
  const setVinylColorMode = useMusicStore((s) => s.setVinylColorMode);
  const vinylCustomColor = useMusicStore((s) => s.vinylCustomColor);
  const setVinylCustomColor = useMusicStore((s) => s.setVinylCustomColor);

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
        return (
          <Switch on={dynamicEnabled} onToggle={() => setDynamicEnabled(!dynamicEnabled)} label={item.label} />
        );
      case 'disc-mode':
        return <Switch on={discMode} onToggle={() => setDiscMode(!discMode)} label={item.label} />;
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
      case 'vinyl-color-mode':
        return (
          <Select
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
      <GroupNote>{MEDIA.note as string}</GroupNote>
      {/* 按 catalog 的 groups 顺序渲染三小节：写死第一组会静默漏掉「歌词 / 透明彩胶」 */}
      {MEDIA.groups.map((g) => (
        <Group key={g.id} group={g} render={render} />
      ))}
    </>
  );
}

/** ④ 资源与投放 —— 3 项全部待接入 */
export function ResourceSection() {
  return (
    <>
      <GroupNote>{RESOURCE.note as string}</GroupNote>
      <Group group={RESOURCE.groups[0]} />
    </>
  );
}

/**
 * ⑤ 关于 —— 4 项。版本号是本组唯一 live 项。
 *
 * 版本号取 Tauri 的 `getVersion()`（构建时的真实版本），不是手写常量。
 * 拿不到就明说"读取失败"，**不退回硬编码字符串** —— 一个与实际构建无关的
 * 版本号比没有版本号更糟：它会让人以为看的是当前这个包。
 */
export function AboutSection() {
  const [ver, setVer] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await getVersion();
        if (alive) setVer(v);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const g = ABOUT.groups[0];
  const versionItem = itemOf(g, 'version');

  return (
    <>
      <GroupNote>{ABOUT.note as string}</GroupNote>
      <div className="set-group">
        <Row item={versionItem}>
          <ReadOnly>{failed ? '读取失败' : (ver ?? '读取中…')}</ReadOnly>
        </Row>
        {failed ? (
          <RowNote>
            读不到构建版本（WebView 未获 <code>core:app:allow-version</code> 授权时如此）。
            刻意不填一个手写版本号顶上 —— 那会让你以为看的是当前这个包。
          </RowNote>
        ) : null}
        <PendingRow item={itemOf(g, 'check-update')} />
        <PendingRow item={itemOf(g, 'licenses')} />
        <PendingRow item={itemOf(g, 'oss-feedback')} />
      </div>
    </>
  );
}
