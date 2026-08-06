import { useMemo, useState } from "react";
import type { ContentBlock, Task, TaskArtifact, TaskFileChange } from "@aurevoy/shared";
import { t } from "../i18n";
import { IconFile, IconFolder, IconPlus, IconX } from "../icons";
import "./OutputFloatPanel.css";

export type OutputItem =
  | { kind: "artifact"; id: string; name: string; subtitle?: string; artifact: TaskArtifact }
  | { kind: "file"; id: string; name: string; subtitle?: string; path: string; block: ContentBlock };

function collectOutputItems(task: Task | null, liveBlocks: ContentBlock[]): OutputItem[] {
  if (!task) return [];
  const items: OutputItem[] = [];
  const seen = new Set<string>();

  for (const artifact of task.artifacts ?? []) {
    const key = `artifact:${artifact.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind: "artifact",
      id: artifact.id,
      name: artifact.name || t("output.untitled"),
      subtitle: artifactMetadataLabel(artifact),
      artifact,
    });
  }

  const blocks: ContentBlock[] = [];
  for (const message of task.messages) {
    if (message.contentBlocks?.length) blocks.push(...message.contentBlocks);
  }
  blocks.push(...liveBlocks);

  for (const block of blocks) {
    const key = `block:${block.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (block.type === "file_reference") {
      const path = block.content || "";
      const name = block.name || path.split(/[/\\]/).pop() || t("output.untitled");
      items.push({
        kind: "file",
        id: block.id,
        name,
        subtitle: path || undefined,
        path,
        block,
      });
      continue;
    }
    if (block.type === "image") {
      const path = block.content || "";
      items.push({
        kind: "file",
        id: block.id,
        name: block.name || t("output.image"),
        subtitle: path || undefined,
        path,
        block,
      });
      continue;
    }
    if (block.type === "link") {
      const url = block.content || "";
      items.push({
        kind: "file",
        id: block.id,
        name: block.name || url || t("output.link"),
        subtitle: url || undefined,
        path: url,
        block,
      });
    }
  }

  return items;
}

function artifactMetadataLabel(artifact: TaskArtifact): string {
  const parts = [artifact.mimeType || artifact.type];
  if (artifact.sizeBytes !== undefined) parts.push(formatBytes(artifact.sizeBytes));
  if (artifact.appliedPath) parts.push(artifact.appliedPath);
  return parts.join(" · ");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function OutputFloatPanel({
  task,
  liveContentBlocks = [],
  visible,
  onOpenArtifact,
  onOpenPath,
  onOpenWorkbench,
  onClose,
}: {
  task: Task | null;
  liveContentBlocks?: ContentBlock[];
  /** 是否显示（有对话主区时） */
  visible: boolean;
  onOpenArtifact: (artifact: TaskArtifact) => void;
  onOpenPath: (path: string) => void;
  onOpenWorkbench: () => void;
  /** 关闭整个输出栏（释放右侧列） */
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const items = useMemo(
    () => collectOutputItems(task, liveContentBlocks),
    [task, liveContentBlocks],
  );
  if (!visible) return null;

  return (
    <aside
      className="output-float"
      data-collapsed={collapsed ? "true" : "false"}
      data-empty={items.length === 0 ? "true" : "false"}
      aria-label={t("output.panelLabel")}
    >
      <header className="output-float-head">
        <button
          type="button"
          className="output-float-title-btn"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <span className="output-float-title">{t("output.title")}</span>
          {items.length > 0 ? (
            <span className="output-float-count">{items.length}</span>
          ) : null}
        </button>
        <div className="output-float-head-actions">
          <button
            type="button"
            className="output-float-icon-btn"
            onClick={onOpenWorkbench}
            title={t("output.createHint")}
            aria-label={t("output.createHint")}
          >
            <IconPlus size={14} />
          </button>
          <button
            type="button"
            className="output-float-icon-btn"
            onClick={onClose}
            title={t("output.close")}
            aria-label={t("output.close")}
          >
            <IconX size={14} />
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className="output-float-body">
          {task?.fileChanges?.length ? (
            <section className="output-float-changes" aria-label={t("output.changesTitle")}>
              <h2>{t("output.changesTitle")}</h2>
              <ul>
                {task.fileChanges.slice().reverse().slice(0, 12).map((change) => (
                  <li key={change.id}>
                    <span className="output-float-change-operation">{fileChangeOperationLabel(change)}</span>
                    <span className="output-float-change-path" title={change.path}>{change.path}</span>
                    <span className="output-float-change-stats">
                      {formatChangeStats(change)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {items.length === 0 ? (
            <button type="button" className="output-float-empty" onClick={onOpenWorkbench}>
              {t("output.empty")}
            </button>
          ) : (
            <ul className="output-float-list">
              {items.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <button
                    type="button"
                    className="output-float-item"
                    onClick={() => {
                      if (item.kind === "artifact") onOpenArtifact(item.artifact);
                      else if (item.path) onOpenPath(item.path);
                      else onOpenWorkbench();
                    }}
                    title={item.subtitle || item.name}
                  >
                    <span className="output-float-item-icon" aria-hidden="true">
                      {item.kind === "artifact" ? <DocIcon /> : <FileIcon />}
                    </span>
                    <span className="output-float-item-copy">
                      <span className="output-float-item-name">{item.name}</span>
                      {item.subtitle ? (
                        <span className="output-float-item-meta">{item.subtitle}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

function fileChangeOperationLabel(change: TaskFileChange): string {
  switch (change.operation) {
    case "created": return t("output.changeCreated");
    case "modified": return t("output.changeModified");
    case "appended": return t("output.changeAppended");
    case "copied": return t("output.changeCopied");
    case "moved": return t("output.changeMoved");
    case "deleted": return t("output.changeDeleted");
    case "artifact_applied": return t("output.changeArtifact");
  }
}

function formatChangeStats(change: TaskFileChange): string {
  const lines = [
    change.additions !== undefined ? `+${change.additions}` : "",
    change.deletions !== undefined ? `-${change.deletions}` : "",
  ].filter(Boolean);
  if (!change.baselineAvailable) lines.push(t("output.changeNoBaseline"));
  return lines.join(" ");
}

function DocIcon() {
  return <IconFile size={14} />;
}

function FileIcon() {
  return <IconFolder size={14} />;
}
