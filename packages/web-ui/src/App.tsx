import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HealthResponse,
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
import { useTabs } from "./hooks/useTabs";
import { useTaskController } from "./hooks/useTaskController";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { AppTopBar } from "./components/AppTopBar";
import { ModelSelectorDrawer } from "./components/ModelSelectorDrawer";
import { RightPanel } from "./components/RightPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import { ToastNotice } from "./components/ToastNotice";
import { SearchPage } from "./pages/SearchPage";
import { SkillsPage } from "./pages/SkillsPage";
import { SETTINGS_SECTION_IDS, type AutoModeLevel, type MainView, type SettingsSectionId } from "./app/types";
import { formatContextK } from "./app/taskUtils";
import { t } from "./i18n";
import "./App.css";

function App() {
  const platform = usePlatform();
  useEffect(() => {
    platform.setupWindowDrag?.(".window-drag-region");
  }, [platform]);
  const [activeView, setActiveView] = useState<MainView>("chat");
  const [goal, setGoal] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const workspaceTabs = useTabs();
  const {
    chatFontSize,
    codeFontSize,
    defaultToolDetailsOpen,
    inspectorOpen,
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
    setInspectorOpen,
    setLeftCollapsed,
    setLocaleState,
    setThemeMode,
    startResize,
  } = useShellLayout();
  const [autoModeLevel, setAutoModeLevel] = useState<AutoModeLevel>(() => {
    const stored = localStorage.getItem("aurevoy.autoModeLevel");
    if (stored === 'plan') return 'plan';
    return 'auto';
  });
  const [autoModeState, setAutoModeState] = useState<{ paused?: boolean; pausedReason?: string; autoApprovedCalls?: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("general");
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const { skills, refresh: refreshSkills, installing, installError, install, reloading, reload, toggle } = useSkills();
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
    handleFetchModels,
    handleSaveEnabledModels,
    handleSaveModelSelection,
    handleSaveSettings,
    handleToggleMemory,
    refreshMemories,
    refreshSettings,
  } = useSettingsController({
    health,
    onModelSaved: () => setModelDrawerOpen(false),
    refreshRuntime,
    runtimeSettings,
    setAutoModeLevel,
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

  const draftProjectName = useMemo(
    () => projects.find((p) => p.id === (draftProjectId ?? currentTask?.projectId))?.name,
    [projects, draftProjectId, currentTask?.projectId],
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

  function cycleAutoModeLevel(): void {
    const next = autoModeLevel === 'auto' ? 'plan' : 'auto';
    setAutoModeLevel(next);
    localStorage.setItem("aurevoy.autoModeLevel", next);
    void updateSettings({ autoModeLevel: next }).catch(() => {});
  }

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
  });
  const {
    handleBranch,
    handleClarificationAnswer,
    handleComposerSubmit,
    handleNewTask,
    handlePlanDecision,
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
    editingMessageId,
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
    setEditingMessageId,
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
    setInspectorOpen(false);
    void refreshSettings();
    if (nextSection === "memory") void refreshMemories();
  }

  function handleCloseSettings(): void {
    setNotice(null);
    setInspectorOpen(false);
    setActiveView("chat");
  }

  function handleOpenModelSelector(): void {
    setNotice(null);
    setModelDrawerOpen(true);
    setInspectorOpen(false);
    if (!runtimeSettings) void refreshSettings();
  }

  function handleOpenFullSettingsFromModelDrawer(): void {
    setModelDrawerOpen(false);
    handleOpenSettings("provider");
  }

  function handleOpenSearch(): void {
    setModelDrawerOpen(false);
    setActiveView("search");
    setInspectorOpen(false);
  }

  function handleOpenSkills(): void {
    setModelDrawerOpen(false);
    setActiveView("skills");
    setInspectorOpen(false);
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
    currentTask.status !== "paused";

  const hasLiveTail =
    busy ||
    derivedLive.length > 0 ||
    phase === "waiting_approval" ||
    output.trim().length > 0;
  const activeWorkspaceProjectId = draftProjectId ?? currentTask?.projectId;

  return (
    <div
      className="app-shell"
      data-active-view={activeView}
      data-left-collapsed={leftCollapsed}
      data-inspector-open={inspectorOpen}
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
          inspectorOpen={inspectorOpen}
          leftCollapsed={leftCollapsed}
          phase={phase}
          status={status}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onToggleSidebar={() => setLeftCollapsed((collapsed) => !collapsed)}
        />

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
            onCleanup={handleCleanupData}
            onRefresh={refreshSettings}
            onFetchModels={handleFetchModels}
            onSaveEnabledModels={handleSaveEnabledModels}
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
          />
        ) : showConversation ? (
          <>
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
                onPlanDecision={handlePlanDecision}
                onClarificationAnswer={handleClarificationAnswer}
                canResume={canResume}
                hasArchivedMessages={(currentTask?.archivedMessages?.length ?? 0) > 0}
                onUserMessageEdit={(messageId, content, mode) => void handleRevertAndEdit(messageId, content, mode)}
                onUnrevert={() => void handleUnrevert()}
                onBranch={(messageId) => void handleBranch(messageId)}
                onResume={() => void handleResumeTask()}
              />
            </div>
            <div className="composer-dock">
              {health?.contextTokenBudget != null && currentTask && currentTask.messages.length > 0 && (
                <div className="context-hint">
                  {t("context.label")} ~{formatContextK(currentTask.contextTokens ?? 0)} / {formatContextK(health.contextTokenBudget)} {t("context.unit")}
                </div>
              )}
              <Composer
                value={goal}
                busy={busy}
                online={online}
                variant="docked"
                projectName={draftProjectName}
                isEditing={editingMessageId !== null}
                skills={skills}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                onPasteFiles={(files) => void handlePasteFiles(files)}
                onPickAttachments={() => void handlePickAttachments()}
                onCancelEdit={() => {
                  setEditingMessageId(null);
                  setGoal("");
                  setAttachments([]);
                }}
                provider={health?.provider}
                onChange={setGoal}
                onSubmit={handleComposerSubmit}
                onOpenModelSelector={handleOpenModelSelector}
                modelButtonRef={modelButtonRef}
                onStop={handleStopStream}
                autoModeLevel={autoModeLevel}
                autoModePaused={!!autoModeState?.paused}
                onCycleAutoMode={cycleAutoModeLevel}
                onResumeAutoMode={handleResumeAutoMode}
              />
              <ModelSelectorDrawer
                open={modelDrawerOpen}
                provider={health?.provider}
                settings={runtimeSettings}
                saving={settingsSaving}
                anchorRef={modelButtonRef}
                onClose={() => setModelDrawerOpen(false)}
                onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
                onSave={handleSaveModelSelection}
              />
            </div>
          </>
        ) : (
          <div className="hero">
            <h1 className="hero-title">{t("hero.title")}</h1>
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
              onChange={setGoal}
              onSubmit={handleComposerSubmit}
              onOpenModelSelector={handleOpenModelSelector}
              modelButtonRef={modelButtonRef}
              onStop={handleStopStream}
              autoModeLevel={autoModeLevel}
              autoModePaused={!!autoModeState?.paused}
              onCycleAutoMode={cycleAutoModeLevel}
              onResumeAutoMode={handleResumeAutoMode}
            />
            <ModelSelectorDrawer
              open={modelDrawerOpen}
              provider={health?.provider}
              settings={runtimeSettings}
              saving={settingsSaving}
              anchorRef={modelButtonRef}
              onClose={() => setModelDrawerOpen(false)}
              onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
              onSave={handleSaveModelSelection}
            />
          </div>
        )}
      </main>

      <div
        className="resize-handle resize-handle-right"
        role="separator"
        aria-label={t("a11y.resizeRight")}
        onPointerDown={(event) => startResize("right", event)}
      />

      <RightPanel
        open={inspectorOpen}
        task={currentTask}
        projectId={activeWorkspaceProjectId}
        tabs={workspaceTabs.tabs}
        activeTab={workspaceTabs.activeTab}
        activeTabId={workspaceTabs.activeTabId}
        onSelectTab={workspaceTabs.setActiveTabId}
        onCloseTab={workspaceTabs.closeTab}
        onAddTab={() => workspaceTabs.openEmptyTab(t("rightPanel.openFile"))}
        onOpenFile={(path) => {
          workspaceTabs.openWorkspaceFile(path);
          setActiveView("chat");
          setInspectorOpen(true);
        }}
      />

      {notice && <ToastNotice message={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

export default App;
