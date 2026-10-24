import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Btn } from '@components/units/atoms';

/**
 * 日志块（通用单元）—— 深底等宽正文 + **悬停浮现的复制按钮**。
 *
 * ## 为什么抽成单元
 * 引导页（`.nr-log`）与下载页（`.ed-log`）各写过一份"深底 + 等宽 + 可滚动"的块，
 * 两处的底色、圆角、行高、最大高度各不相同 —— 同一件东西两套皮。抽成单元后：
 *  - 底色 / 圆角 / 行高 / 最大高度由 `LogBlock` 一处定义，调用方只给 `variant`；
 *  - **复制能力跟着内容走**：任何显示日志的地方都自动有"复制全部"，不必各写一遍。
 *
 * ## 复制按钮为什么是"悬停才出现"
 * 日志是**只读的现场信息**，复制是次要动作。常驻一枚按钮会与"查看日志 / 收起日志"这类
 * 主操作抢注意力；悬停浮现既保证可发现（鼠标移到日志上就出现），又不占版面。
 * 键盘用户走 `:focus-within` 分支，不做成"只有鼠标能拿到"。
 *
 * ## 为什么按钮只有图标
 * 日志块本身很窄（引导页那处最大高度 94px），塞"复制"两个字会把正文挤窄。
 * 所以按钮只放图标，**语义走 `aria-label` + `title`**（读屏与悬停提示都说得出它是什么）。
 *
 * ## 复制成功为什么要换图标
 * 写剪贴板可能被拒（权限 / 非安全上下文），静默成功与静默失败在界面上长得一模一样。
 * 所以：成功 ⇒ 图标变 ✓ 并保持 1.4s，失败 ⇒ **不换图标**（调用方给吐司说明原因）。
 *
 * ## 🔴 写剪贴板的接缝是**注入**的，不是 import 进来的
 * `units/` 不许 import 业务层或工具层（`PURITY.noBusinessImports` 机器核查），
 * 所以"用宿主插件写剪贴板"这件事不能写在单元里。单元只声明"我需要一个
 * `(text) => Promise<void>`"，由屏层注入 `@tools` 的 `copyText`（桌面走
 * `@tauri-apps/plugin-clipboard-manager`，纯浏览器回退 `navigator.clipboard`）。
 * 缺省同样退回 `navigator.clipboard` —— 单元不因此多一条依赖。
 */
export function LogBlock({
  text,
  /** 版式变体：引导页那处矮（94），下载页那处高（220） */
  variant = 'compact',
  /** 无内容时的占位句（两处都写「（暂无输出）」，抽到这里统一） */
  emptyText = '（暂无输出）',
  /** 复制失败时的回调（由调用方给吐司；单元不引业务层） */
  onCopyError,
  /** 复制成功后的回调（可选；默认只换图标） */
  onCopied,
  /** 写剪贴板的接缝（**注入**，见文件头） */
  copy,
  className,
}: {
  text: string;
  variant?: 'compact' | 'tall';
  emptyText?: string;
  onCopyError?: (e: unknown) => void;
  onCopied?: () => void;
  copy?: (text: string) => Promise<void>;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  // 卸载时清掉定时器：否则"复制完立刻关掉弹层"会对着已卸载的组件 setState
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  const runCopy = useCallback(async () => {
    try {
      if (copy) await copy(text);
      else await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
      onCopied?.();
    } catch (e) {
      onCopyError?.(e);
    }
  }, [text, copy, onCopied, onCopyError]);

  const body = text.trim() ? text : emptyText;

  return (
    <div className={['log-block', `is-${variant}`, className ?? ''].filter(Boolean).join(' ')}>
      {/*
        复制按钮：`kind="bare"` —— 它只借单元保证"是 <button type="button">、有 disabled/title 语义"，
        外观全部由 `.log-copy` 决定（这枚按钮是日志块右上角的一颗 24×24 半透明方块，
        与 `.btn` 的任何一档都不一样）。`ariaLabel` 必填：可见内容只有图标。
      */}
      <Btn
        kind="bare"
        className="log-copy"
        ariaLabel="复制全部日志"
        title="复制全部日志"
        onClick={() => void runCopy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Btn>
      <pre className="log-body">{body}</pre>
    </div>
  );
}
