import { useEffect, useRef } from "react";

export type GlobalShortcut = "search" | "new-task" | "settings";

/**
 * 允许在单测中构造最小键盘事件，避免把快捷键判定和浏览器事件对象绑死。
 */
export interface ShortcutEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * 解析应用级快捷键。
 * 不接管输入法合成、带 Alt/Shift 的组合或已经被更上层组件消费的事件。
 */
export function resolveGlobalShortcut(event: ShortcutEventLike): GlobalShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.key === "Process") return null;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;

  const key = event.key.toLowerCase();
  if (key === "k") return "search";
  if (key === "n") return "new-task";
  if (key === "," || event.code === "Comma") return "settings";
  return null;
}

interface GlobalShortcutOptions {
  /** 搜索弹窗打开时，N 等组合由弹窗自己的推荐动作处理，避免一次按键创建两条任务。 */
  searchOpen: boolean;
  onToggleSearch: () => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
}

/**
 * 注册一次全局键盘监听；回调通过 ref 更新，避免 App 的高频状态变化反复解绑监听器。
 */
export function useGlobalShortcuts(options: GlobalShortcutOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const shortcut = resolveGlobalShortcut(event);
      if (!shortcut) return;

      const current = optionsRef.current;
      // SearchPopover 已注册了 Cmd/Ctrl+N 推荐动作；其它全局快捷键仍可关闭弹窗并切换上下文。
      if (current.searchOpen && shortcut === "new-task") return;

      event.preventDefault();
      if (shortcut === "search") {
        current.onToggleSearch();
      } else if (shortcut === "new-task") {
        current.onNewTask();
      } else {
        current.onOpenSettings();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
