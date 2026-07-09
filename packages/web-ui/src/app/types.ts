export type MainView = "chat" | "search" | "skills" | "settings";
export type SettingsSectionId = "general" | "appearance" | "provider" | "mcp" | "data" | "memory" | "kb" | "search" | "usage";
export type ThemeMode = "system" | "light" | "dark";
export type WorkMode = "coding" | "daily";
export type AutoModeLevel = "auto" | "plan";

export const SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "general",
  "appearance",
  "provider",
  "mcp",
  "data",
  "memory",
  "kb",
  "search",
  "usage",
];
