import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import type { WorkspaceReadEntry } from "@aurevoy/shared";
import type { useFileTree } from "../hooks/useFileTree";
import { buildVisibleFileTreeRows, type FileTreeRowModel } from "./fileTreeRows";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { contextMenuPoint, type ContextMenuState } from "./contextMenuActions";
import { deleteWorkspacePath, renameWorkspacePath } from "../api";
import { IconHideTree, IconRefresh } from "./workbenchIcons";
import { t } from "../i18n";

type FileTreeState = ReturnType<typeof useFileTree>;
type FileTreeVirtualizer = Virtualizer<HTMLDivElement, Element>;

const FILE_TREE_ROW_ESTIMATE = 30;
const FILE_TREE_OVERSCAN = 12;

interface FileTreeProps {
  tree: FileTreeState;
  taskId?: string;
  projectId?: string;
  /** 当前编辑器打开的工作区路径，用于高亮树节点 */
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onAttachToChat: (entry: WorkspaceReadEntry) => void;
  /** Hide the directory explorer only; does not close open file tabs. */
  onCloseExplorer: () => void;
}

export function FileTree({
  tree,
  taskId,
  projectId,
  selectedPath = null,
  onOpenFile,
  onAttachToChat,
  onCloseExplorer,
}: FileTreeProps) {
  const [filter, setFilter] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  const handleContext = useCallback(
    (event: React.MouseEvent, entry: WorkspaceReadEntry) => {
      event.preventDefault();
      event.stopPropagation();
      const isDir = entry.type === "directory";
      const items: ContextMenuItem[] = [
        {
          type: "item",
          id: "open",
          label: t("workbench.ctxOpen"),
          action: () => (isDir ? tree.toggleDirectory(entry.path) : onOpenFile(entry.path)),
        },
        { type: "separator" },
        {
          type: "item",
          id: "copyPath",
          label: t("workbench.ctxCopyPath"),
          action: () => void navigator.clipboard.writeText(entry.path),
        },
        {
          type: "item",
          id: "copyName",
          label: t("workbench.ctxCopyName"),
          action: () => void navigator.clipboard.writeText(entry.name),
        },
        { type: "separator" },
        {
          type: "item",
          id: "attach",
          label: t("workbench.ctxAttachToChat"),
          action: () => onAttachToChat(entry),
        },
        { type: "separator" },
        {
          type: "item",
          id: "rename",
          label: t("workbench.ctxRename"),
          action: async () => {
            setActionError(null);
            const newName = window.prompt(t("workbench.renamePrompt"), entry.name);
            if (!newName || newName === entry.name) return;
            try {
              await renameWorkspacePath({ path: entry.path, newName, taskId, projectId });
              tree.reloadRoot();
            } catch (err) {
              // 需要用户处理的文件操作错误留在工作台，不打断当前对话。
              setActionError(err instanceof Error ? err.message : String(err));
            }
          },
        },
        {
          type: "item",
          id: "delete",
          label: t("workbench.ctxDelete"),
          danger: true,
          action: async () => {
            if (!window.confirm(t("workbench.deleteConfirm").replace("{name}", entry.name))) return;
            setActionError(null);
            try {
              await deleteWorkspacePath({ path: entry.path, taskId, projectId });
              tree.reloadRoot();
            } catch (err) {
              // 删除失败保持在文件树上下文中，避免 Toast 掩盖具体操作位置。
              setActionError(err instanceof Error ? err.message : String(err));
            }
          },
        },
      ];
      setCtxMenu({ open: true, point: contextMenuPoint(event), items });
    },
    [onOpenFile, onAttachToChat, taskId, projectId, tree],
  );

  const rows = useMemo(
    () => buildVisibleFileTreeRows(tree.nodes, filter),
    [filter, tree.nodes],
  );

  return (
    <div className="file-tree">
      <section className="file-tree-section" data-kind="workspace">
        <div className="file-tree-filter-wrap">
          <div className="file-tree-filter-shell">
            <span className="file-tree-filter-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              className="file-tree-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("workbench.filterFiles")}
            />
          </div>
          <div className="file-tree-section-actions">
            <button
              type="button"
              className="icon-btn-small"
              onClick={tree.reloadRoot}
              aria-label={t("workbench.refresh")}
              title={t("workbench.refresh")}
            >
              <IconRefresh />
            </button>
            <button
              type="button"
              className="icon-btn-small"
              onClick={onCloseExplorer}
              aria-label={t("workbench.hideTree")}
              title={t("workbench.hideTree")}
            >
              <IconHideTree />
            </button>
          </div>
        </div>
        {actionError ? (
          <p className="file-tree-action-error" role="alert">
            {actionError}
          </p>
        ) : null}
        <VirtualFileTreeList
          rows={rows}
          tree={tree}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onContext={handleContext}
        />
      </section>

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        onClose={() => setCtxMenu((s) => ({ ...s, open: false }))}
        anchorPoint={ctxMenu.point}
      />
    </div>
  );
}

/**
 * 文件树采用固定行高估算、真实行高测量和 overscan，目录展开后只挂载视口附近的节点。
 * 虚拟列表仍保留真实 button，因此右键菜单、焦点样式和方向键语义不变。
 */
function VirtualFileTreeList({
  rows,
  tree,
  selectedPath,
  onOpenFile,
  onContext,
}: {
  rows: FileTreeRowModel[];
  tree: FileTreeState;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onContext: (event: React.MouseEvent, entry: WorkspaceReadEntry) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => fileTreeRowKey(rows[index], index),
    estimateSize: () => FILE_TREE_ROW_ESTIMATE,
    overscan: FILE_TREE_OVERSCAN,
    initialRect: { width: 260, height: 500 },
    useAnimationFrameWithResizeObserver: true,
  });

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      handleTreeKeyDown(event, tree, rows, virtualizer, listRef.current);
    },
    [rows, tree, virtualizer],
  );

  return (
    <div
      ref={listRef}
      className="file-tree-list"
      role="tree"
      aria-label={t("workbench.fileTree")}
      onKeyDown={handleKeyDown}
    >
      <div className="file-tree-virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              className="file-tree-virtual-item"
              data-index={virtualRow.index}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.kind === "entry" ? (
                <FileTreeRow
                  entry={row.entry}
                  depth={row.depth}
                  tree={tree}
                  selectedPath={selectedPath}
                  onOpenFile={onOpenFile}
                  onContext={onContext}
                  rowIndex={virtualRow.index}
                  rowCount={rows.length}
                />
              ) : (
                <FileTreeStatusRow row={row} tree={tree} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileTreeRow({
  entry,
  depth,
  tree,
  selectedPath,
  onOpenFile,
  onContext,
  rowIndex,
  rowCount,
}: {
  entry: WorkspaceReadEntry;
  depth: number;
  tree: FileTreeState;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onContext: (event: React.MouseEvent, entry: WorkspaceReadEntry) => void;
  rowIndex: number;
  rowCount: number;
}) {
  const isDirectory = entry.type === "directory";
  const node = tree.nodes[entry.path];
  const selected = !isDirectory && selectedPath != null && pathsEqual(selectedPath, entry.path);
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return (
    <button
      type="button"
      className="file-tree-row"
      role="treeitem"
      data-kind={isDirectory ? "directory" : "file"}
      data-ext={isDirectory ? "dir" : ext}
      data-path={entry.path}
      data-selected={selected ? "true" : undefined}
      aria-expanded={isDirectory ? node?.open === true : undefined}
      aria-posinset={rowIndex + 1}
      aria-setsize={rowCount}
      style={{ "--tree-depth": depth } as CSSProperties}
      onClick={() => (isDirectory ? tree.toggleDirectory(entry.path) : onOpenFile(entry.path))}
      onContextMenu={(e) => onContext(e, entry)}
      title={entry.path}
    >
      <span className="file-tree-chevron" data-open={node?.open === true} aria-hidden="true">
        {isDirectory ? "›" : ""}
      </span>
      <span className="file-tree-icon" aria-hidden="true">
        {iconForEntry(entry)}
      </span>
      <span className="file-tree-name">{entry.name}</span>
    </button>
  );
}

function FileTreeStatusRow({ row, tree }: { row: Extract<FileTreeRowModel, { kind: "message" }>; tree: FileTreeState }) {
  if (row.status === "load-more") {
    const node = tree.nodes[row.path];
    return (
      <button
        type="button"
        className="file-tree-load-more"
        style={{ "--tree-depth": row.depth } as CSSProperties}
        onClick={() => tree.loadMoreDirectory(row.path)}
        disabled={node?.loading === true}
      >
        {node?.loading ? t("workbench.loading") : t("workbench.loadMore")}
      </button>
    );
  }

  return (
    <p
      className={`file-tree-empty${row.status === "error" ? " file-tree-error" : ""}`}
      style={{ "--tree-depth": row.depth } as CSSProperties}
      role={row.status === "error" ? "alert" : "status"}
    >
      {row.status === "error" ? row.message : row.status === "truncated" ? t("workbench.truncated") : t("workbench.loading")}
    </p>
  );
}

/** 虚拟化后方向键可能要先滚动，使用短轮询等候目标 button 挂载，再把焦点交给它。 */
function handleTreeKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  tree: FileTreeState,
  rows: FileTreeRowModel[],
  virtualizer: FileTreeVirtualizer,
  list: HTMLDivElement | null,
): void {
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.classList.contains("file-tree-row")) return;
  const currentIndex = Number(target.closest<HTMLElement>("[data-index]")?.dataset.index);
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return;

  const focusIndex = (index: number): void => {
    if (index < 0 || index >= rows.length) return;
    const selector = `[data-index="${index}"] .file-tree-row`;
    const current = list?.querySelector<HTMLButtonElement>(selector);
    if (current) {
      current.focus();
      return;
    }
    virtualizer.scrollToIndex(index, { align: "auto" });
    let attempts = 0;
    const focusAfterRender = () => {
      const next = list?.querySelector<HTMLButtonElement>(selector);
      if (next) {
        next.focus();
        return;
      }
      if (attempts < 4) {
        attempts += 1;
        requestAnimationFrame(focusAfterRender);
      }
    };
    requestAnimationFrame(focusAfterRender);
  };

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusIndex(event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1);
    return;
  }

  const row = rows[currentIndex];
  if (!row || row.kind !== "entry") return;
  const node = tree.nodes[row.entry.path];
  if (event.key === "ArrowRight" && row.entry.type === "directory") {
    event.preventDefault();
    if (!node?.open) tree.toggleDirectory(row.entry.path);
    else focusIndex(currentIndex + 1);
    return;
  }

  if (event.key === "ArrowLeft") {
    if (row.entry.type === "directory" && node?.open) {
      event.preventDefault();
      tree.toggleDirectory(row.entry.path);
      return;
    }
    const parent = parentTreePath(row.entry.path);
    const parentIndex = rows.findIndex(
      (candidate) => candidate.kind === "entry" && candidate.entry.path === parent,
    );
    if (parentIndex >= 0) {
      event.preventDefault();
      focusIndex(parentIndex);
    }
  }
}

function fileTreeRowKey(row: FileTreeRowModel | undefined, index: number): string {
  if (!row) return `missing:${index}`;
  return row.kind === "entry" ? `entry:${row.entry.path}` : `message:${row.path}:${row.status}`;
}

function parentTreePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "." : normalized.slice(0, separator);
}

function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function iconForEntry(entry: WorkspaceReadEntry): string {
  if (entry.type === "directory") return "";
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (!ext || ext === entry.name) return "·";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "▣";
  if (["md", "mdx"].includes(ext)) return "M";
  if (["ipynb"].includes(ext)) return "⌘";
  if (["json", "yaml", "yml"].includes(ext)) return "{}";
  if (["py"].includes(ext)) return "⌘";
  if (["ts", "tsx", "js", "jsx"].includes(ext)) return "JS";
  if (["rs", "go", "css", "html"].includes(ext)) return "</>";
  return "·";
}
