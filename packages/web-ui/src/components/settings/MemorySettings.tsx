import { useState } from "react";
import type { MemoryCategory, MemoryEntry } from "@aurevoy/shared";
import { t } from "../../i18n";
import { SettingsGroup } from "./layout";

const MEMORY_CATEGORIES: MemoryCategory[] = ["preference", "directory", "model", "habit", "fact", "other"];
type MemoryActionKind = "create" | "toggle" | "edit" | "delete" | "recall";
type MemoryAction = { kind: MemoryActionKind; id?: string };

export function memoryCategoryLabel(category: MemoryCategory): string {
  switch (category) {
    case "preference": return t("memory.cat.preference");
    case "directory": return t("memory.cat.directory");
    case "model": return t("memory.cat.model");
    case "habit": return t("memory.cat.habit");
    case "fact": return t("memory.cat.fact");
    case "other": return t("memory.cat.other");
    default: return category;
  }
}

export function MemorySettings({
  memories,
  onCreate,
  onToggle,
  onEdit,
  onDelete,
  recallEnabled,
  onRecallChange,
}: {
  memories: MemoryEntry[];
  onCreate: (content: string, category: MemoryCategory) => void | Promise<void>;
  onToggle: (id: string, enabled: boolean) => void | Promise<void>;
  onEdit: (id: string, content: string, category: MemoryCategory) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  recallEnabled: boolean;
  onRecallChange: (enabled: boolean) => void | Promise<void>;
}) {
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("preference");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<MemoryCategory>("preference");
  const [busyAction, setBusyAction] = useState<MemoryAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const enabledCount = memories.filter((m) => m.enabled).length;
  const isBusy = busyAction !== null;

  function formatError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `${t("memory.actionFailed")}${detail}`;
  }

  async function submitNew(): Promise<void> {
    const trimmed = newContent.trim();
    if (!trimmed || isBusy) return;
    setBusyAction({ kind: "create" });
    setActionError(null);
    try {
      await Promise.resolve(onCreate(trimmed, newCategory));
      setNewContent("");
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusyAction(null);
    }
  }

  function startEdit(memory: MemoryEntry) {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditCategory(memory.category);
  }

  async function saveEdit(): Promise<void> {
    const trimmed = editContent.trim();
    if (!editingId || !trimmed || isBusy) return;
    const id = editingId;
    setBusyAction({ kind: "edit", id });
    setActionError(null);
    try {
      await Promise.resolve(onEdit(id, trimmed, editCategory));
      setEditingId(null);
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleMemory(id: string, enabled: boolean): Promise<void> {
    if (isBusy) return;
    setBusyAction({ kind: "toggle", id });
    setActionError(null);
    try {
      await Promise.resolve(onToggle(id, enabled));
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteMemory(id: string): Promise<void> {
    if (isBusy) return;
    if (typeof window !== "undefined" && !window.confirm(t("memory.deleteConfirm"))) return;
    setBusyAction({ kind: "delete", id });
    setActionError(null);
    try {
      await Promise.resolve(onDelete(id));
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function changeRecall(enabled: boolean): Promise<void> {
    if (isBusy) return;
    setBusyAction({ kind: "recall" });
    setActionError(null);
    try {
      await Promise.resolve(onRecallChange(enabled));
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <SettingsGroup title={`${t("memory.title")} (${memories.length} / ${enabledCount} ${t("memory.entriesInjected")})`}>
      <label className="settings-row">
        <span>
          <strong>{t("memory.autoRecall")}</strong>
          <small>{t("memory.autoRecallHint")}</small>
        </span>
        <input
          type="checkbox"
          checked={recallEnabled}
          disabled={isBusy}
          onChange={(event) => void changeRecall(event.target.checked)}
        />
      </label>
      {actionError && <p className="memory-action-error" role="alert">{actionError}</p>}
      <div className="memory-add">
        <select
          className="memory-cat-select"
          value={newCategory}
          disabled={isBusy}
          onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
          aria-label={t("memory.categoryLabel")}
        >
          {MEMORY_CATEGORIES.map((value) => (
            <option key={value} value={value}>{memoryCategoryLabel(value)}</option>
          ))}
        </select>
        <input
          className="memory-add-input"
          value={newContent}
          disabled={isBusy}
          placeholder={t("memory.addPlaceholder")}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submitNew(); }}
        />
        <button type="button" className="memory-add-btn" onClick={() => void submitNew()} disabled={isBusy || !newContent.trim()}>
          {busyAction?.kind === "create" ? t("memory.adding") : t("action.add")}
        </button>
      </div>

      {memories.length === 0 ? (
        <p className="memory-empty">{t("memory.empty")}</p>
      ) : (
        <ul className="memory-list">
          {memories.map((memory) => (
            <li key={memory.id} className="memory-item" data-disabled={!memory.enabled}>
              {editingId === memory.id ? (
                <div className="memory-edit">
                  <select
                    className="memory-cat-select"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                  >
                    {MEMORY_CATEGORIES.map((value) => (
                      <option key={value} value={value}>{memoryCategoryLabel(value)}</option>
                    ))}
                  </select>
                    <textarea
                      className="memory-edit-input"
                      value={editContent}
                      disabled={isBusy}
                      onChange={(e) => setEditContent(e.target.value)}
                    rows={2}
                  />
                  <div className="memory-edit-actions">
                    <button type="button" className="memory-link" disabled={isBusy} onClick={() => void saveEdit()}>
                      {busyAction?.kind === "edit" ? t("memory.saving") : t("action.save")}
                    </button>
                    <button type="button" className="memory-link" disabled={isBusy} onClick={() => setEditingId(null)}>{t("action.cancel")}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="memory-item-head">
                    <span className="memory-cat">{memoryCategoryLabel(memory.category)}</span>
                    <span className="memory-confidence">{Math.round(memory.confidence * 100)}%</span>
                    {memory.embeddingUpdatedAt && (
                      <span className="memory-vec-badge" title="已向量化，支持语义检索">🧠</span>
                    )}
                    <label className="memory-toggle" title={memory.enabled ? t("memory.enabledTitle") : t("memory.disabledTitle")}>
                      <input
                        type="checkbox"
                        checked={memory.enabled}
                        disabled={isBusy}
                        onChange={(e) => void toggleMemory(memory.id, e.target.checked)}
                      />
                      <span>{memory.enabled ? t("memory.enable") : t("memory.disable")}</span>
                    </label>
                  </div>
                  <p className="memory-content">{memory.content}</p>
                  <div className="memory-item-foot">
                    <span className="memory-source">
                      {memory.source.origin === "user"
                        ? t("memory.sourceUser")
                        : `${t("memory.sourceAgent")}${memory.source.taskGoal ? `${t("memory.fromTaskPrefix")}${memory.source.taskGoal}${t("memory.fromTaskSuffix")}` : ""}`}
                    </span>
                    <span className="memory-time">{new Date(memory.createdAt).toLocaleDateString()}</span>
                    <span className="memory-item-actions">
                      <button type="button" className="memory-link" disabled={isBusy} onClick={() => startEdit(memory)}>{t("action.edit")}</button>
                      <button
                        type="button"
                        className="memory-link danger"
                        disabled={isBusy}
                        onClick={() => void deleteMemory(memory.id)}
                      >
                        {busyAction?.kind === "delete" && busyAction.id === memory.id ? t("memory.deleting") : t("action.delete")}
                      </button>
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
