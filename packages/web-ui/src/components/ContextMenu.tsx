import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  | { type: "separator" }
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

interface MenuPosition {
  left: number;
  top: number;
}

/** 以鼠标坐标为首选位置；空间不足时翻转并限制在可视区域内。 */
function calculatePosition(
  point: { x: number; y: number },
  menu: DOMRect,
  margin: number,
): MenuPosition {
  const preferredTop = point.y + 4;
  const left = Math.max(margin, Math.min(point.x, window.innerWidth - menu.width - margin));
  const top = preferredTop + menu.height <= window.innerHeight - margin
    ? preferredTop
    : Math.max(margin, point.y - menu.height - 4);
  return { left, top };
}

/**
 * 以虚拟触发点承接历史的「右键后再打开」调用方式。
 * Radix 负责焦点陷阱、键盘导航、子菜单和视口避让，调用方无需绑定真实 Trigger。
 */
export function ContextMenu({
  items,
  open,
  onClose,
  anchorRect,
  anchorPoint,
  label,
  margin = 8,
}: ContextMenuProps) {
  const point = anchorPoint ?? (anchorRect
    ? { x: anchorRect.left, y: anchorRect.bottom }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [anchor, setAnchor] = useState(point);
  const [positionReady, setPositionReady] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 先提交虚拟锚点的新坐标，再打开浮层。否则 Radix 可能读取到上一轮的锚点，
  // 在 attach_content 等快速更新的内容块上表现为菜单偏移。
  useLayoutEffect(() => {
    if (!open) {
      setPositionReady(false);
      return;
    }
    setPositionReady(false);
    setAnchor(point);
  }, [open, point.x, point.y]);

  useLayoutEffect(() => {
    if (open) setPositionReady(true);
  }, [anchor.x, anchor.y, open]);

  // DropdownMenu 的浮层参考点来自 Trigger；右键菜单没有真实的点击 Trigger。
  // 因此用实际内容尺寸计算最终坐标，并覆盖外层 Popper 包装器的位置。
  useLayoutEffect(() => {
    if (!open || !positionReady || !contentRef.current) {
      setPosition(null);
      return;
    }
    setPosition(calculatePosition(point, contentRef.current.getBoundingClientRect(), margin));
  }, [margin, open, point.x, point.y, positionReady]);

  useLayoutEffect(() => {
    if (!position || !contentRef.current) return;
    const wrapper = contentRef.current.closest("[data-radix-popper-content-wrapper]");
    if (!(wrapper instanceof HTMLElement)) return;
    wrapper.style.setProperty("--ctx-menu-left", `${position.left}px`);
    wrapper.style.setProperty("--ctx-menu-top", `${position.top}px`);
  }, [position]);

  return (
    <RadixMenu.Root open={open && positionReady} onOpenChange={(nextOpen) => !nextOpen && onClose()} modal={false}>
      <RadixMenu.Trigger asChild>
        <span
          key={`${anchor.x}-${anchor.y}`}
          aria-hidden="true"
          style={{ position: "fixed", left: anchor.x, top: anchor.y, width: 1, height: 1, pointerEvents: "none" }}
        />
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          ref={contentRef}
          className="ctx-menu ctx-menu-root"
          data-manual-position={position ? "true" : undefined}
          aria-label={label}
          sideOffset={4}
          collisionPadding={margin}
        >
          {items.map((item, index) => <MenuEntry key={item.type === "separator" ? `separator-${index}` : item.id} item={item} />)}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/** 递归渲染菜单项，业务菜单仍仅需传递声明式数据。 */
function MenuEntry({ item }: { item: ContextMenuItem }) {
  if (item.type === "separator") return <RadixMenu.Separator className="ctx-separator" />;

  if (item.type === "submenu") {
    return (
      <RadixMenu.Sub>
        <RadixMenu.SubTrigger className="ctx-item" disabled={item.disabled}>
          {item.icon && <span className="ctx-item-icon">{item.icon}</span>}
          <span className="ctx-item-label">{item.label}</span>
          <span className="ctx-submenu-arrow" aria-hidden="true">▶</span>
        </RadixMenu.SubTrigger>
        <RadixMenu.Portal>
          <RadixMenu.SubContent className="ctx-menu" sideOffset={4} collisionPadding={8}>
            {item.items.map((entry, index) => <MenuEntry key={entry.type === "separator" ? `separator-${index}` : entry.id} item={entry} />)}
          </RadixMenu.SubContent>
        </RadixMenu.Portal>
      </RadixMenu.Sub>
    );
  }

  return (
    <RadixMenu.Item
      className="ctx-item"
      data-ctx-danger={String(item.danger ?? false)}
      disabled={item.disabled}
      onSelect={item.action}
    >
      {item.icon && <span className="ctx-item-icon">{item.icon}</span>}
      <span className="ctx-item-label">{item.label}</span>
      {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
    </RadixMenu.Item>
  );
}
