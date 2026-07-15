import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import type { TaskArtifact, WorkspaceReadEntry } from "@aurevoy/shared";
import { readStoredPaneSize, startPaneResize } from "../app/paneResize";
import type { useFileTree } from "../hooks/useFileTree";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { contextMenuPoint, type ContextMenuState } from "./contextMenuActions";
import { deleteWorkspacePath, renameWorkspacePath } from "../api";
import { IconHideTree, IconRefresh } from "./workbenchIcons";
import { t } from "../i18n";

type FileTreeState = ReturnType<typeof useFileTree>;

const ARTIFACTS_HEIGHT_KEY = "aurevoy.workbenchArtifactsHeight";
const MIN_ARTIFACTS_HEIGHT = 72;
const MAX_ARTIFACTS_HEIGHT = 420;
const DEFAULT_ARTIFACTS_HEIGHT = 88;

interface FileTreeProps {
  tree: FileTreeState;
  taskId?: string;
  projectId?: string;
  artifacts: TaskArtifact[];
  /** 当前编辑器打开的工作区路径，用于高亮树节点 */
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onOpenArtifact: (artifact: TaskArtifact) => void;
  onAttachToChat: (entry: WorkspaceReadEntry) => void;
  /** Hide the directory explorer only; does not close open file tabs. */
  onCloseExplorer: () => void;
}

export function FileTree({
  tree,
  taskId,
  projectId,
  artifacts,
  selectedPath = null,
  onOpenFile,
  onOpenArtifact,
  onAttachToChat,
  onCloseExplorer,
}: FileTreeProps) {
  const [filter, setFilter] = useState("");
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });
  const [artifactsHeight, setArtifactsHeight] = useState(() =>
    readStoredPaneSize(
      ARTIFACTS_HEIGHT_KEY,
      DEFAULT_ARTIFACTS_HEIGHT,
      MIN_ARTIFACTS_HEIGHT,
      MAX_ARTIFACTS_HEIGHT,
    ),
  );

  useEffect(() => {
    window.localStorage.setItem(ARTIFACTS_HEIGHT_KEY, String(artifactsHeight));
  }, [artifactsHeight]);

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
            const newName = window.prompt(t("workbench.renamePrompt"), entry.name);
            if (!newName || newName === entry.name) return;
            try {
              await renameWorkspacePath({ path: entry.path, newName, taskId, projectId });
              tree.reloadRoot();
            } catch (err) {
              window.alert(err instanceof Error ? err.message : String(err));
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
            try {
              await deleteWorkspacePath({ path: entry.path, taskId, projectId });
              tree.reloadRoot();
            } catch (err) {
              window.alert(err instanceof Error ? err.message : String(err));
            }
          },
        },
      ];
      setCtxMenu({ open: true, point: contextMenuPoint(event), items });
    },
    [onOpenFile, onAttachToChat, taskId, projectId, tree],
  );

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleArtifacts = normalizedFilter
    ? artifacts.filter((item) => item.name.toLowerCase().includes(normalizedFilter))
    : artifacts;

  const treeStyle = {
    "--workbench-artifacts-height": `${artifactsHeight}px`,
  } as CSSProperties;

  return (
    <div className="file-tree" style={treeStyle}>
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
        <div className="file-tree-list">
          <DirectoryRows
            path="."
            depth={0}
            tree={tree}
            filter={filter}
            selectedPath={selectedPath}
            onOpenFile={onOpenFile}
            onContext={handleContext}
          />
        </div>
      </section>

      <div
        className="workbench-split workbench-split-row"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("workbench.resizeArtifacts")}
        onPointerDown={(event) =>
          startPaneResize(event, {
            axis: "y",
            startSize: artifactsHeight,
            min: MIN_ARTIFACTS_HEIGHT,
            max: MAX_ARTIFACTS_HEIGHT,
            invert: true,
            onSize: setArtifactsHeight,
          })
        }
      />

      <section className="file-tree-section" data-kind="artifacts">
        <div className="file-tree-section-head">
          <span>{t("workbench.artifacts")}</span>
          <span className="file-tree-count">{visibleArtifacts.length}</span>
        </div>
        <div className="file-tree-list">
          {visibleArtifacts.length === 0 ? (
            <p className="file-tree-empty">{t("workbench.noArtifacts")}</p>
          ) : (
            visibleArtifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className="file-tree-row"
                data-kind="artifact"
                onClick={() => onOpenArtifact(artifact)}
                title={artifact.name}
              >
                <span className="file-tree-icon" aria-hidden="true">
                  ◇
                </span>
                <span className="file-tree-name">{artifact.name}</span>
              </button>
            ))
          )}
        </div>
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

function DirectoryRows({
  path,
  depth,
  tree,
  filter,
  selectedPath,
  onOpenFile,
  onContext,
}: {
  path: string;
  depth: number;
  tree: FileTreeState;
  filter: string;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onContext: (event: React.MouseEvent, entry: WorkspaceReadEntry) => void;
}) {
  const node = tree.nodes[path];
  if (!node) return <p className="file-tree-empty">{t("workbench.loading")}</p>;
  if (node.error) return <p className="file-tree-error">{node.error}</p>;
  if (node.loading && node.entries.length === 0) {
    return <p className="file-tree-empty">{t("workbench.loading")}</p>;
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const entries = normalizedFilter
    ? node.entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(normalizedFilter) ||
          entry.path.toLowerCase().includes(normalizedFilter),
      )
    : node.entries;

  return (
    <>
      {entries.map((entry) => (
        <FileTreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          tree={tree}
          filter={filter}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onContext={onContext}
        />
      ))}
      {node.truncated && <p className="file-tree-empty">{t("workbench.truncated")}</p>}
    </>
  );
}

function FileTreeRow({
  entry,
  depth,
  tree,
  filter,
  selectedPath,
  onOpenFile,
  onContext,
}: {
  entry: WorkspaceReadEntry;
  depth: number;
  tree: FileTreeState;
  filter: string;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  onContext: (event: React.MouseEvent, entry: WorkspaceReadEntry) => void;
}) {
  const isDirectory = entry.type === "directory";
  const node = tree.nodes[entry.path];
  const selected = !isDirectory && selectedPath != null && pathsEqual(selectedPath, entry.path);
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return (
    <>
      <button
        type="button"
        className="file-tree-row"
        data-kind={isDirectory ? "directory" : "file"}
        data-ext={isDirectory ? "dir" : ext}
        data-selected={selected ? "true" : undefined}
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
      {isDirectory && node?.open && (
        <DirectoryRows
          path={entry.path}
          depth={depth + 1}
          tree={tree}
          filter={filter}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onContext={onContext}
        />
      )}
    </>
  );
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
