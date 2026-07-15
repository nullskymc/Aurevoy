import { useState } from "react";
import type { MemoryCategory, MemoryEntry } from "@aurevoy/shared";
import { t } from "../../i18n";
import { SettingsGroup } from "./layout";

const MEMORY_CATEGORIES: MemoryCategory[] = ["preference", "directory", "model", "habit", "fact", "other"];

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
}: {
  memories: MemoryEntry[];
  onCreate: (content: string, category: MemoryCategory) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string, content: string, category: MemoryCategory) => void;
  onDelete: (id: string) => void;
}) {
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("preference");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<MemoryCategory>("preference");

  const enabledCount = memories.filter((m) => m.enabled).length;

  function submitNew() {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    onCreate(trimmed, newCategory);
    setNewContent("");
  }

  function startEdit(memory: MemoryEntry) {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditCategory(memory.category);
  }

  function saveEdit() {
    if (editingId && editContent.trim()) {
      onEdit(editingId, editContent.trim(), editCategory);
      setEditingId(null);
    }
  }

  return (
    <SettingsGroup title={`${t("memory.title")} (${memories.length} / ${enabledCount} ${t("memory.entriesInjected")})`}>
      <div className="memory-add">
        <select
          className="memory-cat-select"
          value={newCategory}
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
          placeholder={t("memory.addPlaceholder")}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitNew(); }}
        />
        <button type="button" className="memory-add-btn" onClick={submitNew} disabled={!newContent.trim()}>
          {t("action.add")}
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
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={2}
                  />
                  <div className="memory-edit-actions">
                    <button type="button" className="memory-link" onClick={saveEdit}>{t("action.save")}</button>
                    <button type="button" className="memory-link" onClick={() => setEditingId(null)}>{t("action.cancel")}</button>
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
                        onChange={(e) => onToggle(memory.id, e.target.checked)}
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
                      <button type="button" className="memory-link" onClick={() => startEdit(memory)}>{t("action.edit")}</button>
                      <button type="button" className="memory-link danger" onClick={() => onDelete(memory.id)}>{t("action.delete")}</button>
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
