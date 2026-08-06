import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { PiSessionTreeNode, PiSessionTreeResponse, Task } from "@aurevoy/shared";
import { getTaskSessionTree, navigateTaskSessionTree, setTaskSessionTreeLabel } from "../api";
import { IconFork, IconX } from "../icons";
import { t } from "../i18n";
import "./SessionTreeDialog.css";

interface SessionTreeDialogProps {
  open: boolean;
  task: Task;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onTaskChange: (task: Task) => void;
}

export interface SessionTreeRow {
  node: PiSessionTreeNode;
  lane: number;
  visibleParentId: string | null;
}

const VISIBLE_NODE_TYPES = new Set([
  "message",
  "branch_summary",
  "compaction",
  "custom_message",
  "model_change",
  "thinking_level_change",
  "active_tools_change",
]);

/** 会话分支只能从用户输入开始，assistant/tool 中间态仅供查看。 */
export function isSessionTreeNodeNavigable(node: PiSessionTreeNode): boolean {
  return node.navigable === true;
}

/**
 * 把 Pi 的完整 entry 树压成面向用户的对话节点，并仅在真正分叉时新增视觉泳道。
 * 隐藏的 tool/metadata 节点会被跨过，但仍参与父子关系计算。
 */
export function buildSessionTreeRows(nodes: PiSessionTreeNode[]): SessionTreeRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visible = nodes.filter((node) => (
    VISIBLE_NODE_TYPES.has(node.type)
    && (node.type !== "message" || node.role === "user" || node.role === "assistant")
    // 纯 tool-call assistant 没有可读正文，不作为产品层会话节点展示。
    && !(node.type === "message" && node.role === "assistant" && !node.preview)
  ));
  const visibleIds = new Set(visible.map((node) => node.id));
  const nearestVisibleParent = (node: PiSessionTreeNode): string | null => {
    let parentId = node.parentId;
    while (parentId && !visibleIds.has(parentId)) parentId = byId.get(parentId)?.parentId ?? null;
    return parentId;
  };

  const childrenByParent = new Map<string | null, string[]>();
  for (const node of visible) {
    const parentId = nearestVisibleParent(node);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(parentId, children);
  }

  const lanes = new Map<string, number>();
  let nextLane = 1;
  return visible.map((node) => {
    const parentId = nearestVisibleParent(node);
    const siblings = childrenByParent.get(parentId) ?? [];
    const siblingIndex = siblings.indexOf(node.id);
    const parentLane = parentId ? (lanes.get(parentId) ?? 0) : 0;
    const lane = siblingIndex <= 0 ? parentLane : nextLane++;
    lanes.set(node.id, lane);
    return { node, lane, visibleParentId: parentId };
  });
}

export function SessionTreeDialog({
  open,
  task,
  busy,
  onOpenChange,
  onTaskChange,
}: SessionTreeDialogProps) {
  const [tree, setTree] = useState<PiSessionTreeResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "user" | "labels">("all");
  const [summarize, setSummarize] = useState(true);
  const [summaryInstructions, setSummaryInstructions] = useState("");
  const [labelDraft, setLabelDraft] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getTaskSessionTree(task.id)
      .then((response) => {
        if (cancelled) return;
        setTree(response);
        // 当前 leaf 通常是 assistant 终稿；打开弹窗时不预选不可导航节点。
        setSelectedId(
          response.nodes.find((node) => (
            node.id === response.leafId && isSessionTreeNodeNavigable(node)
          ))?.id ?? null,
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, task.id]);

  const rows = useMemo(() => {
    const all = buildSessionTreeRows(tree?.nodes ?? []);
    if (filter === "user") return all.filter((row) => row.node.role === "user");
    if (filter === "labels") return all.filter((row) => !!row.node.label);
    return all;
  }, [filter, tree?.nodes]);
  const selectedRow = rows.find((row) => row.node.id === selectedId);
  const hasImages = task.messages.some((message) => (message.imageParts?.length ?? 0) > 0);
  const canNavigate = !!selectedRow
    && isSessionTreeNodeNavigable(selectedRow.node)
    && selectedId !== tree?.leafId
    && !busy
    && !loading
    && !navigating
    && !hasImages;

  async function handleNavigate(): Promise<void> {
    if (!selectedId || !canNavigate) return;
    setNavigating(true);
    setError(null);
    try {
      const response = await navigateTaskSessionTree(task.id, selectedId, {
        summarize,
        customInstructions: summaryInstructions.trim() || undefined,
      });
      setTree(response.tree);
      setSelectedId(response.tree.leafId);
      onTaskChange(response.task);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(detail);
    } finally {
      setNavigating(false);
    }
  }

  async function handleSaveLabel(): Promise<void> {
    if (!selectedId) return;
    try {
      const response = await setTaskSessionTreeLabel(task.id, selectedId, labelDraft.trim() || undefined);
      setTree(response);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(detail);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="session-tree-backdrop" />
        <Dialog.Content className="session-tree-dialog">
          <header className="session-tree-header">
            <span className="session-tree-header-icon" aria-hidden="true"><IconFork size={18} /></span>
            <div>
              <Dialog.Title className="session-tree-title">{t("sessionTree.title")}</Dialog.Title>
              <Dialog.Description className="session-tree-description">
                {t("sessionTree.description")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn session-tree-close" aria-label={t("sessionTree.close")}>
                <IconX size={16} />
              </button>
            </Dialog.Close>
          </header>

          <div className="session-tree-body">
            <div className="session-tree-controls">
              {(["all", "user", "labels"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-active={filter === value ? "true" : undefined}
                  onClick={() => setFilter(value)}
                >
                  {t(`sessionTree.filter.${value}`)}
                </button>
              ))}
            </div>
            {loading ? (
              <div className="session-tree-state">{t("sessionTree.loading")}</div>
            ) : error && rows.length === 0 ? (
              <div className="session-tree-state session-tree-state--error" role="alert">{error}</div>
            ) : rows.length === 0 ? (
              <div className="session-tree-state">{t("sessionTree.empty")}</div>
            ) : (
              <div className="session-tree-list" role="tree" aria-label={t("sessionTree.title")}>
                {rows.map(({ node, lane }) => {
                  const active = node.id === tree?.leafId;
                  const selected = node.id === selectedId;
                  const navigable = isSessionTreeNodeNavigable(node);
                  const rowContent = (
                    <>
                      <span className="session-tree-rail" aria-hidden="true">
                        <span className="session-tree-dot" />
                      </span>
                      <span className="session-tree-node-copy">
                        <span className="session-tree-node-meta">
                          <span>{nodeLabel(node)}</span>
                          {active && <span className="session-tree-current">{t("sessionTree.current")}</span>}
                          {node.label && <span className="session-tree-label">{node.label}</span>}
                          <time dateTime={node.timestamp}>{formatNodeTime(node.timestamp)}</time>
                        </span>
                        <span className="session-tree-preview">{node.preview || node.label || node.type}</span>
                      </span>
                    </>
                  );
                  return navigable ? (
                    <button
                      key={node.id}
                      type="button"
                      role="treeitem"
                      aria-current={active ? "true" : undefined}
                      aria-selected={selected}
                      className="session-tree-row"
                      data-active={active ? "true" : undefined}
                      data-selected={selected ? "true" : undefined}
                      style={{ "--session-tree-lane": lane } as CSSProperties}
                      onClick={() => setSelectedId(node.id)}
                    >
                      {rowContent}
                    </button>
                  ) : (
                    <div
                      key={node.id}
                      role="treeitem"
                      aria-current={active ? "true" : undefined}
                      className="session-tree-row session-tree-row--readonly"
                      data-active={active ? "true" : undefined}
                      style={{ "--session-tree-lane": lane } as CSSProperties}
                    >
                      {rowContent}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <footer className="session-tree-footer">
            <div className="session-tree-footer-options">
              <p className="session-tree-warning">
                {hasImages ? t("sessionTree.imageReadOnly") : t("sessionTree.workspaceWarning")}
              </p>
              {selectedId && (
                <div className="session-tree-label-editor">
                  <input
                    value={labelDraft}
                    onChange={(event) => setLabelDraft(event.target.value)}
                    placeholder={selectedRow?.node.label || t("sessionTree.labelPlaceholder")}
                  />
                  <button type="button" onClick={() => void handleSaveLabel()}>
                    {t("sessionTree.saveLabel")}
                  </button>
                </div>
              )}
              <label className="session-tree-summary-option">
                <input type="checkbox" checked={summarize} onChange={(event) => setSummarize(event.target.checked)} />
                {t("sessionTree.summarize")}
              </label>
              {summarize && (
                <input
                  className="session-tree-summary-instructions"
                  value={summaryInstructions}
                  onChange={(event) => setSummaryInstructions(event.target.value)}
                  placeholder={t("sessionTree.summaryInstructions")}
                />
              )}
            </div>
            <button
              type="button"
              className="session-tree-switch"
              disabled={!canNavigate}
              onClick={() => void handleNavigate()}
            >
              {navigating ? t("sessionTree.switching") : t("sessionTree.switch")}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function nodeLabel(node: PiSessionTreeNode): string {
  if (node.type === "branch_summary") return t("sessionTree.summary");
  if (node.type === "compaction") return t("sessionTree.compaction");
  if (node.type === "model_change") return t("sessionTree.modelChange");
  if (node.type === "thinking_level_change") return t("sessionTree.thinkingChange");
  if (node.type === "active_tools_change") return t("sessionTree.toolsChange");
  if (node.role === "user") return t("sessionTree.user");
  if (node.role === "assistant") return t("sessionTree.assistant");
  return node.label || node.type;
}

function formatNodeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
