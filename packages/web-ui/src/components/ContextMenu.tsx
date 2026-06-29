import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type ContextMenuItem =
  | {
      type: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      action: () => void;
    }
  | {
      type: "separator";
    }
  | {
      type: "submenu";
      id: string;
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      items: ContextMenuItem[];
    };

export interface ContextMenuProps {
  items: ContextMenuItem[];
  open: boolean;
  onClose: () => void;
  anchorRect?: DOMRect;
  anchorPoint?: { x: number; y: number };
  label?: string;
  margin?: number;
}

/* ------------------------------------------------------------------ */
/*  Position helpers                                                  */
/* ------------------------------------------------------------------ */

interface MenuPosition {
  left: number;
  top: number;
}

const GAP = 4;

function computePosition(
  anchorRect: DOMRect | undefined,
  anchorPoint: { x: number; y: number } | undefined,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number,
): MenuPosition {
  let anchorLeft: number;
  let anchorTop: number;
  let anchorRight: number;
  let anchorBottom: number;

  if (anchorRect) {
    anchorLeft = anchorRect.left;
    anchorTop = anchorRect.top;
    anchorRight = anchorRect.right;
    anchorBottom = anchorRect.bottom;
  } else if (anchorPoint) {
    anchorLeft = anchorPoint.x;
    anchorTop = anchorPoint.y;
    anchorRight = anchorPoint.x;
    anchorBottom = anchorPoint.y;
  } else {
    // Fallback: center of viewport
    anchorLeft = viewportWidth / 2;
    anchorTop = viewportHeight / 2;
    anchorRight = anchorLeft;
    anchorBottom = anchorTop;
  }

  // Preferred: open below, aligned to anchor left edge
  let left = anchorLeft;
  let top = anchorBottom + GAP;

  // Flip vertically if not enough room below
  if (top + menuHeight > viewportHeight - margin) {
    top = anchorTop - menuHeight - GAP;
  }

  // Flip horizontally if not enough room to the right
  if (left + menuWidth > viewportWidth - margin) {
    left = anchorRight - menuWidth;
  }

  // Clamp within viewport
  left = Math.max(margin, Math.min(left, viewportWidth - menuWidth - margin));
  top = Math.max(margin, Math.min(top, viewportHeight - menuHeight - margin));

  return { left, top };
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function ContextMenu({
  items,
  open,
  onClose,
  anchorRect,
  anchorPoint,
  label,
  margin = 8,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const [measured, setMeasured] = useState(false);

  /* ---- Measure & position ---- */
  useLayoutEffect(() => {
    if (!open || !menuRef.current) {
      setMeasured(false);
      setPos(null);
      return;
    }

    const menu = menuRef.current;
    // Force layout so we measure the real size
    const rect = menu.getBoundingClientRect();
    const computed = computePosition(
      anchorRect,
      anchorPoint,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
      margin,
    );
    setPos(computed);
    setMeasured(true);
  }, [open, anchorRect, anchorPoint, margin]);

  /* ---- Dismissal events ---- */
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
    }

    function handleScroll(): void {
      onClose();
    }

    function handleResize(): void {
      // Re-measure on next render
      setMeasured(false);
    }

    // Suppress native context menu while ours is open
    function handleContextMenu(e: Event): void {
      e.preventDefault();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, { capture: true });
    window.addEventListener("resize", handleResize);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, { capture: true });
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [open, onClose]);

  /* ---- Focus first item on open ---- */
  useEffect(() => {
    if (!open || !menuRef.current) return;
    // Small delay so the menu is rendered and visible
    const raf = requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector(
        '[data-ctx-item]:not([disabled])',
      ) as HTMLElement | null;
      first?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /* ---- Keyboard navigation ---- */
  const handleMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const container = menuRef.current;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll('[data-ctx-item]:not([disabled])'),
      ) as HTMLElement[];

      if (focusable.length === 0) return;

      const currentIdx = focusable.indexOf(document.activeElement as HTMLElement);

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = currentIdx < 0 ? 0 : (currentIdx + 1) % focusable.length;
          focusable[next]?.focus();
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev =
            currentIdx < 0
              ? focusable.length - 1
              : (currentIdx - 1 + focusable.length) % focusable.length;
          focusable[prev]?.focus();
          break;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          if (currentIdx >= 0) {
            (focusable[currentIdx] as HTMLButtonElement).click();
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          onClose();
          break;
        }
        // ArrowRight / ArrowLeft reserved for submenu navigation (future)
      }
    },
    [onClose],
  );

  /* ---- Render ---- */
  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      data-open={String(measured)}
      role="menu"
      aria-label={label}
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: -9999, top: -9999 }
      }
      onKeyDown={handleMenuKeyDown}
    >
      {items.map((item, idx) => {
        if (item.type === "separator") {
          return <div key={`sep-${idx}`} className="ctx-separator" role="separator" />;
        }

        if (item.type === "submenu") {
          return (
            <button
              key={item.id}
              type="button"
              className="ctx-item"
              data-ctx-item
              data-ctx-submenu
              role="menuitem"
              disabled={item.disabled}
              tabIndex={-1}
            >
              {item.icon && <span className="ctx-item-icon">{item.icon}</span>}
              <span className="ctx-item-label">{item.label}</span>
              <span className="ctx-submenu-arrow" aria-hidden="true">
                ▶
              </span>
            </button>
          );
        }

        // type === "item"
        return (
          <button
            key={item.id}
            type="button"
            className="ctx-item"
            data-ctx-item
            data-ctx-danger={String(item.danger ?? false)}
            role="menuitem"
            disabled={item.disabled}
            tabIndex={-1}
            onClick={() => {
              item.action();
              onClose();
            }}
          >
            {item.icon && <span className="ctx-item-icon">{item.icon}</span>}
            <span className="ctx-item-label">{item.label}</span>
            {item.shortcut && (
              <span className="ctx-shortcut">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
