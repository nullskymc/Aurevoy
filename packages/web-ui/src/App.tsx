import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HealthResponse,
  MessageAttachment,
} from "@aurevoy/shared";
import {
  createProject,
  deleteProject,
  deleteTask,
  listTaskTraces,
  resumeAutoMode as resumeAutoModeApi,
  updateSettings,
} from "./api";
import { usePlatform } from "./platform/context";
import { useAgentEventHandler } from "./hooks/useAgentEventHandler";
import { useArtifacts } from "./hooks/useArtifacts";
import { useAttachments } from "./hooks/useAttachments";
import { useMemories } from "./hooks/useMemories";
import { useSSEStream } from "./hooks/useSSEStream";
import { useSettings } from "./hooks/useSettings";
import { useTaskState } from "./hooks/useTaskState";
import { useProjects } from "./hooks/useProjects";
import { useRuntimeController } from "./hooks/useRuntimeController";
import { useSettingsController } from "./hooks/useSettingsController";
import { useShellLayout } from "./hooks/useShellLayout";
import { useSkills } from "./hooks/useSkills";
import { useWorkbenchTabs } from "./hooks/useWorkbenchTabs";
import { useTaskController } from "./hooks/useTaskController";
import { Composer, nextThinkingLevel, type ThinkingUILevel } from "./components/Composer";
import { SetupPanel } from "./components/SetupPanel";
import { ApprovalsDock, Conversation } from "./components/Conversation";
import { AppTopBar } from "./components/AppTopBar";
import { ModelSelectorDrawer } from "./components/ModelSelectorDrawer";
import { WorkbenchPanel } from "./components/WorkbenchPanel";
import { OutputFloatPanel } from "./components/OutputFloatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import { ToastNotice, type ToastTone } from "./components/ToastNotice";
import { SearchPage } from "./pages/SearchPage";
import { SkillsPage } from "./pages/SkillsPage";
import { SETTINGS_SECTION_IDS, type MainView, type SettingsSectionId } from "./app/types";
import { formatContextK } from "./app/taskUtils";
import { t } from "./i18n";
import "./App.css";

function HeroSuggestionIcon({ kind }: { kind: "explore" | "build" | "review" | "fix" }) {
  if (kind === "explore") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 14.5c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5M8 10V7.5a4 4 0 018 0V10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M7.5 14.5h9l.8 4.2a1.2 1.2 0 01-1.2 1.4H7.9a1.2 1.2 0 01-1.2-1.4L7.5 14.5z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M10 6.2l1.2-2.4h1.6L14 6.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "build") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M14.5 5.5l4 4M8 18l-2.2.6c-.5.1-.9-.3-.8-.8L5.6 15.6 13.2 8a2.2 2.2 0 013.1 0l.1.1a2.2 2.2 0 010 3.1L8 18z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "review") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7.5 9.5A4.5 4.5 0 0116 8.2M16.5 14.5A4.5 4.5 0 018 15.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path d="M16 5.5v3h3M8 18.5v-3H5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="13" r="4.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8.8V6.2M10.2 6.8h3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.2 16.8c-1.4.9-2.7 1.5-3.4 1.3-.4-.1-.6-.6-.4-1 1.1-2.2 2.6-3.4 3.8-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M14.8 16.8c1.4.9 2.7 1.5 3.4 1.3.4-.1.6-.6.4-1-1.1-2.2-2.6-3.4-3.8-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function App() {
  const platform = usePlatform();
  useEffect(() => {
    platform.setupWindowDrag?.(".window-drag-region");
  }, [platform]);
  const [activeView, setActiveView] = useState<MainView>("chat");
  const [goal, setGoal] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const {
    chatFontSize,
    codeFontSize,
    defaultToolDetailsOpen,
    workbenchOpen,
    leftCollapsed,
    locale,
    shellStyle,
    themeMode,
    uiFontSize,
    workMode,
    handleChatFontSizeChange,
    handleCodeFontSizeChange,
    handleUiFontSizeChange,
    handleWorkModeChange,
    setWorkbenchOpen,
    setLeftCollapsed,
    setLocaleState,
    setThemeMode,
    startResize,
  } = useShellLayout();
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingUILevel>(() => {
    const stored = localStorage.getItem("aurevoy.thinkingLevel");
    if (
      stored === "off" || stored === "minimal" || stored === "low" ||
      stored === "medium" || stored === "high" || stored === "xhigh"
    ) {
      return stored;
    }
    return "medium";
  });
  const [autoModeState, setAutoModeState] = useState<{ paused?: boolean; pausedReason?: string; autoApprovedCalls?: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("general");
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [notice, setNoticeState] = useState<{ message: string; tone: ToastTone } | null>(null);
  const setNotice = (message: string | null, tone?: ToastTone) => {
    if (!message) {
      setNoticeState(null);
      return;
    }
    const inferred: ToastTone =
      tone
      ?? (/失败|失敗|failed|error|错误|錯誤|無法|无法|못|에러/i.test(message) ? "error" : "info");
    setNoticeState({ message, tone: inferred });
  };

  // 启动后静默检查更新（仅桌面壳）；有新版本时 toast 提示，不自动安装
  useEffect(() => {
    if (!platform.checkForAppUpdate) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void platform
        .checkForAppUpdate?.()
        .then((info) => {
          if (cancelled || !info?.available || !info.version) return;
          setNotice(
            t("settings.updateAvailable").replace("{version}", info.version),
            "info",
          );
        })
        .catch(() => {
          // 启动检查失败不打扰用户（网络/未配置密钥等）
        });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // 仅挂载时检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  const {
    busy,
    currentTask,
    output,
    phase,
    plan,
    status,
    tasks,
    setBusy,
    setCurrentTask,
    setOutput,
    setPhase,
    setPlan,
    setStatus,
    setTasks,
    setTraces,
    patchCurrentTask,
    updateTaskList,
  } = useTaskState();
  const { closeStream, openStream } = useSSEStream();
  const {
    runtimeSettings,
    mcpServers,
    dataStatus,
    settingsSaving,
    fetchingModels,
    setRuntimeSettings,
    setMcpServers,
    setDataStatus,
    setSettingsSaving,
    setFetchingModels,
  } = useSettings();
  const { projects, setProjects } = useProjects();
  const { memories, setMemories } = useMemories();
  const {
    skills,
    refresh: refreshSkills,
    installing,
    installError,
    install,
    uninstall,
    reloading,
    reload,
    toggle,
  } = useSkills();
  const { mergeArtifact } = useArtifacts(setCurrentTask, updateTaskList);
  const { attachments, handlePickAttachments, handlePasteFiles, setAttachments } = useAttachments({
    platform,
    setNotice,
    setProjects,
  });
  const { bootstrapRuntime, refreshRuntime, runAgentRequest } = useRuntimeController({
    platform,
    setHealth,
    setNotice,
    setOnline,
    setProjects,
    setTasks,
  });
  const {
    handleCleanupData,
    handleCreateMemory,
    handleDeleteMemory,
    handleEditMemory,
    handleActivateProviderModel,
    handleFetchModels,
    handleFetchModelsForProvider,
    handleRemoveProvider,
    handleSaveEnabledModels,
    handleSaveSlotEnabledModels,
    handleSaveSlotImageInputModels,
    handleSaveSlotAvailableModels,
    handleSaveModelSelection,
    handleSaveProviderConnection,
    handleSaveSettings,
    handleToggleMemory,
    refreshMemories,
    refreshSettings,
  } = useSettingsController({
    health,
    onModelSaved: () => setModelDrawerOpen(false),
    refreshRuntime,
    runtimeSettings,
    setDataStatus,
    setFetchingModels,
    setHealth,
    setMcpServers,
    setMemories,
    setNotice,
    setRuntimeSettings,
    setSettingsSaving,
  });

  const [draftProjectId, setDraftProjectId] = useState<string | undefined>();

  // Sync draftProjectId when a task is selected
  useEffect(() => {
    if (currentTask?.projectId) setDraftProjectId(currentTask.projectId);
  }, [currentTask?.projectId]);

  const activeWorkspaceProjectId = draftProjectId ?? currentTask?.projectId;
  const workbenchTabs = useWorkbenchTabs({
    projectId: activeWorkspaceProjectId,
    taskId: currentTask?.id,
  });

  const draftProjectName = useMemo(
    () => projects.find((p) => p.id === activeWorkspaceProjectId)?.name,
    [projects, activeWorkspaceProjectId],
  );

  useEffect(() => {
    void bootstrapRuntime();
  }, []);

  async function handleResumeAutoMode(): Promise<void> {
    if (!currentTask?.id) return;
    try {
      await resumeAutoModeApi(currentTask.id);
      setAutoModeState((prev) => prev ? { ...prev, paused: false, pausedReason: undefined } : null);
    } catch (err) {
      setNotice(`恢复 auto mode 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function cycleThinkingLevel(): void {
    const next = nextThinkingLevel(thinkingLevel);
    setThinkingLevel(next);
    localStorage.setItem("aurevoy.thinkingLevel", next);
    void updateSettings({ agentThinkingLevel: next }).catch(() => {});
  }

  function setThinkingLevelAndPersist(level: ThinkingUILevel): void {
    setThinkingLevel(level);
    localStorage.setItem("aurevoy.thinkingLevel", level);
    void updateSettings({ agentThinkingLevel: level }).catch(() => {});
  }

  // 后端 settings 为推理深度真相源（刷新后与多端一致）
  useEffect(() => {
    const level = runtimeSettings?.agentThinkingLevel;
    if (
      level === "off" || level === "minimal" || level === "low" ||
      level === "medium" || level === "high" || level === "xhigh"
    ) {
      setThinkingLevel(level);
      localStorage.setItem("aurevoy.thinkingLevel", level);
    }
  }, [runtimeSettings?.agentThinkingLevel]);

  const workbenchTabsRef = useRef(workbenchTabs);
  workbenchTabsRef.current = workbenchTabs;

  const { clearLiveState, derivedLive, handleEvent, liveContentBlocks, phaseDetail } = useAgentEventHandler({
    closeStream,
    currentTask,
    mergeArtifact,
    patchCurrentTask,
    refreshRuntime,
    refreshSkills,
    refreshTaskTraces,
    setAutoModeState,
    setBusy,
    setCurrentTask,
    setOutput,
    setPhase,
    setPlan,
    setStatus,
    setTasks,
    setTraces,
    updateTaskList,
    onAttachedPreviewFiles: (paths) => {
      // attach_content：默认在侧边工作台打开并渲染（html/md 等由 FileViewer 预览）
      if (paths.length === 0) return;
      for (const path of paths) {
        workbenchTabsRef.current.openWorkspaceFile(path);
      }
      setActiveView("chat");
      setWorkbenchOpen(true);
    },
  });
  const {
    handleBranch,
    handleClarificationAnswer,
    handleComposerSubmit,
    handleNewTask,

    handleResumeTask,
    handleRevertAndEdit,
    handleSelectTask,
    handleStopStream,
    handleToolDecision,
    handleUnrevert,
  } = useTaskController({
    attachments,
    busy,
    clearLiveState,
    closeStream,
    currentTask,
    draftProjectId,
    goal,
    handleEvent,
    openStream,
    refreshTaskTraces,
    runAgentRequest,
    setActiveView,
    setAttachments,
    setBusy,
    setCurrentTask,
    setDraftProjectId,
    setGoal,
    setModelDrawerOpen,
    setNotice,
    setOnline,
    setOutput,
    setPhase,
    setPlan,
    setStatus,
    setTraces,
    updateTaskList,
  });

  async function refreshTaskTraces(taskId: string): Promise<void> {
    try {
      setTraces(await listTaskTraces(taskId));
    } catch (err) {
      setNotice(`${t("notice.readTracesFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleOpenSettings(section: SettingsSectionId | unknown = "general"): void {
    const nextSection =
      typeof section === "string" && SETTINGS_SECTION_IDS.includes(section as SettingsSectionId)
        ? (section as SettingsSectionId)
        : "general";
    setNotice(null);
    setModelDrawerOpen(false);
    setSettingsInitialSection(nextSection);
    setActiveView("settings");
    setWorkbenchOpen(false);
    void refreshSettings();
    if (nextSection === "memory") void refreshMemories();
  }

  function handleCloseSettings(): void {
    setNotice(null);
    setWorkbenchOpen(false);
    setActiveView("chat");
  }

  function handleOpenModelSelector(): void {
    setNotice(null);
    setModelDrawerOpen(true);
    setWorkbenchOpen(false);
    if (!runtimeSettings) void refreshSettings();
  }

  function handleOpenFullSettingsFromModelDrawer(): void {
    setModelDrawerOpen(false);
    handleOpenSettings("models");
  }

  function handleOpenSearch(): void {
    setModelDrawerOpen(false);
    setActiveView("search");
    setWorkbenchOpen(false);
  }

  function handleOpenSkills(): void {
    setModelDrawerOpen(false);
    setActiveView("skills");
    setWorkbenchOpen(false);
    void refreshRuntime();
  }

  async function handleImportProject(): Promise<void> {
    try {
      if (!platform.openFileDialog) return;
      const selected = await platform.openFileDialog({ directory: true });
      if (!selected) return;
      const project = await createProject({ path: selected[0] });
      setProjects(prev => [...prev, project]);
    } catch (err) {
      setNotice(`导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteProject(projectId: string): Promise<void> {
    if (!confirm(t('projects.deleteConfirm'))) return;
    try {
      await deleteProject(projectId);
      setProjects(prev => prev.filter(p => p.id !== projectId));
    } catch (err) {
      setNotice(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteTask(taskId: string): Promise<void> {
    if (!confirm(t("sidebar.deleteTaskConfirm"))) return;
    try {
      await deleteTask(taskId);
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
      if (currentTask?.id === taskId) {
        closeStream();
        setCurrentTask(null);
        setStatus(null);
        setPhase(null);
        setPlan([]);
        setBusy(false);
        clearLiveState();
      }
    } catch (err) {
      setNotice(`${t("notice.deleteTaskFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const showConversation = currentTask !== null;
  const canResume =
    !!currentTask &&
    !busy &&
    currentTask.status !== "completed" &&
    currentTask.status !== "running" &&
    currentTask.status !== "planning" &&
    // 普通 paused（审批/追问）由对应 UI 处理；预算触顶 paused 可 resume 续跑
    (currentTask.status !== "paused" || currentTask.phase === "waiting_budget");

  const hasLiveTail =
    busy ||
    derivedLive.length > 0 ||
    phase === "waiting_approval" ||
    output.trim().length > 0;

  const [outputRailOpen, setOutputRailOpen] = useState(true);

  /** 输出栏与文件工作台互斥：对话中、工作台关、用户未手动关闭时占右侧列 */
  const showOutputRail =
    activeView === "chat" && showConversation && !workbenchOpen && outputRailOpen;

  return (
    <div
      className="app-shell"
      data-active-view={activeView}
      data-left-collapsed={leftCollapsed}
      data-workbench-open={workbenchOpen}
      data-output-rail={showOutputRail ? "true" : "false"}
      data-theme={themeMode}
      style={shellStyle}
    >
      <TaskHistorySidebar
        activeTaskId={currentTask?.id}
        activeView={activeView}
        tasks={tasks}
        projects={projects}
        selectedProjectId={draftProjectId ?? currentTask?.projectId}
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onSelectProject={setDraftProjectId}
        onOpenSearch={handleOpenSearch}
        onOpenSkills={handleOpenSkills}
        onOpenSettings={handleOpenSettings}
        onImportProject={handleImportProject}
        onDeleteProject={handleDeleteProject}
        onDeleteTask={handleDeleteTask}
      />

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-label={t("a11y.resizeLeft")}
        onPointerDown={(event) => startResize("left", event)}
      />

      <main className="main">
        <AppTopBar
          activeView={activeView}
          currentTask={currentTask}
          workbenchOpen={workbenchOpen}
          outputRailOpen={outputRailOpen}
          leftCollapsed={leftCollapsed}
          phase={phase}
          status={status}
          onToggleWorkbench={() => setWorkbenchOpen((open) => !open)}
          onToggleOutputRail={() => setOutputRailOpen((open) => !open)}
          onToggleSidebar={() => setLeftCollapsed((collapsed) => !collapsed)}
        />

        <div className="main-stage">
          {activeView === "search" ? (
            <SearchPage
              query={searchQuery}
              tasks={tasks}
              onQueryChange={setSearchQuery}
              onSelectTask={handleSelectTask}
            />
          ) : activeView === "skills" ? (
            <SkillsPage
              skills={skills}
              installing={installing}
              installError={installError}
              reloading={reloading}
              onInstall={install}
              onReload={reload}
              onToggle={toggle}
              onUninstall={uninstall}
              onTrySkill={(name) => {
                handleNewTask();
                setGoal(t("skillsPage.tryPrompt").replace("{name}", name));
              }}
            />
          ) : activeView === "settings" ? (
            <SettingsPanel
              settings={runtimeSettings}
              mcpServers={mcpServers}
              dataStatus={dataStatus}
              memories={memories}
              saving={settingsSaving}
              fetchingModels={fetchingModels}
              chatFontSize={chatFontSize}
              uiFontSize={uiFontSize}
              codeFontSize={codeFontSize}
              workMode={workMode}
              themeMode={themeMode}
              locale={locale}
              initialSection={settingsInitialSection}
              onClose={handleCloseSettings}
              onSave={handleSaveSettings}
              onSaveConnection={handleSaveProviderConnection}
              onCleanup={handleCleanupData}
              onRefresh={refreshSettings}
              onFetchModels={handleFetchModels}
              onFetchModelsForProvider={handleFetchModelsForProvider}
              onSaveEnabledModels={handleSaveEnabledModels}
              onSaveSlotEnabledModels={handleSaveSlotEnabledModels}
              onSaveSlotImageInputModels={handleSaveSlotImageInputModels}
              onSaveSlotAvailableModels={handleSaveSlotAvailableModels}
              onSelectModel={handleActivateProviderModel}
              onRemoveProvider={handleRemoveProvider}
              onChatFontSizeChange={handleChatFontSizeChange}
              onUiFontSizeChange={handleUiFontSizeChange}
              onCodeFontSizeChange={handleCodeFontSizeChange}
              onWorkModeChange={handleWorkModeChange}
              onThemeModeChange={setThemeMode}
              onLocaleChange={setLocaleState}
              onCreateMemory={handleCreateMemory}
              onToggleMemory={handleToggleMemory}
              onEditMemory={handleEditMemory}
              onDeleteMemory={handleDeleteMemory}
              onConnectionChange={refreshRuntime}
              onNotice={setNotice}
            />
          ) : showConversation ? (
            <div className="main-chat">
              <div className="main-scroll" ref={mainScrollRef}>
                <Conversation
                  task={currentTask}
                  status={status}
                  phase={phase}
                  phaseDetail={phaseDetail}
                  plan={plan}
                  output={output}
                  busy={busy}
                  liveToolActivity={derivedLive}
                  liveContentBlocks={liveContentBlocks}
                  hasLiveTail={hasLiveTail}
                  defaultToolDetailsOpen={defaultToolDetailsOpen}
                  online={online}
                  onToolDecision={handleToolDecision}
                  onClarificationAnswer={handleClarificationAnswer}
                  canResume={canResume}
                  hasArchivedMessages={(currentTask?.archivedMessages?.length ?? 0) > 0}
                  onUserMessageEdit={(messageId, content, mode, messageAttachments) =>
                    void handleRevertAndEdit(messageId, content, mode, messageAttachments)
                  }
                  onUnrevert={() => void handleUnrevert()}
                  onBranch={(messageId) => void handleBranch(messageId)}
                  onResume={() => void handleResumeTask()}
                  onOpenWorkspacePath={(path) => {
                    workbenchTabs.openWorkspaceFile(path);
                    setWorkbenchOpen(true);
                  }}
                />
              </div>
              <div className="composer-dock">
                <ApprovalsDock
                  liveToolActivity={derivedLive}
                  pendingApprovals={currentTask.pendingApprovals}
                  onToolDecision={handleToolDecision}
                />
                {health?.contextTokenBudget != null && currentTask && currentTask.messages.length > 0 && (
                  <div className="context-hint">
                    {t("context.label")} ~{formatContextK(currentTask.contextTokens ?? 0)} / {formatContextK(health.contextTokenBudget)} {t("context.unit")}
                  </div>
                )}
                <SetupPanel
                  variant="dock"
                  online={online}
                  llm={health?.llm}
                  onConnectProvider={() => handleOpenSettings("provider")}
                  onSelectModel={handleOpenModelSelector}
                />
                <Composer
                  value={goal}
                  busy={busy}
                  online={online}
                  variant="docked"
                  projectName={draftProjectName}
                  skills={skills}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  onPasteFiles={(files) => void handlePasteFiles(files)}
                  onPickAttachments={() => void handlePickAttachments()}
                  provider={health?.provider}
                  llm={health?.llm}
                  onChange={setGoal}
                  onSubmit={handleComposerSubmit}
                  onOpenModelSelector={handleOpenModelSelector}
                  modelButtonRef={modelButtonRef}
                  onStop={handleStopStream}
                  autoModePaused={!!autoModeState?.paused}
                  onResumeAutoMode={handleResumeAutoMode}
                  thinkingLevel={thinkingLevel}
                  onCycleThinkingLevel={cycleThinkingLevel}
                />
                <ModelSelectorDrawer
                  open={modelDrawerOpen}
                  provider={health?.provider}
                  settings={runtimeSettings}
                  saving={settingsSaving}
                  anchorRef={modelButtonRef}
                  thinkingLevel={thinkingLevel}
                  onThinkingLevelChange={setThinkingLevelAndPersist}
                  onClose={() => setModelDrawerOpen(false)}
                  onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
                  onSave={handleSaveModelSelection}
                />
              </div>
            </div>
          ) : (
            <div className="hero">
              <h1 className="hero-title">{t("hero.title")}</h1>
              {online === true && health?.llm && !health.llm.ready ? (
                <SetupPanel
                  variant="hero"
                  online={online}
                  llm={health.llm}
                  onConnectProvider={() => handleOpenSettings("provider")}
                  onSelectModel={handleOpenModelSelector}
                />
              ) : (
                <div className="hero-suggestions" role="list">
                  {(
                    [
                      ["hero.suggestion.explore", "hero.suggestion.explorePrompt", "explore"],
                      ["hero.suggestion.build", "hero.suggestion.buildPrompt", "build"],
                      ["hero.suggestion.review", "hero.suggestion.reviewPrompt", "review"],
                      ["hero.suggestion.fix", "hero.suggestion.fixPrompt", "fix"],
                    ] as const
                  ).map(([labelKey, promptKey, kind]) => (
                    <button
                      key={labelKey}
                      type="button"
                      role="listitem"
                      className="hero-suggestion-card"
                      data-kind={kind}
                      onClick={() => setGoal(t(promptKey))}
                    >
                      <span className="hero-suggestion-icon" aria-hidden="true">
                        <HeroSuggestionIcon kind={kind} />
                      </span>
                      <span className="hero-suggestion-label">{t(labelKey)}</span>
                    </button>
                  ))}
                </div>
              )}
              <Composer
                value={goal}
                busy={busy}
                online={online}
                variant="hero"
                projectName={draftProjectName}
                skills={skills}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                onPasteFiles={(files) => void handlePasteFiles(files)}
                onPickAttachments={() => void handlePickAttachments()}
                provider={health?.provider}
                llm={health?.llm}
                onChange={setGoal}
                onSubmit={handleComposerSubmit}
                onOpenModelSelector={handleOpenModelSelector}
                modelButtonRef={modelButtonRef}
                onStop={handleStopStream}
                autoModePaused={!!autoModeState?.paused}
                onResumeAutoMode={handleResumeAutoMode}
                thinkingLevel={thinkingLevel}
                onCycleThinkingLevel={cycleThinkingLevel}
              />
              <ModelSelectorDrawer
                open={modelDrawerOpen}
                provider={health?.provider}
                settings={runtimeSettings}
                saving={settingsSaving}
                anchorRef={modelButtonRef}
                thinkingLevel={thinkingLevel}
                onThinkingLevelChange={setThinkingLevelAndPersist}
                onClose={() => setModelDrawerOpen(false)}
                onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
                onSave={handleSaveModelSelection}
              />
            </div>
          )}
        </div>
      </main>

      <div
        className="resize-handle resize-handle-right"
        role="separator"
        aria-label={t("a11y.resizeRight")}
        onPointerDown={(event) => startResize("right", event)}
      />

      {/* 右侧列：输出栏（视觉浮卡）与文件工作台互斥，同一 grid 列 */}
      {showOutputRail ? (
        <aside className="output-rail" aria-label={t("output.panelLabel")}>
          <OutputFloatPanel
            task={currentTask}
            liveContentBlocks={liveContentBlocks}
            visible
            onOpenArtifact={(artifact) => {
              if (!currentTask?.id) return;
              workbenchTabs.openArtifact(artifact, currentTask.id);
              setWorkbenchOpen(true);
            }}
            onOpenPath={(path) => {
              workbenchTabs.openWorkspaceFile(path);
              setWorkbenchOpen(true);
            }}
            onOpenWorkbench={() => setWorkbenchOpen(true)}
            onClose={() => setOutputRailOpen(false)}
          />
        </aside>
      ) : null}

      <WorkbenchPanel
        open={workbenchOpen}
        task={currentTask}
        projectId={activeWorkspaceProjectId}
        tabs={workbenchTabs.tabs}
        activeTab={workbenchTabs.activeTab}
        activeTabId={workbenchTabs.activeTabId}
        onSelectTab={workbenchTabs.setActiveTabId}
        onCloseTab={workbenchTabs.closeTab}
        onOpenFile={(path) => {
          workbenchTabs.openWorkspaceFile(path);
          setActiveView("chat");
          setWorkbenchOpen(true);
        }}
        onOpenArtifact={(artifact) => {
          if (!currentTask?.id) return;
          workbenchTabs.openArtifact(artifact, currentTask.id);
          setActiveView("chat");
          setWorkbenchOpen(true);
        }}
        onAttachToChat={(entry) => {
          if (entry.type === "directory") return;
          const att: MessageAttachment = {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: entry.name,
            path: entry.path,
            mimeType: entry.mimeType ?? "application/octet-stream",
            size: entry.size ?? 0,
            type: (entry.mimeType ?? "").startsWith("image/") ? "image" : "file",
          };
          setAttachments((prev) => (prev.some((a) => a.path === att.path) ? prev : [...prev, att]));
          setActiveView("chat");
        }}
      />

      {notice && (
        <ToastNotice
          message={notice.message}
          tone={notice.tone}
          onClose={() => setNotice(null)}
        />
      )}
    </div>
  );
}

export default App;
