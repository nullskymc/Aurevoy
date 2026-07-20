import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t, type TranslationKey } from "../i18n";
import { usePlatform } from "../platform/context";
import { ImageViewer } from "./ImageViewer";
import type { AgentExecutionMode, LlmReadiness, LlmReadyState, MessageAttachment, SkillDescriptor } from "@aurevoy/shared";
import { formatModelEffortChipLabel } from "./ModelSelectorDrawer";
import {
  IconArrowUp,
  IconFile,
  IconFolder,
  IconImage,
  IconPlus,
  IconSquare,
  IconX,
} from "../icons";
import "./Composer.css";

interface SlashCommand {
  name: string;
  descriptionKey?: TranslationKey;
  description?: string;
}

export type ThinkingUILevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const THINKING_LEVEL_CYCLE: ThinkingUILevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh',
];

interface ComposerProps {
  value: string;
  busy: boolean;
  /** Skill: 动态 skill 列表，用于斜杠命令自动完成。 */
  skills?: SkillDescriptor[];
  online: boolean | null;
  /** hero: 居中空状态的大输入框；docked: 对话底部的停靠输入框 */
  variant?: "hero" | "docked";
  /**
   * 兼容 health.provider：`provider:model` 或 `unconfigured`。
   * 细粒度就绪优先用 llm。
   */
  provider?: string;
  /** health.llm：按缺项引导（凭证 / 模型） */
  llm?: LlmReadiness | null;
  projectName?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onOpenModelSelector: () => void;
  /** 模型按钮 ref，用于弹层定位锚点 */
  modelButtonRef?: React.RefObject<HTMLButtonElement | null>;
  /** busy 时点击发送按钮触发停止/取消 */
  onStop?: () => void;
  /** 拖拽/选择的附件列表 */
  attachments?: MessageAttachment[];
  /** 附件变更回调 */
  onAttachmentsChange?: (attachments: MessageAttachment[]) => void;
  /** 粘贴文件回调：Composer 从剪贴板提取图片后通知父组件创建附件 */
  onPasteFiles?: (files: Array<{ name: string; dataUrl: string; mimeType: string }>) => void;
  /** 点击 "+" 按钮打开文件选择器 */
  onPickAttachments?: () => void;
  /** Agent 自动执行被暂停时 */
  autoModePaused?: boolean;
  /** 恢复暂停的自动执行 */
  onResumeAutoMode?: () => void;
  /** 当前输入将创建的任务模式；属于本次发送而非全局设置。 */
  executionMode?: AgentExecutionMode;
  onExecutionModeChange?: (mode: AgentExecutionMode) => void;
  /** 推理深度（与模型能力相关，仅支持推理的模型会生效） */
  thinkingLevel?: ThinkingUILevel;
  /** @deprecated 已合并进模型菜单；保留 prop 以免破坏外部调用 */
  onCycleThinkingLevel?: () => void;
}

const IME_ENTER_GUARD_MS = 120;

export function Composer({
  value,
  busy,
  online,
  variant = "hero",
  provider,
  llm,
  projectName,
  skills,
  attachments,
  onAttachmentsChange,
  onPasteFiles,
  onPickAttachments,
  onChange,
  onSubmit,
  onOpenModelSelector,
  modelButtonRef,
  onStop,
  autoModePaused,
  onResumeAutoMode,
  executionMode = "auto",
  onExecutionModeChange,
  thinkingLevel = "medium",
}: ComposerProps) {
  const platform = usePlatform();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const llmState: LlmReadyState | "offline" | "unknown" = (() => {
    if (online === false) return "offline";
    if (llm?.state) return llm.state;
    if (provider === "unconfigured") return "no_credential";
    if (provider && provider !== "unconfigured") return "ready";
    return "unknown";
  })();
  const llmReady = llmState === "ready";
  const canSend = value.trim().length > 0 && !busy && online !== false && llmReady;
  /** health.provider 形如 "openai:gpt-4o-mini" 或纯 provider id */
  const providerId = llm?.provider
    || (provider && provider !== "unconfigured"
      ? (provider.includes(":") ? provider.split(":")[0]! : provider)
      : null);
  const modelId = llm?.model
    || (provider && provider.includes(":")
      ? provider.slice(provider.indexOf(":") + 1)
      : null);
  const providerChipLabel = (() => {
    if (llmState === "offline" || online === null) {
      return online === false ? t("composer.providerDisconnected") : t("composer.engineChecking");
    }
    if (llmState === "no_provider" || llmState === "no_credential") {
      return t("composer.providerUnconfigured");
    }
    if (llmState === "no_model") {
      return t("composer.providerNoModel");
    }
    if (!providerId || !modelId) {
      return provider === "unconfigured"
        ? t("composer.providerUnconfigured")
        : t("composer.providerDisconnected");
    }
    return formatModelEffortChipLabel(modelId, thinkingLevel);
  })();

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
    const isEnterAfterCompositionEnd =
      event.key === "Enter" && Date.now() - lastCompositionEndAtRef.current < IME_ENTER_GUARD_MS;
    const isImeComposing =
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      isEnterAfterCompositionEnd;

    if (isImeComposing) {
      if (isEnterAfterCompositionEnd && !event.shiftKey) {
        event.preventDefault();
      }
      return;
    }

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

    // Enter 提交，Shift+Enter 换行（输入法组合期间不提交）
    if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  function handleRemoveAttachment(id: string): void {
    onAttachmentsChange?.((attachments ?? []).filter((a) => a.id !== id));
  }

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
    // 网页 DataTransfer 文件用 copy；桌面原生路径拖入仍由 Tauri 事件处理
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'link';
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
    // 桌面壳：原生路径由 Tauri onFileDrop 处理。网页：从 DataTransfer.files 读 dataUrl。
    if (!onPasteFiles) return;
    const fileList = e.dataTransfer?.files;
    if (!fileList || fileList.length === 0) return;
    void readImageFiles(Array.from(fileList)).then((files) => {
      if (files.length > 0) onPasteFiles(files);
    });
  }

  function handlePaste(e: React.ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items || !onPasteFiles) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) imageItems.push(items[i]);
    }
    if (imageItems.length === 0) return;

    // 阻止把图片当二进制糊进输入框
    e.preventDefault();

    const reads: Promise<{ name: string; dataUrl: string; mimeType: string } | null>[] = [];
    imageItems.forEach((item, i) => {
      const blob = item.getAsFile();
      if (!blob) return;
      const ext = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const name = `clipboard-${Date.now()}-${i}.${ext}`;
      reads.push(readBlobAsAttachment(blob, name, item.type));
    });

    if (reads.length === 0) return;
    void Promise.all(reads).then((results) => {
      const files = results.filter((r): r is NonNullable<typeof r> => r !== null);
      if (files.length > 0) onPasteFiles(files);
    });
  }

  const hasAttachments = attachments && attachments.length > 0;

  return (
    <div
      className="composer"
      data-variant={variant}
      data-has-project={projectName ? "true" : "false"}
      data-dragover={isDragOver ? "true" : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      <div className="composer-stack">
        {projectName ? (
          <div className="composer-project-bar" title={projectName}>
            <FolderIcon />
            <span className="composer-project-bar-name">{projectName}</span>
          </div>
        ) : null}

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
                  <span className="cmd-popup-desc">{cmd.descriptionKey ? t(cmd.descriptionKey) : (cmd.description ?? "")}</span>
                </button>
              ))}
            </div>
          )}

          {hasAttachments && (
            <div className="composer-attachments">
              {attachments!.map((att) => {
                const isImage = att.type === "image";
                const imgSrc = isImage
                  ? (() => {
                      try {
                        return att.dataUrl ?? platform.filePathToUrl(att.path);
                      } catch {
                        return null;
                      }
                    })()
                  : null;

                return (
                  <span
                    key={att.id}
                    className={`composer-attachment-chip${isImage ? " is-image" : ""}`}
                    data-type={isImage ? "image" : "file"}
                    title={att.path}
                  >
                    <span className="composer-attachment-chip-icon">
                      {isImage && imgSrc ? (
                        <img
                          className="composer-attachment-thumb"
                          src={imgSrc}
                          alt={att.name}
                          onClick={() => setViewingImage(att.dataUrl ?? att.path)}
                        />
                      ) : isImage ? (
                        <ImageFileIcon />
                      ) : (
                        <DocFileIcon />
                      )}
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
                );
              })}
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
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
            }}
          />

          <div className="composer-toolbar">
            <div className="composer-tools-left">
              <button
                type="button"
                className="composer-icon-btn"
                title={t("composer.attachment")}
                aria-label={t("composer.attachment")}
                onClick={onPickAttachments}
              >
                <PlusIcon />
              </button>
              {autoModePaused && onResumeAutoMode ? (
                <button
                  type="button"
                  className="composer-mode-chip is-paused"
                  onClick={onResumeAutoMode}
                  title={t("composer.mode.pausedHint")}
                >
                  <span className="auto-mode-dot paused" />
                  <span>{t("composer.mode.paused")}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`composer-mode-chip ${executionMode === "plan" ? "is-plan" : "is-agent"}`}
                  disabled={busy || !onExecutionModeChange}
                  onClick={() => onExecutionModeChange?.(executionMode === "auto" ? "plan" : "auto")}
                  title={executionMode === "plan" ? t("composer.mode.planHint") : t("composer.mode.agentHint")}
                >
                  <span className={`auto-mode-dot ${executionMode === "plan" ? "plan" : ""}`} />
                  <span>{executionMode === "plan" ? t("composer.mode.plan") : t("composer.mode.agent")}</span>
                </button>
              )}
            </div>

            <div className="composer-tools-right">
              <button
                ref={modelButtonRef}
                type="button"
                className="composer-chip composer-model-chip composer-model-effort-chip"
                title={
                  llmReady && providerId && modelId
                    ? `${providerId}:${modelId} · ${thinkingLevel}`
                    : providerChipLabel
                }
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onOpenModelSelector}
              >
                <span>{providerChipLabel}</span>
              </button>
              <button
                type="button"
                className="composer-send"
                data-busy={busy ? "true" : undefined}
                disabled={busy ? !onStop : !canSend}
                onClick={busy ? onStop : onSubmit}
                aria-label={busy ? t("action.stop") : t("composer.send")}
                title={
                  busy
                    ? t("composer.stopHint")
                    : !value.trim()
                      ? t("composer.sendHintEmpty")
                      : online === false
                        ? t("composer.sendHintOffline")
                        : llmState === "no_model"
                          ? t("composer.sendHintNoModel")
                          : llmState === "no_credential" || llmState === "no_provider"
                            ? t("composer.sendHintUnconfigured")
                            : !llmReady
                              ? t("composer.sendHintUnconfigured")
                              : t("composer.sendHintReady")
                }
              >
                {busy ? <StopDot /> : <ArrowUpIcon />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {viewingImage && (
        <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
      )}
    </div>
  );
}

async function readImageFiles(
  files: File[],
): Promise<Array<{ name: string; dataUrl: string; mimeType: string }>> {
  const results: Array<{ name: string; dataUrl: string; mimeType: string } | null> = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const mimeType = file.type || 'image/png';
    const name = file.name || `drop-${Date.now()}.png`;
    results.push(await readBlobAsAttachment(file, name, mimeType));
  }
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

function readBlobAsAttachment(
  blob: Blob,
  name: string,
  mimeType: string,
): Promise<{ name: string; dataUrl: string; mimeType: string } | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve({ name, dataUrl: reader.result, mimeType });
      } else {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export function nextThinkingLevel(current: ThinkingUILevel): ThinkingUILevel {
  const idx = THINKING_LEVEL_CYCLE.indexOf(current);
  return THINKING_LEVEL_CYCLE[(idx < 0 ? 0 : idx + 1) % THINKING_LEVEL_CYCLE.length];
}

function DocFileIcon() {
  return <IconFile size={14} />;
}

function ImageFileIcon() {
  return <IconImage size={14} />;
}

function XIcon() {
  return <IconX size={12} />;
}

function PlusIcon() {
  return <IconPlus size={18} />;
}

function ArrowUpIcon() {
  return <IconArrowUp size={18} strokeWidth={2} />;
}

function StopDot() {
  return <IconSquare size={14} fill="currentColor" strokeWidth={0} />;
}

function FolderIcon() {
  return <IconFolder size={14} />;
}
