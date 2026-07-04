import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { TaskArtifact } from "@aurevoy/shared";
import type { PlatformAdapter } from "../platform/types";
import type { ContextMenuItem } from "./ContextMenu";

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
  if (name === "copy") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="5" y="4" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3 11V3.5A1.5 1.5 0 014.5 2H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "external") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M10 2h4v4M14 2L8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "folder") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 5.2h13v7.3A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V5.2z" stroke="currentColor" strokeWidth="1.2" />
        <path d="M1.5 5.2V4A1.5 1.5 0 013 2.5h3l1.5 1.7h5A1.5 1.5 0 0114 5.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "open") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 2.5h6l4 4v7A1.5 1.5 0 0111.5 15h-7A1.5 1.5 0 013 13.5v-11z" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9 2.5v4h4" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
