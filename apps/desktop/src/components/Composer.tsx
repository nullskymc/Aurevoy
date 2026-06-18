import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t, type TranslationKey } from "../i18n";
import type { MessageAttachment, SkillDescriptor } from "@aurevoy/shared";

interface SlashCommand {
  name: string;
  descriptionKey?: TranslationKey;
  description?: string;
}

interface ComposerProps {
  value: string;
  busy: boolean;
  /** Skill: 动态 skill 列表，用于斜杠命令自动完成。 */
  skills?: SkillDescriptor[];
  online: boolean | null;
  /** hero: 居中空状态的大输入框；docked: 对话底部的停靠输入框 */
  variant?: "hero" | "docked";
  provider?: string;
  projectName?: string;
  /** 是否处于"编辑并重试"模式 */
  isEditing?: boolean;
  /** 取消编辑模式 */
  onCancelEdit?: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onOpenModelSelector: () => void;
  /** busy 时点击发送按钮触发停止/取消 */
  onStop?: () => void;
  /** 拖拽/选择的附件列表 */
  attachments?: MessageAttachment[];
  /** 附件变更回调 */
  onAttachmentsChange?: (attachments: MessageAttachment[]) => void;
}

export function Composer({
  value,
  busy,
  online,
  variant = "hero",
  provider,
  projectName,
  isEditing,
  skills,
  attachments,
  onAttachmentsChange,
  onCancelEdit,
  onChange,
  onSubmit,
  onOpenModelSelector,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const providerConfigured = provider !== "unconfigured";
  const canSend = value.trim().length > 0 && !busy && online !== false && providerConfigured;

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const commands: SlashCommand[] = [
      { name: "/compact", descriptionKey: "cmd.compact" as TranslationKey },
    ];
    if (skills) {
      for (const skill of skills) {
        commands.push({
          name: `/${skill.name}`,
          descriptionKey: undefined,
          description: skill.description,
        });
      }
    }
    return commands;
  }, [skills]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  const isTypingSlash = value.startsWith("/");
  const filteredCommands = useMemo(() => {
    if (!isTypingSlash) return [];
    const query = value.toLowerCase();
    return slashCommands.filter((cmd) => cmd.name.startsWith(query));
  }, [value, isTypingSlash, slashCommands]);
  const showCmdPopup = isTypingSlash && filteredCommands.length > 0;
  const displayCmdIndex = Math.min(cmdIndex, Math.max(0, filteredCommands.length - 1));

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (showCmdPopup) {
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const selected = filteredCommands[displayCmdIndex] ?? filteredCommands[0];
        if (selected) {
          onChange(selected.name);
          setCmdIndex(0);
          if (event.key === "Enter") onSubmit();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCmdIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCmdIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onChange("");
        return;
      }
    }

    // Enter 提交，Shift+Enter 换行
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  function handleRemoveAttachment(id: string): void {
    onAttachmentsChange?.((attachments ?? []).filter((a) => a.id !== id));
  }

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent): void {
    // 仅在离开 composer 自身时取消高亮，进入子元素不算
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    setIsDragOver(false);
    // HTML5 drop 不处理文件路径——路径由 Tauri onDragDropEvent 提供
  }

  const hasAttachments = attachments && attachments.length > 0;

  return (
    <div
      className="composer"
      data-variant={variant}
      data-editing={isEditing ? "true" : undefined}
      data-dragover={isDragOver ? "true" : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isEditing && (
        <div className="composer-edit-banner">
          <PencilEditIcon />
          <span>{t("composer.editMode")}</span>
          <button type="button" className="composer-edit-cancel" onClick={onCancelEdit}>
            {t("action.cancel")}
          </button>
        </div>
      )}
      <div className="composer-box">
        {showCmdPopup && (
          <div className="cmd-popup" role="listbox">
            {filteredCommands.map((cmd, i) => (
              <button
                type="button"
                key={cmd.name}
                role="option"
                aria-selected={i === displayCmdIndex}
                className="cmd-popup-item"
                data-selected={i === displayCmdIndex ? "true" : undefined}
                onPointerDown={(event) => {
                  event.preventDefault();
                  onChange(cmd.name);
                  setCmdIndex(0);
                }}
              >
                <span className="cmd-popup-name">{cmd.name}</span>
                <span className="cmd-popup-desc">{cmd.descriptionKey ? t(cmd.descriptionKey) : (cmd.description ?? '')}</span>
              </button>
            ))}
          </div>
        )}

        {/* 附件 chip 列表 */}
        {hasAttachments && (
          <div className="composer-attachments">
            {attachments!.map((att) => (
              <span key={att.id} className="composer-attachment-chip" title={att.path}>
                <span className="composer-attachment-chip-icon">
                  {att.type === 'image' ? <ImageFileIcon /> : <DocFileIcon />}
                </span>
                <span className="composer-attachment-chip-name">{att.name}</span>
                <button
                  type="button"
                  className="composer-attachment-chip-remove"
                  aria-label="Remove attachment"
                  onClick={() => handleRemoveAttachment(att.id)}
                >
                  <XIcon />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer-input"
          value={value}
          placeholder={t("composer.placeholder")}
          rows={1}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <button
              type="button"
              className="composer-icon-btn"
              title={t("composer.attachment")}
              aria-label={t("composer.attachment")}
              onClick={() => onAttachmentsChange?.([])}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="composer-chip"
              title={t("composer.selectModel")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenModelSelector}
            >
              <GearIcon />
              <span>{provider ? (provider === "unconfigured" ? t("composer.providerUnconfigured") : provider) : t("composer.providerDisconnected")}</span>
            </button>
          </div>

          <div className="composer-tools-right">
            <button
              type="button"
              className="composer-send"
              disabled={busy ? !onStop : !canSend}
              onClick={busy ? onStop : onSubmit}
              aria-label={busy ? t("action.stop") : isEditing ? t("composer.sendEdit") : t("composer.send")}
              title={
                busy
                  ? t("composer.stopHint")
                  : !value.trim()
                    ? t("composer.sendHintEmpty")
                    : online === false
                      ? t("composer.sendHintOffline")
                      : !providerConfigured
                        ? t("composer.sendHintUnconfigured")
                        : t("composer.sendHintReady")
              }
            >
              {busy ? <StopDot /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </div>

      <div className="composer-footer-external">
        {projectName ? (
          <span className="composer-project-badge" title={projectName}>
            <FolderIcon />
            <span>{projectName}</span>
          </span>
        ) : (
          <span className="composer-project-badge is-standalone" title={t("projects.standalone")}>
            <span>{t("projects.standalone")}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function DocFileIcon() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none">
      <rect x="2.5" y="1.5" width="9" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5 5h4M5 7.5h4M5 10h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function ImageFileIcon() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="0.9" />
      <path d="M2 9.5l3-3 2.5 2.5L10 6.5l2 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none">
      <path
        d="M10 4.5v11M4.5 10h11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PencilEditIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path d="M4 14.5l-.6 2.6 2.6-.6L16 6.5a1.5 1.5 0 00-2.1-2.1L4 14.5z" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path
        d="M10 12.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10 2.5l1 1.9 2.1-.3.4 2.1 1.9 1-1 1.9 1 1.9-1.9 1-.4 2.1-2.1-.3-1 1.9-1-1.9-2.1.3-.4-2.1-1.9-1 1-1.9-1-1.9 1.9-1 .4-2.1 2.1.3 1-1.9z"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
        strokeLinejoin="round"
        opacity="0"
      />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none">
      <path
        d="M10 15.5v-11M5 9.5L10 4.5l5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopDot() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path
        d="M3 6.5c0-.8.6-1.4 1.4-1.4h2.8l1.4 1.6h5.6c.8 0 1.4.6 1.4 1.4v5.4c0 .8-.6 1.4-1.4 1.4H4.4c-.8 0-1.4-.6-1.4-1.4V6.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}
