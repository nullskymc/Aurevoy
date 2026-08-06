import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentExecutionMode,
  HealthResponse,
  MessageAttachment,
  TaskSummary,
} from "@aurevoy/shared";
import {
  clearTaskQueue,
  createProject,
  deleteProject,
  deleteTask,
  getTask,
  listTaskTraces,
  resumeAutoMode as resumeAutoModeApi,
  updateSettings,
  updateTaskModel,
} from "./api";
import { usePlatform } from "./platform/context";
import { useAgentEventHandler } from "./hooks/useAgentEventHandler";
import { useArtifacts } from "./hooks/useArtifacts";
import { useAutomations } from "./hooks/useAutomations";
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
import { ContextUsageRing } from "./components/ContextUsageRing";
import { AgentStatusDock } from "./components/AgentStatusDock";
import { SetupPanel } from "./components/SetupPanel";
import { ApprovalsDock, Conversation } from "./components/Conversation";
import { AppTopBar } from "./components/AppTopBar";
import { SessionTreeDialog } from "./components/SessionTreeDialog";
import { TracePanel } from "./components/TracePanel";
import { ModelSelectorDrawer, type ModelSelectorDraft } from "./components/ModelSelectorDrawer";
import { WorkbenchPanel } from "./components/WorkbenchPanel";
import { OutputFloatPanel } from "./components/OutputFloatPanel";
import { PlanFloatPanel } from "./components/PlanFloatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchPopover } from "./components/SearchPopover";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import { ToastNotice, type ToastTone } from "./components/ToastNotice";
import { SkillsPage } from "./pages/SkillsPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { SETTINGS_SECTION_IDS, type MainView, type SettingsSectionId } from "./app/types";
import { formatContextK } from "./app/taskUtils";
import { buildTrayRecentItems, createTrayRecentSignature } from "./app/trayRecent";
import { t } from "./i18n";
import "./App.css";
import { HeroSuggestionIcon } from "./icons";


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
  const [executionMode, setExecutionMode] = useState<AgentExecutionMode>("auto");
  const [searchPopoverOpen, setSearchPopoverOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("general");
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
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
    outputStore,
    phase,
    plan,
    status,
    tasks,
    traces,
    setBusy,
    setCurrentTask,
    setOutput,
    appendOutput,
    setPhase,
    setPlan,
    setStatus,
    setTasks,
    setTraces,
    patchCurrentTask,
    updateTaskList,
  } = useTaskState();
  const { closeStream, openStream, syncEventHandler } = useSSEStream();
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
  const {
    automations,
    loading: automationsLoading,
    refresh: refreshAutomations,
    create: createAutomationRecipe,
    update: updateAutomationRecipe,
    remove: removeAutomationRecipe,
    run: runAutomationRecipe,
    loadRuns: loadAutomationRuns,
  } = useAutomations();
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
    handleExportData,
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

  /**
   * P1-2 模型粘性：有活动任务时，模型 / 推理档切换落到该任务（运行中即时生效），
   * 而不是改全局默认。成功后同步本地 currentTask.modelSnapshot（SSE 也会再推一次，幂等）。
   */
  async function applyTaskModelSelection(draft: ModelSelectorDraft): Promise<void> {
    const taskId = currentTask?.id;
    if (!taskId) return;
    try {
      const res = await updateTaskModel(taskId, { provider: draft.provider, model: draft.model });
      patchCurrentTask({ modelSnapshot: res.modelSnapshot });
      setModelDrawerOpen(false);
    } catch (err) {
      setNotice(`切换任务模型失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 活动任务的推理档切换：落任务快照，同时刷新本地 chip。 */
  async function applyTaskThinkingLevel(level: ThinkingUILevel): Promise<void> {
    setThinkingLevel(level);
    localStorage.setItem("aurevoy.thinkingLevel", level);
    const taskId = currentTask?.id;
    if (!taskId) return;
    try {
      const res = await updateTaskModel(taskId, { thinkingLevel: level });
      patchCurrentTask({ modelSnapshot: res.modelSnapshot });
    } catch (err) {
      setNotice(`切换推理档失败: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  const {
    clearLiveState,
    derivedLive,
    handleEvent,
    liveContentBlocks,
    phaseDetail,
    retryStatus: agentRetryStatus,
    pendingQueue: agentPendingQueue,
    lastCompaction: agentLastCompaction,
    dismissCompaction: dismissAgentCompaction,
  } = useAgentEventHandler({
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
    appendOutput,
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
  syncEventHandler(handleEvent);
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
    executionMode,
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

  // 托盘只消费标题、项目副标题和最近顺序；隔离 plan/messages/phase 等 SSE 高频状态。
  const trayRecentSnapshot = useMemo(() => {
    const items = buildTrayRecentItems(tasks, projects);
    return { items, signature: createTrayRecentSignature(items) };
  }, [tasks, projects]);
  const stableTrayRecentRef = useRef(trayRecentSnapshot);
  if (stableTrayRecentRef.current.signature !== trayRecentSnapshot.signature) {
    stableTrayRecentRef.current = trayRecentSnapshot;
  }
  const trayRecentItems = stableTrayRecentRef.current.items;

  // 同步最近任务到系统托盘菜单（macOS 菜单栏 / Windows 托盘）
  useEffect(() => {
    if (!platform.updateTrayRecent) return;
    void platform.updateTrayRecent(trayRecentItems);
  }, [platform, trayRecentItems]);

  // 托盘动作回调用 ref，避免每次 render 重绑 listen
  const trayHandlersRef = useRef({
    handleNewTask,
    handleSelectTask,
    updateTaskList,
    setActiveView,
    setNotice,
    tasks,
  });
  trayHandlersRef.current = {
    handleNewTask,
    handleSelectTask,
    updateTaskList,
    setActiveView,
    setNotice,
    tasks,
  };

  useEffect(() => {
    if (!platform.onTrayAction) return;
    return platform.onTrayAction((action) => {
      const h = trayHandlersRef.current;
      if (action.action === "new-chat") {
        h.handleNewTask();
        return;
      }
      if (action.action === "open") {
        h.setActiveView("chat");
        return;
      }
      if (action.action === "open-task" && action.taskId) {
        const taskId = action.taskId;
        const cached = h.tasks.find((t) => t.id === taskId);
        if (cached) {
          h.handleSelectTask(cached);
          return;
        }
        void getTask(taskId)
          .then((task) => {
            h.handleSelectTask(task);
            h.updateTaskList(task);
          })
          .catch((err) => {
            h.setNotice(
              `${t("notice.connectEngineFailed")}${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    });
  }, [platform]);

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
    setSearchPopoverOpen(false);
    setModelDrawerOpen(false);
    setSettingsInitialSection(nextSection);
    setActiveView("settings");
    setWorkbenchOpen(false);
    void refreshSettings();
    if (nextSection === "memory") void refreshMemories();
  }

  function handleCloseSettings(): void {
    setNotice(null);
    setSearchPopoverOpen(false);
    setWorkbenchOpen(false);
    setActiveView("chat");
  }

  function handleOpenModelSelector(): void {
    setNotice(null);
    setSearchPopoverOpen(false);
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
    setSearchPopoverOpen(true);
  }

  function handleOpenSkills(): void {
    setModelDrawerOpen(false);
    setSearchPopoverOpen(false);
    setActiveView("skills");
    setWorkbenchOpen(false);
    void refreshRuntime();
  }

  function handleOpenAutomations(): void {
    setModelDrawerOpen(false);
    setSearchPopoverOpen(false);
    setActiveView("automations");
    setWorkbenchOpen(false);
    void refreshAutomations();
  }

  function handleOpenAutomationTask(taskId: string): void {
    setSearchPopoverOpen(false);
    void getTask(taskId)
      .then((task) => handleSelectTask(task))
      .catch((error) => setNotice(`打开自动化任务失败：${error instanceof Error ? error.message : String(error)}`));
  }

  function handleSearchTaskSelect(task: TaskSummary): void {
    setSearchPopoverOpen(false);
    handleSelectTask(task);
  }

  function handleSearchNewTask(): void {
    setSearchPopoverOpen(false);
    handleNewTask();
  }

  function handleSearchOpenFolder(): void {
    setSearchPopoverOpen(false);
    void handleImportProject();
  }

  function handleSearchFiles(): void {
    setSearchPopoverOpen(false);
    handleNewTask();
    setGoal(t("search.filePrompt"));
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
    // 审批/追问由对应 UI 处理；预算触顶或完成门禁未通过时可直接续跑
    (currentTask.status !== "paused" ||
      currentTask.phase === "waiting_budget" ||
      currentTask.phase === "waiting_completion");

  const hasLiveTail =
    busy ||
    derivedLive.length > 0 ||
    phase === "waiting_approval";

  const [outputRailOpen, setOutputRailOpen] = useState(true);

  function handleSessionTreeTaskChange(task: NonNullable<typeof currentTask>): void {
    clearLiveState();
    setCurrentTask(task);
    setStatus(task.status);
    setPhase(task.phase);
    setPlan(task.plan);
    setOutput("");
    setTraces([]);
    setExecutionMode(task.executionMode ?? "auto");
    updateTaskList(task);
    void refreshTaskTraces(task.id);
  }

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
        searchOpen={searchPopoverOpen}
        tasks={tasks}
        projects={projects}
        selectedProjectId={draftProjectId ?? currentTask?.projectId}
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onSelectProject={setDraftProjectId}
        onOpenSearch={handleOpenSearch}
        onOpenSkills={handleOpenSkills}
        onOpenAutomations={handleOpenAutomations}
        onOpenSettings={handleOpenSettings}
        onImportProject={handleImportProject}
        onDeleteProject={handleDeleteProject}
        onDeleteTask={handleDeleteTask}
      />

      {searchPopoverOpen ? (
        <SearchPopover
          tasks={tasks}
          projects={projects}
          onClose={() => setSearchPopoverOpen(false)}
          onSelectTask={handleSearchTaskSelect}
          onNewTask={handleSearchNewTask}
          onOpenFolder={handleSearchOpenFolder}
          onSearchFiles={handleSearchFiles}
        />
      ) : null}

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
          sessionTreeOpen={sessionTreeOpen}
          tracePanelOpen={tracePanelOpen}
          leftCollapsed={leftCollapsed}
          phase={phase}
          status={status}
          onToggleWorkbench={() => setWorkbenchOpen((open) => !open)}
          onToggleOutputRail={() => setOutputRailOpen((open) => !open)}
          onToggleSessionTree={() => setSessionTreeOpen((open) => !open)}
          onToggleTracePanel={() => {
            setTracePanelOpen((open) => {
              const next = !open;
              if (next && currentTask) void refreshTaskTraces(currentTask.id);
              return next;
            });
          }}
          onToggleSidebar={() => setLeftCollapsed((collapsed) => !collapsed)}
        />

        <div className="main-stage">
          {activeView === "skills" ? (
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
          ) : activeView === "automations" ? (
            <AutomationsPage
              automations={automations}
              projects={projects}
              loading={automationsLoading}
              onRefresh={refreshAutomations}
              onCreate={createAutomationRecipe}
              onUpdate={updateAutomationRecipe}
              onDelete={removeAutomationRecipe}
              onRun={runAutomationRecipe}
              onLoadRuns={loadAutomationRuns}
              onOpenTask={handleOpenAutomationTask}
              onNotice={setNotice}
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
              onExportData={handleExportData}
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
                  outputStore={outputStore}
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
                  compaction={agentLastCompaction}
                />
              </div>
              <div className="composer-dock">
                <ApprovalsDock
                  liveToolActivity={derivedLive}
                  pendingApprovals={currentTask.pendingApprovals}
                  onToolDecision={handleToolDecision}
                />
                <AgentStatusDock
                  retry={agentRetryStatus}
                  queue={agentPendingQueue}
                  compaction={agentLastCompaction}
                  formatTokens={formatContextK}
                  onDismissCompaction={dismissAgentCompaction}
                  onClearQueue={(kind) => {
                    if (!currentTask) return;
                    void clearTaskQueue(currentTask.id, kind).catch((err) => {
                      setNotice(`${t("agentStatus.queueClearFailed")}: ${err instanceof Error ? err.message : String(err)}`);
                    });
                  }}
                />
                {health?.contextTokenBudget != null && currentTask && currentTask.messages.length > 0 && (
                  <ContextUsageRing
                    usedTokens={currentTask.contextTokens ?? 0}
                    tokenBudget={health.contextTokenBudget}
                    label={t("context.label")}
                    unit={t("context.unit")}
                    formatTokens={formatContextK}
                  />
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
                  executionMode={executionMode}
                  onExecutionModeChange={setExecutionMode}
                  thinkingLevel={thinkingLevel}
                  taskModelSnapshot={currentTask?.modelSnapshot ?? null}
                  onCycleThinkingLevel={cycleThinkingLevel}
                />
                <ModelSelectorDrawer
                  open={modelDrawerOpen}
                  provider={
                    currentTask?.modelSnapshot
                      ? `${currentTask.modelSnapshot.provider}:${currentTask.modelSnapshot.model}`
                      : health?.provider
                  }
                  settings={runtimeSettings}
                  saving={settingsSaving}
                  anchorRef={modelButtonRef}
                  thinkingLevel={currentTask?.modelSnapshot?.thinkingLevel ?? thinkingLevel}
                  onThinkingLevelChange={applyTaskThinkingLevel}
                  onClose={() => setModelDrawerOpen(false)}
                  onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
                  onSave={applyTaskModelSelection}
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
                executionMode={executionMode}
                onExecutionModeChange={setExecutionMode}
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
          <PlanFloatPanel task={currentTask} />
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

      {currentTask && (
        <SessionTreeDialog
          open={sessionTreeOpen}
          task={currentTask}
          busy={busy}
          onOpenChange={setSessionTreeOpen}
          onTaskChange={handleSessionTreeTaskChange}
          onNotice={setNotice}
        />
      )}

      {currentTask && (
        <TracePanel
          open={tracePanelOpen}
          traces={traces}
          onOpenChange={setTracePanelOpen}
          onRefresh={() => void refreshTaskTraces(currentTask.id)}
        />
      )}

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
