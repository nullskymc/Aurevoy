import { useEffect, useState } from "react";
import type { TaskArtifact } from "@aurevoy/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { t } from "../i18n";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";

interface ArtifactViewProps {
  artifacts: TaskArtifact[];
  onDecision: (artifactId: string, status: "confirmed" | "rejected") => void;
}

function artifactIcon(type: TaskArtifact["type"]): string {
  switch (type) {
    case "file":
      return "📄";
    case "diff":
      return "📋";
    case "url":
      return "🔗";
    default:
      return "📝";
  }
}

/** 产物浏览器：左侧产物列表 + 右侧文档预览，draft 状态可确认/拒绝。 */
export function ArtifactView({ artifacts, onDecision }: ArtifactViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    artifacts.length > 0 ? artifacts[0].id : null,
  );

  // 产物列表变化时，保证选中项仍有效（被删除或首次出现时回退到第一个）。
  useEffect(() => {
    if (artifacts.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current && artifacts.some((artifact) => artifact.id === current)
        ? current
        : artifacts[0].id,
    );
  }, [artifacts]);

  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? null;

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    rect?: DOMRect;
    items: ContextMenuItem[];
  }>({ open: false, items: [] });

  function handleArtifactContextMenu(
    e: React.MouseEvent,
    artifact: TaskArtifact,
  ) {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "copy-name",
        label: "复制名称",
        action: () => navigator.clipboard.writeText(artifact.name).catch(() => {}),
      },
      ...(artifact.appliedPath
        ? [
            {
              type: "item" as const,
              id: "copy-path",
              label: "复制路径",
              action: () =>
                navigator.clipboard.writeText(artifact.appliedPath!).catch(() => {}),
            },
          ]
        : []),
      {
        type: "item",
        id: "copy-content",
        label: "复制内容",
        action: () =>
          navigator.clipboard.writeText(artifact.content).catch(() => {}),
      },
    ];
    setCtxMenu({
      open: true,
      rect: e.currentTarget.getBoundingClientRect(),
      items,
    });
  }

  if (artifacts.length === 0) {
    return (
      <div className="artifact-view-empty">
        <p>{t("artifact.empty.title")}</p>
        <small>{t("artifact.empty.hint")}</small>
      </div>
    );
  }

  return (
    <div className="artifact-view">
      <nav className="artifact-nav" aria-label={t("artifact.listLabel")}>
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            className="artifact-nav-item"
            data-active={artifact.id === selectedId}
            data-status={artifact.status}
            onClick={() => setSelectedId(artifact.id)}
            onContextMenu={(e) => handleArtifactContextMenu(e, artifact)}
          >
            <span className="artifact-nav-icon" aria-hidden="true">
              {artifactIcon(artifact.type)}
            </span>
            <span className="artifact-nav-copy">
              <strong>{artifact.name}</strong>
              <small>{artifact.appliedPath || artifact.type}</small>
            </span>
            <span className="artifact-nav-status" data-status={artifact.status}>
              {artifact.status}
            </span>
          </button>
        ))}
      </nav>

      {selected && (
        <article className="artifact-doc">
          <header className="artifact-doc-head">
            <h1>{selected.name}</h1>
            {selected.appliedPath && (
              <span className="artifact-doc-path">{selected.appliedPath}</span>
            )}
            {selected.status === "draft" && (
              <div className="artifact-doc-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => onDecision(selected.id, "rejected")}
                >
                  {t("action.reject")}
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => onDecision(selected.id, "confirmed")}
                >
                  {t("action.confirm")}
                </button>
              </div>
            )}
          </header>
          <div className="artifact-doc-body">
            <MarkdownRenderer content={selected.content} />
          </div>
        </article>
      )}

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorRect={ctxMenu.rect}
        onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
      />
    </div>
  );
}
