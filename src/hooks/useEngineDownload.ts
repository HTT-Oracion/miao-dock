import { useCallback, useState } from 'react';
import { isApiError, serviceStart, serviceStatus } from '@/ipc';
import { downloadEngineModels } from '@screens/settings/engine-api';
import type { ModelDownloadView } from '@screens/settings/engine-api';

/** 服务冷启动最多等 30 秒（真档要解 Python + 起 ②/③，但闸门挡掉时 ① 只需几秒）。 */
const SERVICE_READY_TIMEOUT_MS = 30_000;
const POLL_MS = 500;

/**
 * 确保 ① 服务在运行。
 *
 * 下载端点在 ① 上；服务还在 `starting` 时直接 POST 会得到「本地翻译服务未运行」，
 * 而用户刚点下按钮，看到的会是一条与动作无关的报错。先等它起来再发。
 */
async function ensureServiceRunning(): Promise<void> {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  let started = false;
  while (Date.now() < deadline) {
    const s = await serviceStatus();
    if (s.state === 'running') return;
    if (s.state === 'error') {
      throw new Error(s.last_error ?? '本地服务启动失败，请到设置页查看服务状态');
    }
    if (!started && s.state !== 'starting' && s.state !== 'stopping') {
      await serviceStart();
      started = true;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error('本地服务启动超时（30 秒）—— 请到设置页检查服务状态');
}

export interface StartDownloadResult {
  /** 本次发起的下载视图；`null` = 已有一条在跑（不重复发起） */
  view: ModelDownloadView | null;
  /** 单飞守卫命中：下载已经在进行中，直接去下载页即可 */
  alreadyRunning: boolean;
}

/**
 * 「开始下载」的唯一入口：先确保 ① 在运行，再 POST `/engine/models/download`。
 *
 * `fresh = true` 是「重新下载」（清 `.part`），缺省是首次 / 续传。
 * 单飞守卫（`DOWNLOAD_IN_PROGRESS`）不当错误处理 —— 用户要的是看进度，不是看报错。
 */
export function useEngineDownload() {
  const [busy, setBusy] = useState(false);

  const start = useCallback(async (fresh = false): Promise<StartDownloadResult> => {
    setBusy(true);
    try {
      await ensureServiceRunning();
      const r = await downloadEngineModels(fresh);
      return { view: r.download, alreadyRunning: false };
    } catch (e) {
      if (isApiError(e) && e.code === 'DOWNLOAD_IN_PROGRESS') {
        return { view: null, alreadyRunning: true };
      }
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, start };
}
