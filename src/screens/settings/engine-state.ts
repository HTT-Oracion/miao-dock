import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '@/ipc';
import { useToasts } from '@hooks';
import {
  downloadEngineModels,
  engineOptions,
  engineStatus,
  saveEngineSettings,
  unloadEngineLlm,
  verifyEngineModels,
} from '@screens/settings/engine-api';
import type {
  EngineOptions,
  EngineSettingsPatch,
  EngineStatus,
  ModelsVerifyResult,
} from '@screens/settings/engine-api';

/** 正在跑的动作名（用来禁用按钮、避免同一个人点两遍） */
export type EngineAction = 'save' | 'unload' | 'verify' | 'download';

/**
 * ② 翻译服务「推理引擎 / 模型与诊断」两小节的**唯一数据源**。
 *
 * ## 为什么两份数据都要（`options` 与 `status`）
 * 它们在服务端是**两个不同的视角**，合并会丢掉一件关键的事：
 *   · `options` = **选项清单**（用户能选什么、选完会发生什么、哪些改完要重启）
 *   · `status`  = **体检报告**（此刻进程什么样、下载任务跑到哪了）
 * 最典型的一对是 `options.tier.effective`（引擎**在跑**的档）与 `options.tier.configured`
 * （盘上**存着**的档）：改档位要重启才生效，所以"保存成功"与"已经用上"是两个时刻。
 * 这个区别一旦在数据层被抹掉，界面就只能二选一：显示旧档（用户以为没存上）
 * 或显示新档（用户以为已经在跑 7B 了）。
 *
 * ## 轮询策略：**只在有下载任务时轮询**
 * 下载是唯一一件"会自己往前走、且用户必须看着它走"的事，所以它跑着的时候每 2s 拉一次。
 * 其余时候**不挂后台定时器** —— `/engine/status` 每次都要和引擎握手 + `stat` 一遍模型，
 * 一个看不见的 2s 定时器会让风扇转起来而用户不知道为什么。
 * 想立刻看最新态就用诊断视图里的「刷新」（那是用户明确表达的一次意愿）。
 */
export function useEngineState() {
  // 吐司走**单例总线**（`useToasts` 的 `push` 每次调用各拿一份引用，但推的是同一条队列），
  // 所以本 hook 直接取用即可，无需宿主层层透传 `onToast`。
  const { push: onToast } = useToasts();
  const [options, setOptions] = useState<EngineOptions | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  /** 拉取失败：**如实显示**"读不到"，不退化成一份看起来正常的默认值 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<EngineAction | null>(null);
  /*
   * ⚠️ 名字里带 `Result` 是刻意的：校验**动作**叫 `verifyModels`，校验**结果**叫 `verifyResult`。
   * 早先两者都叫 `verify`，于是 `const verify = useCallback(…)` 与
   * `const [verify, setVerify] = useState(…)` 撞成同一个块级名字 ——
   * 类型检查会红，但如果只在**返回对象**里区分（`verify` / `verifyModels`），
   * 读代码的人（和下一个改它的人）仍然分不清 `eng.verify` 是结果还是函数。
   */
  const [verifyResult, setVerifyResult] = useState<ModelsVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  /**
   * 「组件还在吗」的自取消守卫 —— **由刷新序号 + 一个 ref 组成**。
   *
   * 🔴 `alive.current = true` 这一行不是冗余，它是这个守卫**唯一正确**的写法：
   * React 18 的 `StrictMode`（`main.tsx` 里开着）在开发模式下会把 mount 的 effect 跑两遍 ——
   *   effect₁ → cleanup₁（把 alive 置 false）→ effect₂
   * 而 ref 是**同一个对象**，cleanup₁ 之后再没有任何地方把它置回 `true`。
   * 于是两次 `reload()` 的 promise 都走到下面那句 `if (!alive.current) return`，
   * **数据不落地、错误也不落地** —— 界面永久停在「读取中…」。
   * 服务端实测 1ms 就答完了（`/engine/options` 13ms 首跑、之后 1ms），所以它极容易被
   * 误读成"后端慢 / 还在加载"，而真相是这个守卫自己把结果吞了。
   *
   * ⚠️ 生产构建没有这次双调用，所以它只在 `npm run dev` 与**截图取证**（走 vite dev server）里发作 ——
   * 这正是它一直没被人工发现的原因（S6 的 05 号取证图把它照出来了）。
   * 同一条教训在本仓已有先例：`screens/lyrics/index.ts` 就是为了躲开这次双调用而**刻意不套**
   * `StrictMode`。既然后果这么大，写在文档里不够，`ENGINE.hook.strictModeAliveGuard` 把它钉住。
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([engineOptions(), engineStatus()]);
      if (!alive.current) return;
      setOptions(o);
      setStatus(s);
      setLoadError(null);
    } catch (e) {
      if (!alive.current) return;
      // 🔴 失败时把两份数据都清成 null，而不是留着上一次的旧值：
      //    服务重启/切换的瞬间留着旧值，界面会显示"引擎 running"而事实是服务都连不上。
      setOptions(null);
      setStatus(null);
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 下载跑着的时候轮询；它一停（done/error/idle）就自动收手
  const downloadRunning = status?.modelDownload?.running === true;
  useEffect(() => {
    if (!downloadRunning) return undefined;
    const t = setInterval(() => {
      void reload();
    }, 2000);
    return () => clearInterval(t);
  }, [downloadRunning, reload]);

  /** 保存设置。返回值给调用方判断"这次改了哪一类"（要重启 / 即时生效） */
  const save = useCallback(
    async (patch: EngineSettingsPatch) => {
      setAction('save');
      try {
        const r = await saveEngineSettings(patch);
        await reload();
        if (r.appliedNow.length > 0 && r.restartRequiredKeys.length === 0) {
          onToast('已保存并立即生效', 'good');
        } else if (r.restartRequiredKeys.length > 0) {
          onToast('已保存 —— 需重启引擎后生效', 'info');
        } else {
          onToast('已保存', 'good');
        }
        return r;
      } catch (e) {
        // 服务端的拒绝理由里有"可选什么"（如"可选：tiny / small"），原样透出 ——
        // 换成一句"保存失败"会把用户留在原地。
        onToast(errorText(e), 'bad');
        // 保存失败后也要刷新：服务端的拒绝是因为盘上/硬件的事实，界面得回到事实那一边
        await reload();
        return null;
      } finally {
        setAction(null);
      }
    },
    [onToast, reload],
  );

  const unload = useCallback(async () => {
    setAction('unload');
    try {
      const r = await unloadEngineLlm();
      await reload();
      // `unloaded:false` **不是错误**（空闲卸载是设计行为，《04》§9.4）—— 如实转述它的理由
      if (r.unloaded) onToast('已强制释放 ③（Sakura LLM）；下次翻译时按需重新加载', 'good');
      else onToast(r.reason ?? '③ 当前未在运行，无需释放', 'info');
      return r;
    } catch (e) {
      onToast(errorText(e), 'bad');
      return null;
    } finally {
      setAction(null);
    }
  }, [onToast, reload]);

  const verifyModels = useCallback(async () => {
    setAction('verify');
    setVerifyError(null);
    try {
      const r = await verifyEngineModels();
      setVerifyResult(r);
      // `ok:false` 是"校验完成、发现不符"，**不是操作失败** —— 文案必须体现这个区别，
      // 否则用户会以为"校验这个功能坏了"而不是"我的模型坏了"。
      if (r.ok) onToast(`校验通过：${r.pass}/${r.total} 个文件全部一致`, 'good');
      else
        onToast(
          `校验完成：不符 ${r.bad} · 缺失 ${r.missing}${r.hf.broken ? ` · HF 布局不可解析 ${r.hf.broken}` : ''}（共 ${r.total}）`,
          'bad',
        );
      return r;
    } catch (e) {
      setVerifyResult(null);
      setVerifyError(errorText(e));
      onToast(errorText(e), 'bad');
      return null;
    } finally {
      setAction(null);
    }
  }, [onToast]);

  const download = useCallback(async () => {
    setAction('download');
    try {
      // 续传：「继续下载」—— 沿用 `.part`（fresh=false），补齐已下部分。
      await downloadEngineModels();
      await reload();
      onToast('已开始下载模型 —— 进度见下方「引擎诊断」', 'info');
      return true;
    } catch (e) {
      onToast(errorText(e), 'bad');
      await reload();
      return false;
    } finally {
      setAction(null);
    }
  }, [onToast, reload]);

  /** 「重新下载」：清 `.part` 从头再来（fresh=true）。 */
  const downloadFresh = useCallback(async () => {
    setAction('download');
    try {
      await downloadEngineModels(true);
      await reload();
      onToast('已从头重新下载模型 —— 进度见下方「引擎诊断」', 'info');
      return true;
    } catch (e) {
      onToast(errorText(e), 'bad');
      await reload();
      return false;
    } finally {
      setAction(null);
    }
  }, [onToast, reload]);

  return {
    options,
    status,
    loadError,
    action,
    verifyResult,
    verifyError,
    reload,
    save,
    unload,
    verifyModels,
    download,
    downloadFresh,
  };
}

export type EngineState = ReturnType<typeof useEngineState>;

/** 生效配置快照 → 展示用的键值对（顺序即渲染顺序，与《02》§5 的"生效配置"一致） */
export function configPairs(cfg: EngineStatus['config'] | undefined): { k: string; v: string }[] {
  if (!cfg) return [];
  return [
    { k: '翻译器', v: cfg.translator },
    // `null` = 基线没钉源语言 ⇒ 真正生效的方向是**逐任务**下的（ver2.1）。
    // 显示成空白会让人以为"没配"，必须把这句语义写出来。
    { k: '源语言', v: cfg.fromLang ?? '按任务方向' },
    { k: '目标语言', v: cfg.targetLang },
    { k: '检测器', v: cfg.detector },
    // `null` 必须显示成"未下发"而不是一个数字：我们**不下发**它时引擎用自己的默认值，
    // 显示成 2048 就等于把当前默认值钉死在这个标签上（上游改了我们也不知道）。
    { k: '检测尺寸', v: cfg.detectionSize === null ? '未下发（用引擎默认）' : String(cfg.detectionSize) },
    { k: 'OCR', v: cfg.ocr },
    { k: '抹字', v: cfg.inpainter },
  ];
}
