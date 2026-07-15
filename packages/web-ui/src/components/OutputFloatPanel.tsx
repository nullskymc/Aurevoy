import { useMemo, useState } from "react";
import type { ContentBlock, Task, TaskArtifact } from "@aurevoy/shared";
import { t } from "../i18n";
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
      subtitle: artifact.mimeType || artifact.type,
      artifact,
    });
  }

  const blocks: ContentBlock[] = [];
  for (const message of task.messages) {
    if (message.contentBlocks?.length) blocks.push(...message.contentBlocks);
  }
  blocks.push(...liveBlocks);

  for (const block of blocks) {
    if (block.type === "ui") continue;
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
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="output-float-icon-btn"
            onClick={onClose}
            title={t("output.close")}
            aria-label={t("output.close")}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className="output-float-body">
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

function DocIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M4 2.5h5.2L12 5.3V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3.5a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 2.5V5h3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M3.5 4.5h9v8a1 1 0 01-1 1h-7a1 1 0 01-1-1v-8z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M5.5 2.5h5v2h-5v-2z" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
