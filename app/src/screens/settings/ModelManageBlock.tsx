import { Btn, Notice } from '@components/units';
import { emphasis, humanBytes } from '@screens/settings/parts';
import type { SettingItem } from '@screens/settings/catalog';
import type { EngineState } from '@screens/settings/engine-state';

/**
 * ② 翻译服务 ·「模型管理」项的**通栏块**（《02》§5：两个动作 + L2 的补救入口）。
 *
 * ## 为什么它也不能塞进 `Row` 的右列
 * 两个动作（校验完整性 / 重新下载模型）本身放得进窄列，但**校验结果**放不进：
 * 它是一份"哪几个文件不符、哪几个缺失"的清单，短则一行、长则几十行。
 * 塞进右列会被压成一条读不了的细缝 —— 这与「音乐缓存」当初脱离 `Row` 是同一个理由，
 * 所以 catalog 里给它标 `layout: 'block'`（那个字段的注释写明了这条判据）。
 *
 * ## 为什么"校验完成但发现不符"必须与"校验失败"分开显示
 * `POST /engine/models/verify` 的 `ok:false` 表示**调用成功、但模型有问题**
 * （服务端刻意不用 4xx/5xx 表达它）。若界面把两者都渲染成红色的"操作失败"，
 * 用户会去查网络与权限，而真正该做的是点「重新下载模型」。
 */
export function ModelManageBlock({ item, eng }: { item: SettingItem; eng: EngineState }) {
  const v = eng.verifyResult;
  const busy = eng.action !== null;
  const download = eng.status?.modelDownload;
  /** D4：盘上实况（服务端算好的：按 inode 去重、只算就绪条目） */
  const disk = eng.status?.models?.disk;
  /** 适用本机的条目数 —— 与「引擎诊断」的逐条清单**同一份判据**（服务端给的 `applicable`） */
  const mineTotal = eng.status?.models?.files?.filter((f) => f.applicable).length ?? 0;

  /*
   * 只列前 8 条不符/缺失：一份 40 行的清单会把这一项撑成一整屏，
   * 而真正要看全清单的人是少数 —— 给他"还有几条"这个事实，比把页面撑破有用。
   */
  const shown = v?.problems.slice(0, 8) ?? [];
  const rest = (v?.problems.length ?? 0) - shown.length;

  return (
    <div className="set-manage">
      <div className="set-manage-top">
        <div className="set-manage-label">
          <div className="set-manage-name">{item.label}</div>
          {item.why ? <div className="set-manage-why">{emphasis(item.why)}</div> : null}
        </div>
        <div className="set-manage-acts">
          <Btn
            size="sm"
            disabled={busy}
            title="真算一遍每个权重的 SHA256（几 GB，要几分钟）—— 不是「看一眼文件在不在」"
            onClick={() => void eng.verifyModels()}
          >
            校验完整性
          </Btn>
          <Btn
            size="sm"
            disabled={busy || download?.runnerExists === false || download?.running === true}
            title={
              download?.runnerExists === false
                ? '模型下载执行体不在盘上'
                : download?.running
                  ? '已有下载任务在跑（进度见下方引擎诊断）'
                  : '补齐缺失与校验不符的权重；已就绪的文件会被复用'
            }
            onClick={() => void eng.download()}
          >
            重新下载模型
          </Btn>
        </div>
      </div>

      {/*
        D4：**运行时实况**一行。
        这一项原本只能"点一次校验才知道"，用户想第一眼看到"装了什么、占了多少盘、
        什么时候落的"却没有地方看 —— 而这三个问题恰恰是决定"要不要点重新下载"的依据。

        🔴 三个数与措辞全部来自服务端 `models.disk`（它自己按 inode 去重、只算就绪条目），
           这里**不自己遍历、不自己求和**，只做单位换算。
      */}
      <div className="set-manage-state">
        {disk ? (
          <>
            已就绪 <b>{disk.readyEntries}</b> / {mineTotal} 条适用条目 · 模型资产占盘{' '}
            <b>{humanBytes(disk.bytes)}</b>
            {disk.assembledAt ? <> · 最近一次落盘 {disk.assembledAt}</> : <> · 尚无就绪条目</>}
          </>
        ) : (
          <>运行时状态还没取到（服务未启动时这一行只能空着，不编数字）</>
        )}
      </div>

      {eng.verifyError ? (
        <Notice kind="bad" className="set-manage-state">校验失败：{eng.verifyError}</Notice>
      ) : v ? (
        <>
          <div className={v.ok ? 'set-manage-state' : 'set-manage-state is-bad'}>
            {v.ok
              ? `校验通过：${v.pass} / ${v.total} 个文件与清单一致（用时 ${(v.elapsedMs / 1000).toFixed(1)}s）`
              : `校验完成：不符 ${v.bad} · 缺失 ${v.missing}${v.hf.broken ? ` · HF 布局不可解析 ${v.hf.broken}` : ''}（共 ${v.total}）—— 点「重新下载模型」补齐`}
          </div>
          {shown.length > 0 ? (
            <div className="set-manage-list">
              {shown.map((p) => (
                <div key={p} className="set-manage-list-line">{p}</div>
              ))}
              {rest > 0 ? <div className="set-manage-list-line">…还有 {rest} 条</div> : null}
            </div>
          ) : null}
        </>
      ) : download?.running ? (
        <div className="set-manage-state">正在重新下载模型 —— 进度与输出见下方「引擎诊断」。</div>
      ) : (
        <div className="set-manage-state">
          本次会话尚未校验。校验会逐个重算 SHA256，因此<b>不挂自动</b>
        </div>
      )}
    </div>
  );
}
