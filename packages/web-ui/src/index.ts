/**
 * @aurevoy/web-ui — 平台无关的 Aurevoy 前端界面包。
 *
 * 提供完整的 Agent 工作台 UI，通过 PlatformAdapter 与平台壳解耦。
 * 桌面 (Tauri)、Android (WebView)、浏览器均可使用。
 */
export { default as App } from './App';

// 平台抽象
export type {
  PlatformAdapter,
  AppUpdateInfo,
  AppUpdateProgress,
  TrayRecentItem,
  TrayAction,
} from './platform/types';
export { PlatformContext, usePlatform, browserPlatform } from './platform';

// API 客户端
export {
  checkHealth,
  createTask,
  listTasks,
  getTask,
  continueTask,
  resumeTask,
  revertTask,
  unrevertTask,
  branchTask,
  compactTask,
  listTaskTraces,
  cancelTask,
  deleteTask,
  approveToolCall,
  answerClarification,
  updateArtifact,
  listTools,
  fetchSkills,
  installSkill,
  uninstallSkill,
  updateTool,
  getSettings,
  updateSettings,
  listProviderModels,
  getMcpStatus,
  getDataStatus,
  cleanupData,
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  approvePlan,
} from './api';

// Hooks
export { useTaskState } from './hooks/useTaskState';
export { useSSEStream } from './hooks/useSSEStream';
export { useSettings } from './hooks/useSettings';
export { useTools } from './hooks/useTools';
export { useSkills } from './hooks/useSkills';
export { useArtifacts } from './hooks/useArtifacts';
export { useMemories } from './hooks/useMemories';
export { useProjects } from './hooks/useProjects';
