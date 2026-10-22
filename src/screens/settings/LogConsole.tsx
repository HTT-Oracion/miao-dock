import { useCallback, useState } from 'react';
import { Copy, Download, RefreshCw } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { Btn, SideDrawer } from '@components/units';
import { errorText, serviceStatus, writeTextFile } from '@/ipc';
import { toastBus } from '@/stores/toastBus';

/** 抽屉里一次展示的行数（设计稿副标题「最近 40 行」） */
const VISIBLE_LINES = 40;

/**
 * 运行日志抽屉 —— 设计稿工具条上的「运行日志」按钮打开的正是它。
 *
 * ## 数据面：本地服务自己的输出，不是引擎阶段日志
 *
 * 副标题写「来自 mangasvc」是有意的：引擎诊断卡里那份是**引擎**的 `recentStageLog`
 * （翻译阶段），这里要的是**服务**进程的 stdout（谁起来了、哪个端口、哪次请求失败）。
 * 两者混成一份会让"日志"这个词失去所指 —— 排障时第一步要分的恰恰是这两层。
 *
 * ## 三个动作各自都要有可见回执
 *
 * 复制 / 导出 / 刷新在浏览器里都可以"静默成功"，用户点完没有任何变化就会怀疑按钮坏了。
 * 所以每个动作都给一条两级轻提示（设计稿口径）：
 * 标题说发生了什么，说明行补"这意味着什么"。
 *
 * 导出走 Tauri 的保存对话框而不是 `a[download]`：WebView 里后者会静默落进下载目录，
 * 用户既不知道文件在哪，也拿不到"取消"这个选项。
 */
export function LogConsole({ log, onClose }: { log: string[]; onClose: () => void }) {
  /*
   * 抽屉**按需挂载**（`App` 里 `logsOpen ? <LogConsole/> : null`），所以初始值就取当下的尾巴，
   * 不需要"打开时再同步一次"的 effect —— 那个 effect 会引入一次多余的重渲染，
   * 而且 `open` 为假时它什么也不做，等于把一个生命周期问题藏进了依赖数组。
   */
  const [lines, setLines] = useState<string[]>(() => log.slice(-VISIBLE_LINES));

  const text = lines.join('\n');

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      toastBus.push('日志已复制', 'good', `${lines.length} 行`);
    } catch (e) {
      toastBus.push('复制失败', 'bad', errorText(e));
    }
  }, [lines.length, text]);

  const exportTxt = useCallback(async () => {
    const name = `miaodock-engine-${new Date().toISOString().slice(0, 10)}.log`;
    try {
      const path = await save({ defaultPath: name, filters: [{ name: '日志文件', extensions: ['log', 'txt'] }] });
      // 取消不是错误：save() 给 null 就静默返回
      if (!path) return;
      await writeTextFile(path, text);
      toastBus.push('日志已导出', 'good', name);
    } catch (e) {
      toastBus.push('导出失败', 'bad', errorText(e));
    }
  }, [text]);

  const refresh = useCallback(async () => {
    try {
      const s = await serviceStatus();
      setLines((s.log ?? []).slice(-VISIBLE_LINES));
      toastBus.push('日志已刷新', 'info', '来自本地服务的实时输出');
    } catch (e) {
      toastBus.push('刷新失败', 'bad', errorText(e));
    }
  }, []);

  return (
    <SideDrawer
      kicker="LOCAL ENGINE"
      title="运行日志"
      subtitle={`最近 ${VISIBLE_LINES} 行 · 只读 · 来自 mangasvc`}
      onClose={onClose}
    >
      <div className="set-log-tools">
        <Btn kind="ghost" size="sm" onClick={() => void copyAll()}>
          <Copy size={13} />
          复制全部
        </Btn>
        <Btn kind="ghost" size="sm" onClick={() => void exportTxt()}>
          <Download size={13} />
          导出 .txt
        </Btn>
        <Btn kind="ghost" size="sm" onClick={() => void refresh()}>
          <RefreshCw size={13} />
          刷新
        </Btn>
        <span className="set-log-count chip">{lines.length} 行</span>
      </div>

      {lines.length ? (
        <pre className="set-log-console">{text}</pre>
      ) : (
        /* 空态：服务没起来时确实没有输出，这不是错误，也不该留一块空黑框 */
        <div className="set-log-empty">本地服务还没有输出日志。</div>
      )}
    </SideDrawer>
  );
}
