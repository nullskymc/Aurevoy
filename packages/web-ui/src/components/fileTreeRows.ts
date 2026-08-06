import type { WorkspaceReadEntry } from "@aurevoy/shared";

/**
 * 文件树节点只暴露渲染所需的只读字段，避免虚拟列表依赖 hook 的实现细节。
 */
export interface FileTreeNodeView {
  entries: WorkspaceReadEntry[];
  open: boolean;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  next?: number;
}

export type FileTreeRowModel =
  | { kind: "entry"; entry: WorkspaceReadEntry; depth: number }
  | {
      kind: "message";
      path: string;
      depth: number;
      status: "loading" | "error" | "truncated" | "load-more";
      message?: string;
    };

/**
 * 将已展开的树压平成虚拟列表需要的可见行。
 * 目录仍按原有顺序递归，筛选只作用于当前已加载页，避免扫描工作区或阻塞流式对话。
 */
export function buildVisibleFileTreeRows(
  nodes: Record<string, FileTreeNodeView>,
  filter: string,
): FileTreeRowModel[] {
  const rows: FileTreeRowModel[] = [];
  const normalizedFilter = filter.trim().toLowerCase();

  const visit = (path: string, depth: number): void => {
    const node = nodes[path];
    if (!node) {
      rows.push({ kind: "message", path, depth, status: "loading" });
      return;
    }
    if (node.error && node.entries.length === 0) {
      rows.push({ kind: "message", path, depth, status: "error", message: node.error });
      return;
    }
    if (node.loading && node.entries.length === 0) {
      rows.push({ kind: "message", path, depth, status: "loading" });
      return;
    }

    const entries = normalizedFilter
      ? node.entries.filter(
          (entry) =>
            entry.name.toLowerCase().includes(normalizedFilter) ||
            entry.path.toLowerCase().includes(normalizedFilter),
        )
      : node.entries;

    for (const entry of entries) {
      rows.push({ kind: "entry", entry, depth });
      if (entry.type === "directory" && nodes[entry.path]?.open) {
        visit(entry.path, depth + 1);
      }
    }

    if (node.error) {
      rows.push({ kind: "message", path, depth: depth + 1, status: "error", message: node.error });
    }
    if (node.truncated) {
      rows.push({
        kind: "message",
        path,
        depth: depth + 1,
        status: node.next !== undefined ? "load-more" : "truncated",
      });
    }
  };

  visit(".", 0);
  return rows;
}
