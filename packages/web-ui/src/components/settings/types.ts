import type {
  DataStatusResponse,
  McpServerStatus,
  MemoryCategory,
  MemoryEntry,
  RuntimeSettings,
} from "@aurevoy/shared";
import type { Locale } from "../../i18n";
import type { SettingsSectionId, ThemeMode, WorkMode } from "../../app/types";

export type { SettingsSectionId, ThemeMode, WorkMode };

export interface KbDir {
  id: string;
  dirPath: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KbIndexStatus {
  totalFiles: number;
  totalChunks: number;
  lastIndexed: string | null;
}

export interface SettingsDraft {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  workspaceDir: string;
  /** 最大输出 token；temperature/timeout 已不再驱动主循环，故不暴露 UI */
  maxTokens: number;
  commandExecutionEnabled: boolean;
  autoModeSafetyEnabled: boolean;
  agentToolExecution: string;
  mcpServersJson: string;
  cleanupPolicyDays: number;
  /** 新建任务默认：单次执行 / 任务寿命预算 */
  budgetRunMaxIterations: number;
  budgetRunMaxToolCalls: number;
  budgetRunMaxWallTimeMin: number;
  budgetLifetimeMaxIterations: number;
  budgetLifetimeMaxToolCalls: number;
  budgetLifetimeMaxWallTimeMin: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  searchProvider: string;
  searchBaseUrl: string;
  searchApiKey: string;
  /** 引擎运维日志等级 */
  logLevel: string;
  /** Agent 出站 HTTP(S) 代理 */
  proxyEnabled: boolean;
  proxyUrl: string;
  proxyNoProxy: string;
}

export interface SettingsPanelProps {
  settings: RuntimeSettings | null;
  mcpServers: McpServerStatus[];
  dataStatus: DataStatusResponse | null;
  memories: MemoryEntry[];
  saving: boolean;
  fetchingModels: boolean;
  chatFontSize: number;
  uiFontSize: number;
  codeFontSize: number;
  workMode: WorkMode;
  themeMode: ThemeMode;
  locale: Locale;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
  /** Provider 连接专用：只保存 key / baseUrl / maxTokens；silent 时不弹「已保存」toast（OAuth 成功路径用） */
  onSaveConnection: (draft: SettingsDraft, options?: { silent?: boolean }) => void | Promise<void>;
  onCleanup: (olderThanDays: number) => void;
  onRefresh: () => void;
  onFetchModels: () => void;
  onFetchModelsForProvider: (provider: string, options?: { silent?: boolean }) => void;
  onSaveEnabledModels: (models: string[]) => void;
  onSaveSlotEnabledModels: (provider: string, models: string[]) => void;
  /** 更新模型注册表中的图片输入能力。 */
  onSaveSlotImageInputModels: (provider: string, models: string[]) => void;
  /** 更新槽位 availableModels（自定义添加 / 删除） */
  onSaveSlotAvailableModels: (provider: string, models: string[]) => void;
  /** 点击模型名：切换并保存当前主模型 */
  onSelectModel: (provider: string, model: string) => void;
  onRemoveProvider: (provider: string) => void;
  onChatFontSizeChange: (size: number) => void;
  onUiFontSizeChange: (size: number) => void;
  onCodeFontSizeChange: (size: number) => void;
  onWorkModeChange: (mode: WorkMode) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
  onCreateMemory: (content: string, category: MemoryCategory) => void;
  onToggleMemory: (id: string, enabled: boolean) => void;
  onEditMemory: (id: string, content: string, category: MemoryCategory) => void;
  onDeleteMemory: (id: string) => void;
  onConnectionChange?: () => void;
  /** 全局 Toast 提示（OAuth 成功/失败等）；tone 可选，默认按文案推断 */
  onNotice?: (message: string, tone?: "info" | "success" | "error") => void;
}

export type SettingsIconName =
  | "appearance"
  | "database"
  | "kb"
  | "memory"
  | "models"
  | "search"
  | "server"
  | "sliders"
  | "spark"
  | "usage";
