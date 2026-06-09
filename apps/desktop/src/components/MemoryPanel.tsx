import { useState } from "react";
import type { MemoryCategory, MemoryEntry } from "@aurevoy/shared";

interface MemoryPanelProps {
  open: boolean;
  memories: MemoryEntry[];
  onClose: () => void;
  onCreate: (content: string, category: MemoryCategory) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string, content: string, category: MemoryCategory) => void;
  onDelete: (id: string) => void;
}

const CATEGORY_OPTIONS: { value: MemoryCategory; label: string }[] = [
  { value: "preference", label: "偏好" },
  { value: "directory", label: "常用目录" },
  { value: "model", label: "模型偏好" },
  { value: "habit", label: "习惯" },
  { value: "fact", label: "事实" },
  { value: "other", label: "其他" },
];

function categoryLabel(category: MemoryCategory): string {
  return CATEGORY_OPTIONS.find((c) => c.value === category)?.label ?? category;
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
    <section className="page-panel memory-page" aria-label="长期记忆管理">
      <header className="page-panel-head">
        <div>
          <h1>长期记忆</h1>
          <p>共 {memories.length} 条，启用 {enabledCount} 条。启用的记忆会作为背景注入对话。</p>
        </div>
        <button type="button" className="ghost-btn" onClick={onClose}>
          返回对话
        </button>
      </header>

      <div className="memory-add">
        <select
          className="memory-cat-select"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
          aria-label="记忆分类"
        >
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          className="memory-add-input"
          value={newContent}
          placeholder="新增一条长期记忆，例如：偏好用简洁中文回答"
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitNew();
          }}
        />
        <button type="button" className="memory-add-btn" onClick={submitNew} disabled={!newContent.trim()}>
          添加
        </button>
      </div>

      <div className="page-scroll">
        {memories.length === 0 ? (
          <p className="drawer-empty">还没有记忆。你可以手动添加，Agent 也会在对话中记录。</p>
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
      ? "用户手动添加"
      : `Agent 记录${memory.source.taskGoal ? `（来自任务：${memory.source.taskGoal}）` : ""}`;

  return (
    <li className="memory-item" data-disabled={!memory.enabled}>
      <div className="memory-item-head">
        <span className="memory-cat" data-cat={memory.category}>
          {categoryLabel(memory.category)}
        </span>
        <span className="memory-confidence" title="置信度">
          {Math.round(memory.confidence * 100)}%
        </span>
        <label className="memory-toggle" title={memory.enabled ? "已启用" : "已停用"}>
          <input
            type="checkbox"
            checked={memory.enabled}
            onChange={(e) => onToggle(memory.id, e.target.checked)}
          />
          <span>{memory.enabled ? "启用" : "停用"}</span>
        </label>
      </div>

      {editing ? (
        <div className="memory-edit">
          <select
            className="memory-cat-select"
            value={draftCat}
            onChange={(e) => setDraftCat(e.target.value as MemoryCategory)}
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
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
              取消
            </button>
            <button type="button" className="memory-add-btn" onClick={save} disabled={!draft.trim()}>
              保存
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
              编辑
            </button>
            <button type="button" className="memory-link danger" onClick={() => onDelete(memory.id)}>
              删除
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
