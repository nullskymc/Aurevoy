import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { TaskArtifact } from "@aurevoy/shared";
import type { PlatformAdapter } from "../platform/types";
import type { ContextMenuItem } from "./ContextMenu";
import { IconAlignLeft, IconCopy, IconExternal, IconFile, IconFolder } from "../icons";

export interface ContextMenuState {
  open: boolean;
  point?: { x: number; y: number };
  items: ContextMenuItem[];
}

export function contextMenuPoint(event: ReactMouseEvent): { x: number; y: number } {
  return { x: event.clientX, y: event.clientY };
}

export function copyTextItem(id: string, label: string, text: string, icon?: ReactNode): ContextMenuItem {
  return {
    type: "item",
    id,
    label,
    icon,
    disabled: text.length === 0,
    action: () => {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    },
  };
}

export function buildFileMenuItems({
  path,
  name,
  platform,
  openLabel = "用默认 App 打开",
  revealLabel = "在 Finder 中显示",
}: {
  path: string;
  name?: string;
  platform: PlatformAdapter;
  openLabel?: string;
  revealLabel?: string;
}): ContextMenuItem[] {
  const filename = name || basename(path);
  return compactMenu([
    platform.openFile
      ? {
          type: "item",
          id: "open-file",
          label: openLabel,
          icon: <MenuIcon name="open" />,
          action: () => {
            void platform.openFile?.(path).catch(() => undefined);
          },
        }
      : null,
    platform.revealFile
      ? {
          type: "item",
          id: "reveal-file",
          label: revealLabel,
          icon: <MenuIcon name="folder" />,
          action: () => {
            void platform.revealFile?.(path).catch(() => undefined);
          },
        }
      : null,
    { type: "separator" },
    copyTextItem("copy-path", "复制路径", path, <MenuIcon name="copy" />),
    copyTextItem("copy-name", "复制名称", filename, <MenuIcon name="text" />),
  ]);
}

export function buildLinkMenuItems({
  url,
  label,
  platform,
}: {
  url: string;
  label?: string;
  platform: PlatformAdapter;
}): ContextMenuItem[] {
  return compactMenu([
    platform.openExternal && isExternalUrl(url)
      ? {
          type: "item",
          id: "open-link",
          label: "在浏览器中打开",
          icon: <MenuIcon name="external" />,
          action: () => {
            void Promise.resolve(platform.openExternal?.(url)).catch(() => undefined);
          },
        }
      : null,
    copyTextItem("copy-link", "复制链接", url, <MenuIcon name="copy" />),
    label && label !== url
      ? copyTextItem("copy-link-text", "复制链接文本", label, <MenuIcon name="text" />)
      : null,
  ]);
}

export function buildArtifactMenuItems({
  artifact,
  platform,
}: {
  artifact: TaskArtifact;
  platform: PlatformAdapter;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    copyTextItem("copy-artifact-name", "复制名称", artifact.name, <MenuIcon name="text" />),
  ];

  if (artifact.type === "url" && isExternalUrl(artifact.content)) {
    items.push({ type: "separator" }, ...buildLinkMenuItems({ url: artifact.content, label: artifact.name, platform }));
  } else if (artifact.appliedPath) {
    items.push({ type: "separator" }, ...buildFileMenuItems({ path: artifact.appliedPath, name: artifact.name, platform }));
  }

  if (artifact.content) {
    items.push({ type: "separator" }, copyTextItem("copy-artifact-content", "复制内容", artifact.content, <MenuIcon name="copy" />));
  }

  return compactMenu(items);
}

export function buildTextMenuItems({
  text,
  copyLabel = "复制内容",
}: {
  text: string;
  copyLabel?: string;
}): ContextMenuItem[] {
  const selection = window.getSelection()?.toString().trim() ?? "";
  return compactMenu([
    selection
      ? copyTextItem("copy-selection", "复制选中文本", selection, <MenuIcon name="copy" />)
      : null,
    selection ? { type: "separator" } : null,
    copyTextItem("copy-text", copyLabel, text, <MenuIcon name="copy" />),
  ]);
}

export function linkFromEventTarget(target: EventTarget | null): { url: string; label: string } | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return null;
  return {
    url: anchor.href || anchor.getAttribute("href") || "",
    label: anchor.textContent?.trim() || anchor.getAttribute("href") || "",
  };
}

export function isExternalUrl(value: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(value.trim());
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}

function compactMenu(items: Array<ContextMenuItem | null | false | undefined>): ContextMenuItem[] {
  const compacted: ContextMenuItem[] = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === "separator") {
      if (compacted.length === 0 || compacted[compacted.length - 1]?.type === "separator") continue;
    }
    compacted.push(item);
  }
  while (compacted[compacted.length - 1]?.type === "separator") compacted.pop();
  return compacted;
}

function MenuIcon({ name }: { name: "copy" | "external" | "folder" | "open" | "text" }) {
  const size = 14;
  if (name === "copy") return <IconCopy size={size} />;
  if (name === "external") return <IconExternal size={size} />;
  if (name === "folder") return <IconFolder size={size} />;
  if (name === "open") return <IconFile size={size} />;
  return <IconAlignLeft size={size} />;
}
