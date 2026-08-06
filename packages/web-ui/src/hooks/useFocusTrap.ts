import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

/** 返回当前弹层内可用的 tab 目标，过滤显式隐藏节点避免键盘跳入隐藏内容。 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * 为自绘 modal 提供最小可预测的焦点语义：打开时聚焦首个控件，Tab 在内部循环，
 * 关闭时把焦点还给打开前的元素。Radix Dialog 等已有焦点管理的组件无需接入。
 */
export function useFocusTrap<T extends HTMLElement>(open: boolean): RefObject<T | null> {
  const containerRef = useRef<T | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const container = containerRef.current;
    if (!container) return;
    const trapContainer = container;

    const focusFirst = (): void => {
      const first = getFocusableElements(trapContainer)[0];
      if (first) {
        first.focus({ preventScroll: true });
      } else {
        trapContainer.focus({ preventScroll: true });
      }
    };
    focusFirst();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(trapContainer);
      if (focusable.length === 0) {
        event.preventDefault();
        trapContainer.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (active === first || !trapContainer.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !trapContainer.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const restore = restoreFocusRef.current;
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
  }, [open]);

  return containerRef;
}
