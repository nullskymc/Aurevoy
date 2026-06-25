import { useState } from "react";
import type { MemoryCategory, MemoryEntry } from "@aurevoy/shared";
import { t } from "../i18n";

interface MemoryPanelProps {
  open: boolean;
  memories: MemoryEntry[];
  onClose: () => void;
  onCreate: (content: string, category: MemoryCategory) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string, content: string, category: MemoryCategory) => void;
  onDelete: (id: string) => void;
}

const CATEGORY_VALUES: MemoryCategory[] = [
  "preference",
  "directory",
  "model",
  "habit",
  "fact",
  "other",
];

function categoryLabel(category: MemoryCategory): string {
  switch (category) {
    case "preference":
      return t("memory.cat.preference");
    case "directory":
      return t("memory.cat.directory");
    case "model":
      return t("memory.cat.model");
    case "habit":
      return t("memory.cat.habit");
    case "fact":
      return t("memory.cat.fact");
    case "other":
      return t("memory.cat.other");
    default:
      return category;
  }
}

export function MemoryPanel({
  open,
  memories,
  onClose,
  onCreate,
  onToggle,
  onEdit,
  onDelete,
}: MemoryPanelProps) {
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("preference");

  if (!open) return null;

  const enabledCount = memories.filter((m) => m.enabled).length;

  function submitNew() {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    onCreate(trimmed, newCategory);
    setNewContent("");
  }

  return (
    <section className="page-panel memory-page" aria-label={t("memory.pageLabel")}>
      <header className="page-panel-head">
        <div>
          <h1>{t("memory.title")}</h1>
          <p>{t("memory.total")} {memories.length} {t("memory.entriesEnabled")} {enabledCount} {t("memory.entriesInjected")}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={onClose}>
          {t("common.backToChat")}
        </button>
      </header>

      <div className="memory-add">
        <select
          className="memory-cat-select"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
          aria-label={t("memory.categoryLabel")}
        >
          {CATEGORY_VALUES.map((value) => (
            <option key={value} value={value}>
              {categoryLabel(value)}
            </option>
          ))}
        </select>
        <input
          className="memory-add-input"
          value={newContent}
          placeholder={t("memory.addPlaceholder")}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitNew();
          }}
        />
        <button type="button" className="memory-add-btn" onClick={submitNew} disabled={!newContent.trim()}>
          {t("action.add")}
        </button>
      </div>

      <div className="page-scroll">
        {memories.length === 0 ? (
          <p className="drawer-empty">{t("memory.empty")}</p>
        ) : (
          <ul className="memory-list">
            {memories.map((memory) => (
              <MemoryItem
                key={memory.id}
                memory={memory}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MemoryItem({
  memory,
  onToggle,
  onEdit,
  onDelete,
}: {
  memory: MemoryEntry;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string, content: string, category: MemoryCategory) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [draftCat, setDraftCat] = useState<MemoryCategory>(memory.category);

  function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onEdit(memory.id, trimmed, draftCat);
    setEditing(false);
  }

  const sourceText =
    memory.source.origin === "user"
      ? t("memory.sourceUser")
      : `${t("memory.sourceAgent")}${memory.source.taskGoal ? `${t("memory.fromTaskPrefix")}${memory.source.taskGoal}${t("memory.fromTaskSuffix")}` : ""}`;

  return (
    <li className="memory-item" data-disabled={!memory.enabled}>
      <div className="memory-item-head">
        <span className="memory-cat" data-cat={memory.category}>
          {categoryLabel(memory.category)}
        </span>
        <span className="memory-confidence" title={t("memory.confidence")}>
          {Math.round(memory.confidence * 100)}%
        </span>
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

      {editing ? (
        <div className="memory-edit">
          <select
            className="memory-cat-select"
            value={draftCat}
            onChange={(e) => setDraftCat(e.target.value as MemoryCategory)}
          >
            {CATEGORY_VALUES.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value)}
              </option>
            ))}
          </select>
          <textarea
            className="memory-edit-input"
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="memory-edit-actions">
            <button type="button" className="ghost-btn" onClick={() => { setEditing(false); setDraft(memory.content); setDraftCat(memory.category); }}>
              {t("action.cancel")}
            </button>
            <button type="button" className="memory-add-btn" onClick={save} disabled={!draft.trim()}>
              {t("action.save")}
            </button>
          </div>
        </div>
      ) : (
        <p className="memory-content">{memory.content}</p>
      )}

      <div className="memory-item-foot">
        <span className="memory-source">{sourceText}</span>
        <span className="memory-time">{new Date(memory.updatedAt).toLocaleString()}</span>
        {!editing && (
          <div className="memory-item-actions">
            <button type="button" className="memory-link" onClick={() => setEditing(true)}>
              {t("action.edit")}
            </button>
            <button type="button" className="memory-link danger" onClick={() => onDelete(memory.id)}>
              {t("action.delete")}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
