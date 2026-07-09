import type { CSSProperties } from "react";
import { useState } from "react";
import type { WorkspaceReadEntry } from "@aurevoy/shared";
import type { useFileTree } from "../hooks/useFileTree";
import { t } from "../i18n";

type FileTreeState = ReturnType<typeof useFileTree>;

interface FileTreeProps {
  tree: FileTreeState;
  onOpenFile: (path: string) => void;
}

export function FileTree({ tree, onOpenFile }: FileTreeProps) {
  const [filter, setFilter] = useState("");

  return (
    <div className="file-tree">
      <section className="file-tree-section">
        <div className="file-tree-section-head">
          <span>{t("rightPanel.workspace")}</span>
          <button type="button" className="icon-btn-small" onClick={tree.reloadRoot} aria-label={t("rightPanel.refresh")}>
            ↻
          </button>
        </div>
        <div className="file-tree-filter-wrap">
          <input
            className="file-tree-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("rightPanel.filterFiles")}
          />
        </div>
        <div className="file-tree-list">
          <DirectoryRows path="." depth={0} tree={tree} filter={filter} onOpenFile={onOpenFile} />
        </div>
      </section>
    </div>
  );
}

function DirectoryRows({
  path,
  depth,
  tree,
  filter,
  onOpenFile,
}: {
  path: string;
  depth: number;
  tree: FileTreeState;
  filter: string;
  onOpenFile: (path: string) => void;
}) {
  const node = tree.nodes[path];
  if (!node) return <p className="file-tree-empty">{t("rightPanel.loading")}</p>;
  if (node.error) return <p className="file-tree-error">{node.error}</p>;
  if (node.loading && node.entries.length === 0) return <p className="file-tree-empty">{t("rightPanel.loading")}</p>;

  const normalizedFilter = filter.trim().toLowerCase();
  const entries = normalizedFilter
    ? node.entries.filter((entry) => entry.name.toLowerCase().includes(normalizedFilter) || entry.path.toLowerCase().includes(normalizedFilter))
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
          onOpenFile={onOpenFile}
        />
      ))}
      {node.truncated && <p className="file-tree-empty">{t("rightPanel.truncated")}</p>}
    </>
  );
}

function FileTreeRow({
  entry,
  depth,
  tree,
  filter,
  onOpenFile,
}: {
  entry: WorkspaceReadEntry;
  depth: number;
  tree: FileTreeState;
  filter: string;
  onOpenFile: (path: string) => void;
}) {
  const isDirectory = entry.type === "directory";
  const node = tree.nodes[entry.path];
  return (
    <>
      <button
        type="button"
        className="file-tree-row"
        style={{ "--tree-depth": depth } as CSSProperties}
        onClick={() => isDirectory ? tree.toggleDirectory(entry.path) : onOpenFile(entry.path)}
        title={entry.path}
      >
        <span className="file-tree-chevron" data-open={node?.open === true} aria-hidden="true">
          {isDirectory ? "›" : ""}
        </span>
        <span className="file-tree-icon" aria-hidden="true">{iconForEntry(entry)}</span>
        <span className="file-tree-name">{entry.name}</span>
      </button>
      {isDirectory && node?.open && (
        <DirectoryRows path={entry.path} depth={depth + 1} tree={tree} filter={filter} onOpenFile={onOpenFile} />
      )}
    </>
  );
}

function iconForEntry(entry: WorkspaceReadEntry): string {
  if (entry.type === "directory") return "▣";
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (!ext || ext === entry.name) return "□";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "▧";
  if (["md", "mdx"].includes(ext)) return "M";
  if (["json", "yaml", "yml"].includes(ext)) return "{}";
  if (["ts", "tsx", "js", "jsx", "css", "html", "rs", "py", "go"].includes(ext)) return "</>";
  return "□";
}
