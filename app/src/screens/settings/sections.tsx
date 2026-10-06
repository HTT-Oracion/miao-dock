import { useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { errorText, openPath } from '@/ipc';
import type { ServiceStatus } from '@/ipc';
import type { ThemeMode } from '@/theme/tokens';
import { stateView } from '@/nav';
import { Btn, ColorPicker, Dot, NumberInput, Range, Select, Swatches, Switch } from '@components/units';
import { CtlNote, GroupNote, PendingRow, ReadOnly, Row, RowNote, SubTitle } from '@screens/settings/parts';
import { SKINS, QUALITY_OPTIONS, LYRICS_SIZE, LYRICS_COLORS, LYRICS_MODE_OPTIONS } from '@music/player-options';
import { useMusicStore } from '@music/store';
import { ABOUT, GENERAL, MEDIA, RESOURCE, TRANSLATE } from '@screens/settings/catalog';
import type { SettingGroup, SettingItem } from '@screens/settings/catalog';
import { SpecCheckBlock, useSpecCheck } from '@screens/settings/SpecCheck';
import { CacheBlock } from '@screens/settings/CacheBlock';
import { EngineDiag } from '@screens/settings/EngineDiag';
import { ModelManageBlock } from '@screens/settings/ModelManageBlock';
import { StorageBlock } from '@screens/settings/StorageBlock';
import { LicensesBlock } from '@screens/settings/LicensesBlock';
import type { LibraryResponse } from '@/types';
import { useEngineState } from '@screens/settings/engine-state';
import { ACCEL_LABEL } from '@screens/settings/engine-api';
import type { EngineAccel, EngineOptions, EngineTier } from '@screens/settings/engine-api';

const STATUS_TEXT: Record<ServiceStatus['state'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  stopping: '正在停止',
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
        /*
         * `layout: 'block'` 的项走通栏：内容自带完整布局（如「音乐缓存」的四格），
         * 再套一层 `Row` 就会多出一截标题 + 一个窄控件列，把它压成一条细缝。
         *
         * 这里仍然要求它有 `label` —— 由渲染方自己画（`CacheBlock` 的第一格就是它）。
         * 之所以不在 `Row` 里复用 `label`，是因为 `Row` 的语义是"标题左 / 控件右"，
         * 而通栏块里标题的位置由内容自己定，强行塞进去只会多一层嵌套。
         */
        if (item.layout === 'block') return <div key={item.id}>{render(item)}</div>;
        return <Row key={item.id} item={item}>{render(item)}</Row>;
      })}
    </div>
  );
}

/**
 * ① 通用 —— 4 项，**全部 live**（台账 D-84）。
 *
 * 深色模式（真切换 `onMode`）· 关闭窗口行为（真行为：收起到托盘）· 规格自检（C 组断言）·
 * 侧栏图标标签（壳层偏好，真切换 `Sidebar` 的两种形态 —— 值住在 `shell-prefs.ts`）。
 */
export function GeneralSection({
  mode,
  onMode,
  sidebarLabels,
  onSidebarLabels,
  fixtureRef,
}: {
  mode: ThemeMode;
  onMode: (m: ThemeMode) => void;
  sidebarLabels: boolean;
  onSidebarLabels: (on: boolean) => void;
  fixtureRef: RefObject<HTMLDivElement>;
}) {
  const spec = useSpecCheck(fixtureRef, mode);
  const g = GENERAL.groups[0];
  const darkItem = itemOf(g, 'dark-mode');
  const specItem = itemOf(g, 'spec-check');

  return (
    <>
      <GroupNote summary={GENERAL.noteSummary}>{GENERAL.note as string}</GroupNote>
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
          不塞进 Row 的右列 —— 35 条结果列表挤在控件列里没法读。
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

        {/*
          侧栏图标标签：**同一个 state 同时驱动两处**（`App` 的 `sidebarLabels`）——
          拨开关时侧栏同帧变，不需要重载、也不需要把偏好写进 DOM 再让 Sidebar 去读。
          这里刻意不自己读 localStorage：那样会造出第二个真值来源。
        */}
        <Row item={itemOf(g, 'sidebar-labels')}>
          <Switch
            on={sidebarLabels}
            onToggle={() => onSidebarLabels(!sidebarLabels)}
            label="侧栏图标标签"
          />
        </Row>
      </div>
    </>
  );
}

/**
 * ② 翻译服务 —— 10 项 · 三小节（《09》§4.3）。
 *
 * 小节标题是这一组的**唯一分层手段**，也是 C11 的判据（它数 `.set-subtitle` 恰为 3 个），
 * 所以标题写在 catalog 里、本组件按 `groups` 顺序渲染 —— 少一组会直接体现为少一个 SubTitle。
 *
 * ## 这十项的取值来自**两个**服务端视角（不是一处冗余）
 *   · `GET /engine/options` —— 选项清单：能选什么、选完何时生效、哪些键要重启
 *   · `GET /engine/status`  —— 体检报告：进程此刻什么样、下载任务跑到哪了
 * 详见 `useEngineState` 的文件头。这里只说一件界面上必须守住的事：
 * **「已配置」与「已生效」要分别显示**。档位下拉显示的是**已配置**（用户在这里改的是
 * "下次启动用哪档"），旁边那句小字才报当前引擎在跑哪档。反过来的话，用户刚保存完
 * 就会看到下拉跳回旧值，只能得出"没存上"的结论。
 */
export function TranslateSection({
  status,
  onToast,
}: {
  status: ServiceStatus | null;
  onToast: (t: string, k?: 'info' | 'good' | 'bad') => void;
}) {
  const eng = useEngineState(onToast);

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
  const inference = TRANSLATE.groups.find((x) => x.id === 'inference') as SettingGroup;
  const model = TRANSLATE.groups.find((x) => x.id === 'model') as SettingGroup;
  const state = status ? stateView(status.state) : null;

  const o = eng.options;
  const busy = eng.action !== null;

  /** 档位下拉的取值 = **已配置**（盘上那份）；没配过就回落到硬件推荐档 */
  const tierValue: EngineTier = o?.tier.configured ?? o?.tier.hardwareRecommended ?? 'tiny';
  const tierFeasible = o?.tier.options ?? [];
  const tierSelectable = tierFeasible.filter((t) => t.weightsReady);
  /*
   * 权重未纳入清单的档位**不出现**（与"物理不可行的档位不出现"同一把尺子：
   * 列出来就是给一个点了不会有作用的选项）。但**当前已配置的那个必须出现** ——
   * 否则控件会显示成空白/裸 id，用户看不出自己现在配的是哪档。
   */
  const tierOptions: { value: EngineTier; label: string }[] = tierSelectable.map((t) => ({
    value: t.tier,
    // 非推荐档在**选项文字**里就标出来（不必等选中才看见警示）
    label: t.recommended ? `${TIER_LABEL[t.tier]}（推荐）` : `${TIER_LABEL[t.tier]}（不推荐）`,
  }));
  if (!tierOptions.some((t) => t.value === tierValue)) {
    tierOptions.push({ value: tierValue, label: `${TIER_LABEL[tierValue]}（当前配置 · 权重不在清单）` });
  }
  /** 当前配的那档的可行性信息 —— 「不推荐」的强警告与预估内存都从这里来 */
  const tierInfo = tierFeasible.find((t) => t.tier === tierValue) ?? null;

  const accelValue: EngineAccel = o?.accel.choice ?? 'auto';

  /** 值 → 中文名（后端候选缺失时也要能显示已配置的那一个，不能露出 `mps` 这种裸 id） */
  const accelLabel = (v: EngineAccel) =>
    o?.accel.options.find((x) => x.value === v)?.label ?? ACCEL_LABEL[v];

  const pending = pendingRestart(o);

  return (
    <>
      <GroupNote summary={TRANSLATE.noteSummary}>{TRANSLATE.note as string}</GroupNote>

      {/* 小节一：服务与配对（3） */}
      <div className="set-group">
        <SubTitle>服务与配对</SubTitle>

        <Row item={itemOf(pairing, 'service-endpoint')}>
          {state ? (
            /*
             * R4：原来是一串**不可断**的文本「运行中 · 服务 :5180 · 引擎 :8001」
             * （`·` 前后无空格，整串当一个词排）。右列是 `flex:0 0 auto` 的窄列，
             * 窄窗下它要么整体溢出、要么被截 —— 而且状态与两个端口挤在一串里，
             * 分不清哪一段是"怎么了"、哪一段是"在哪答"。
             * 拆成三枚可独立换行的 chip 后，端口数字走等宽、纵向对齐可扫。
             * 状态色只落在 chip 的圆点上（文字同步给出，颜色不作唯一信息载体）。
             */
            <>
              <span className="set-state is-chip">
                <Dot colorVar={state.colorVar} pulse={status?.state === 'starting'} />
                <span className="set-state-text">{STATUS_TEXT[status?.state ?? 'stopped']}</span>
              </span>
              <span className="set-pnum">服务 :{status?.port ?? '—'}</span>
              <span className="set-pnum">引擎 :{status?.sidecar_port ?? '—'}</span>
            </>
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
        {/*
          令牌值渲染成**只读输入框**（拍板：原先是 `<code>`）。
         *
         * `<code>` 是行内元素：超长令牌到容器边缘会**折行成两行**（`word-break` 一开
         * 就断在任意字符处），而它周围没有任何"这是一份可选中复制的值"的暗示 ——
         * 用户只能靠手动拖选去拿它。输入框补上三件行内文本给不了的事：
         * ① 单行不折（超长走横向滚动）；② 一次点击即全选（`onFocus` 里 `select()`）；
         * ③ 形状本身就在说"这是一份值"。
         *
         * 🔴 必须是 `readOnly` 而**不是** `disabled` —— `disabled` 的输入框不可选中、
         * 不可复制，那就把"让用户看得见还能拿走"这件事做反了，而且它会变灰得像一个
         * 坏掉的控件。右侧「复制令牌」按钮**保留**（主路径），输入框是兜底路径
         * （让用户能只选一段、或自己拿去做别的）。
         */}
        <div className="set-token">
          <span className="set-token-k">X-Box-Token</span>
          <input
            className="set-token-in"
            readOnly
            value={status?.token ?? ''}
            aria-label="X-Box-Token"
            title={status?.token ?? undefined}
            onFocus={(e) => e.currentTarget.select()}
          />
          <span className="set-token-ro">只读</span>
        </div>
        <RowNote>
          插件靠这个令牌提交翻译任务。令牌由本机生成、权限 0600，只存在这台机器上，
          不会上传到任何远端；换令牌等于让旧令牌立即失效。
        </RowNote>

        <Row item={itemOf(pairing, 'root-dir')}>
          <ReadOnly title={status?.root_dir ?? undefined}>{status?.root_dir ?? '—'}</ReadOnly>
        </Row>
      </div>

      {/* 小节二：推理引擎（4）—— 档位 / 后端 / 两个空闲卸载阈值 */}
      <div className="set-group">
        <SubTitle>推理引擎</SubTitle>
        {eng.loadError ? (
          <div className="notice is-bad set-row-note">
            读不到引擎选项：{eng.loadError}
          </div>
        ) : null}

        <Row item={itemOf(inference, 'tier')}>
          {o ? (
            /*
             * 顺序：**说明在前、下拉贴最右**（拍板）。两行的下拉因此右边缘对齐，
             * 与本组其它行的控件落在同一条竖线上 —— 控件列读起来是一个"操作列"，
             * 而不是每行各自为政。
             *
             * ⚠️ 只换了顺序，「引擎正在跑：X」这句一个字没删：它和下拉显示的值
             * 一起构成**「已配置 vs 已生效」唯一的区分点**（用户刚改完档位时，
             * 下拉显示新值、这句仍报旧值 —— 少了它，用户只能以为"没存上"）。
             */
            <>
              <CtlNote>
                {o.tier.effective === null
                  ? '引擎未在运行，无法报出当前档位'
                  : o.tier.effective === tierValue
                    ? `引擎正在跑：${TIER_LABEL[o.tier.effective]}`
                    : `引擎正在跑：${TIER_LABEL[o.tier.effective]}（改动需重启才生效）`}
              </CtlNote>
              <Select
                label={itemOf(inference, 'tier').label}
                value={tierValue}
                options={tierOptions}
                onChange={(v) => {
                  // 选中的就是当前值 ⇒ 不必发一次"什么都没改"的写请求
                  if (v === tierValue) return;
                  void eng.save({ tier: v });
                }}
              />
            </>
          ) : (
            <ReadOnly>{eng.loadError ? '读取失败' : '读取中…'}</ReadOnly>
          )}
        </Row>
        {/*
          「不推荐」档的**强警告**（《02》§5：Small 保留但标注不推荐，选中时强警告）。
          用通栏条而不是挤在右列 —— 右列是 `flex:0 0 auto` 的窄列，
          一句带数字的警告塞进去会把同一个下拉挤歪。
        */}
        {tierInfo && !tierInfo.recommended ? (
          <div className="set-warn">
            {TIER_LABEL[tierInfo.tier]} 不建议：{tierInfo.warning}
            {o ? `（该档预估峰值约 ${tierInfo.peakGb} GB，本机 ${o.hardware.totalRamGb} GB）` : ''}
            。机器内存吃紧时翻译会明显变卡，甚至被系统换页拖慢整机。
          </div>
        ) : null}
        {tierSelectable.length < tierFeasible.length ? (
          <RowNote>
            另有 {tierFeasible.length - tierSelectable.length} 个物理可行的档位未列出：
            它们的权重还没纳入模型清单，选了也下不到。同一把尺子 —— 不摆点了没作用的选项。
          </RowNote>
        ) : null}

        <Row item={itemOf(inference, 'backend')}>
          {o ? (
            // 与「翻译档位」同一顺序：说明在前、下拉贴最右（两行右边缘对齐）
            <>
              <CtlNote>{`实际生效：${accelLabel(o.accel.effective as EngineAccel)}`}</CtlNote>
              <Select
                label={itemOf(inference, 'backend').label}
                value={accelValue}
                options={o.accel.options.map((x) => ({ value: x.value as EngineAccel, label: x.label }))}
                onChange={(v) => {
                  if (v === accelValue) return;
                  void eng.save({ accel: v });
                }}
              />
            </>
          ) : (
            <ReadOnly>{eng.loadError ? '读取失败' : '读取中…'}</ReadOnly>
          )}
        </Row>
        {/*
          「用户指定的后端本机没有」必须显示出来（服务端为此专门给了 `mismatch`）。
          服务端的写路径会拒绝这种值，所以它只可能来自 env 或手工改过的设置文件 ——
          越是这样越要说清楚，否则用户会以为自己选的 CUDA 真的在跑。
        */}
        {o?.accel.mismatch ? (
          <div className="notice is-bad set-row-note">
            {o.accel.mismatch} —— 已按硬件探测值执行（{o.accel.reason}）
          </div>
        ) : null}

        {/*
         * R3：两个空闲卸载阈值**合成一张卡**。
         *
         * 原来是两行 + 两段 `RowNote`，把"待遇不同"这件事讲了两遍；而两项唯一的区别
         * 就是**何时生效**。合成一卡后，那个区别变成右端两枚对齐的 chip —— 一眼能横着比，
         * 不必读完两段散文再自己比出来。
         *
         * ⚠️ 两项在 catalog 里**各自还在**（`idle-llm` / `idle-vision`）：这是**渲染分组**，
         * 不是合并数据项，项数合计因此不变（动它 C10 会红）。
         * ⚠️ 卡内标题**不用** `<SubTitle>`：② 的「恰 3 个小节」是 C11 逐字盯着的判据，
         * 这里再加一个 `.set-subtitle` 会让那条断言从 3 变 4、彻底失效。
         */}
        <div className="set-idle">
          <div className="set-idle-head">
            <span className="set-idle-name">空闲卸载</span>
            {/*
              两档**共用**这一句「0 = 从不卸载」—— 它是卡片级的说明（排在两个阈值之前），
              而不是某一行的附注。分开在两行各写一遍，正是 R3 要收掉的那份重复。
            */}
            <span className="set-idle-sub">0 = 从不卸载</span>
          </div>

          <div className="set-idle-line">
            <span className="set-idle-k">LLM</span>
            {o ? (
              <NumberInput
                label={itemOf(inference, 'idle-llm').label}
                value={o.idle.llm.min}
                min={0}
                max={IDLE_MIN_MAX}
                suffix="分钟"
                disabled={busy}
                onChange={(v) => void eng.save({ idleLlmMin: v })}
              />
            ) : (
              <ReadOnly>{eng.loadError ? '读取失败' : '读取中…'}</ReadOnly>
            )}
            <span className="set-idle-tag is-now">保存后立刻生效</span>
          </div>

          <div className="set-idle-line">
            <span className="set-idle-k">视觉</span>
            {o ? (
              <NumberInput
                label={itemOf(inference, 'idle-vision').label}
                value={o.idle.vision.min}
                min={0}
                max={IDLE_MIN_MAX}
                suffix="分钟"
                disabled={busy}
                onChange={(v) => void eng.save({ idleVisionMin: v })}
              />
            ) : (
              <ReadOnly>{eng.loadError ? '读取失败' : '读取中…'}</ReadOnly>
            )}
            <span className="set-idle-tag is-restart">需重启引擎</span>
          </div>

          {/*
            两档待遇差异的**共用注解**（原来两段散文各讲一遍）。「必须重启引擎」五个字
            必须留着 —— 它是这两档唯一的区别在界面上的落点。
          */}
          <div className="set-idle-foot">
            LLM 档由 box-service 自己看护（<b>即时</b>）；视觉档由引擎自带的{' '}
            <code>--models-ttl</code> 执行，参数在拉开进程时就固化（<b>必须重启引擎</b>）。
            这是刻意的差别，不是遗漏。
            {o && !o.idle.llm.minIsExact
              ? `（当前 LLM 阈值 ${o.idle.llm.ms} 毫秒 —— 不是整分钟，界面显示的是四舍五入后的分钟数，由环境变量覆盖所致）`
              : ''}
          </div>
        </div>

        <RestartHint title="推理引擎" keys={['翻译档位', '加速后端', '空闲卸载视觉']} pending={pending} />
      </div>

      {/* 小节三：模型与诊断（3） */}
      <div className="set-group">
        <SubTitle>模型与诊断</SubTitle>

        <Row item={itemOf(model, 'model-dir')}>
          {o ? (
            <>
              <ReadOnly title={o.modelDir.current}>{o.modelDir.current}</ReadOnly>
              <Btn
                size="sm"
                // 路径不存在时禁用并说明原因（`open_path` 会先判 exists，点了只会报错）
                disabled={!o.modelDir.exists}
                title={o.modelDir.exists ? '在系统文件管理器里打开模型目录' : '模型目录当前不存在'}
                onClick={() => {
                  openPath(o.modelDir.current).catch((e: unknown) => onToast(errorText(e), 'bad'));
                }}
              >
                打开
              </Btn>
            </>
          ) : (
            <ReadOnly>{eng.loadError ? '读取失败' : '读取中…'}</ReadOnly>
          )}
        </Row>
        {o ? (
          <RowNote>
            默认位置 <code>{o.modelDir.defaultDir}</code>；本值来自
            {o.modelDir.source === 'env' ? '环境变量（压过设置文件）' : o.modelDir.source === 'file' ? '设置文件' : '默认值'}。
            {o.modelDir.configured && o.modelDir.configured !== o.modelDir.current
              ? ` 已配置 ${o.modelDir.configured}，但服务当前仍在用上面这个目录 —— 需重启才切换。`
              : ''}
          </RowNote>
        ) : null}

        {/* 通栏块（catalog 里 layout:'block'）：校验结果是清单，塞不进右列 */}
        <ModelManageBlock item={itemOf(model, 'model-manage')} eng={eng} />

        {/*
          通栏块：诊断面板（《09》§6.2）。
          **默认折叠**（方案 B，2026-10-07 拍板，替代《02》§10-2 原先的"不折叠"）：
          展开态 170~500px 会把上面三小节的标题与控件顶出首屏。收起后摘要行仍给
          三枚进程 chip —— 「是没起来 / 在准备 / 还是在跑但没预热」不点开就看得见。
        */}
        <EngineDiag item={itemOf(model, 'engine-diag')} eng={eng} service={status} onToast={onToast} />
      </div>
    </>
  );
}

/**
 * 「改完要重启引擎」的提示条（《09》§4.3 末句）。
 *
 * 两个状态，刻意分开说：
 *   · 常态 —— 陈述这一类键**改了要重启**（用户动手前就该知道）；
 *   · `pending` 非空 —— 已经存了、但引擎还在按旧值跑。这时要指名道姓地说出是哪几项，
 *     否则用户看到"需重启才生效"会以为系统在提醒他"待会儿记得重启"，
 *     而事实是**他现在就该重启**，否则刚才那次保存白改。
 */
function RestartHint({ title, keys, pending }: { title: string; keys: string[]; pending: string[] }) {
  const hit = keys.filter((k) => pending.includes(k));
  return (
    <div className={hit.length ? 'set-hint is-pending' : 'set-hint'}>
      <b>{title}</b>：改 {keys.join(' / ')} 需<b>重启引擎</b>才生效 ——
      这些值在拉开引擎进程时就定下了。
      {hit.length ? (
        <>
          <br />
          已保存、尚未生效：<b>{hit.join('、')}</b>。现在重启即生效。
        </>
      ) : null}
    </div>
  );
}

/**
 * 哪些「要重启才生效」的键**已经存了但还没生效**（《09》§4.3）。
 *
 * ⚠️ 「空闲卸载视觉」**判不出来**，这里刻意不猜：`options.idle.vision` 报的是
 * **现读盘**的已配置值，而引擎实际用的那个 `--models-ttl` 没有任何接口报出来
 * （它是拉开进程时的参数，引擎没把「我现在用的 ttl 是多少」暴露出来）。
 * 猜错的代价比不猜大：界面若说"这项过期了"而其实没有，用户会去点重启 ——
 * 一次几十秒的冷启动，为的是一件并不存在的问题。
 */
function pendingRestart(o: EngineOptions | null): string[] {
  if (!o) return [];
  const out: string[] = [];
  if (o.tier.configured && o.tier.effective && o.tier.configured !== o.tier.effective) out.push('翻译档位');
  // `choice` 是"用户选的"，`effective` 是"实际跑的"；硬件探测（auto）之外的不一致就是没生效
  if (o.accel.choice !== 'auto' && o.accel.choice !== o.accel.effective) out.push('加速后端');
  if (o.modelDir.configured && o.modelDir.configured !== o.modelDir.current) out.push('模型目录');
  return out;
}

/** 档位的中文名（catalog 用 Tiny/Small/Medium 的写法，这里只做一处映射，不散落字面量） */
const TIER_LABEL: Record<EngineTier, string> = { tiny: 'Tiny', small: 'Small', medium: 'Medium' };

/** 空闲卸载阈值的上限（与服务端 `IDLE_MIN_MAX` 同值：24h；再大就不像"空闲卸载"而像输错了） */
const IDLE_MIN_MAX = 1440;


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
        return (
          <Switch on={dynamicEnabled} onToggle={() => setDynamicEnabled(!dynamicEnabled)} label={item.label} />
        );
      case 'disc-mode':
        return <Switch on={discMode} onToggle={() => setDiscMode(!discMode)} label={item.label} />;
      case 'music-cache':
        // 四格块，自身带标题/说明/统计/按钮，所以不需要 Row 的标题列
        // （`Group` 见到 layout:'block' 也不会包 Row，见 Group 里的注释）
        return <CacheBlock />;
      case 'lyrics-mode':
        return (
          <Select
            label={item.label}
            value={lyricsMode}
            options={LYRICS_MODE_OPTIONS}
            onChange={setLyricsMode}
          />
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
              title={
                lyricsWindowOpen
                  ? `下次打开桌面歌词时${lyricsLocked ? '解锁' : '锁定'}`
                  : '请先开启桌面歌词窗口'
              }
              onClick={() => {
                const next = !lyricsLocked;
                writeLyricsLocked(next);
                setLyricsLockedState(next);
              }}
            >
              {lyricsLocked ? '切到解锁' : '切到锁定'}
            </Btn>
            <CtlNote>
              {lyricsWindowOpen
                ? '改动会在下次打开桌面歌词时生效（也可在歌词窗上双击直接切换）'
                : '先开启桌面歌词窗口'}
            </CtlNote>
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
      <GroupNote summary={MEDIA.noteSummary}>{MEDIA.note as string}</GroupNote>
      {/* 按 catalog 的 groups 顺序渲染三小节：写死第一组会静默漏掉「歌词 / 透明彩胶」 */}
      {MEDIA.groups.map((g) => (
        <Group key={g.id} group={g} render={render} />
      ))}
    </>
  );
}

/**
 * ④ 资源与投放 —— 2 项。
 *
 * live：存储占用（三行分列，**不合计**）· pending：临时文件（等服务侧两条接口）。
 *
 * `render` 用 `switch` 而不是"给谁都渲染同一个块"：将来这一组再加一个 live 项时，
 * 忘记接线会**抛错**，而不是静默渲染成一块长得像那么回事的东西。
 */
export function ResourceSection({ lib }: { lib: LibraryResponse | null }) {
  const render = (item: SettingItem) => {
    switch (item.id) {
      case 'storage-usage':
        return <StorageBlock item={item} lib={lib} />;
      default:
        throw new Error(`[settings] ④ 资源与投放 有未接线的项：${item.id} —— catalog 与本组件不同步`);
    }
  };
  return (
    <>
      <GroupNote summary={RESOURCE.noteSummary}>{RESOURCE.note as string}</GroupNote>
      <Group group={RESOURCE.groups[0]} render={render} />
    </>
  );
}

/**
 * ⑤ 关于 —— 3 项。
 *
 * live：版本号（Tauri `getVersion()`）· 第三方许可（枚举清单，台账 D-84）
 * pending：开源反馈（缺一个真实可打开的仓库地址）
 *
 * 版本号取 Tauri 的 `getVersion()`（构建时的真实版本），不是手写常量。
 * 拿不到就明说"读取失败"，**不退回硬编码字符串** —— 一个与实际构建无关的
 * 版本号比没有版本号更糟：它会让人以为看的是当前这个包。
 *
 * 本组与①通用一样**手工渲染**（不用 `Group`）：版本号那一行下面要跟一条条件附注，
 * 而"附注紧跟它所属的那一行"这件事只有手写位置才能保证。
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
      <GroupNote summary={ABOUT.noteSummary}>{ABOUT.note as string}</GroupNote>
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
        {/* 原先这里还有一行「检查更新」—— 该项目已整条删除（缺的是更新源这个外部事实，
            且托盘上从来没有这一项）。留着它会让本组在渲染时直接抛错：`itemOf` 找不到项就
            抛 —— 那道守卫是对的，错的是没跟着删的这行引用。 */}
        <LicensesBlock item={itemOf(g, 'licenses')} />
        <PendingRow item={itemOf(g, 'oss-feedback')} />
      </div>
    </>
  );
}
