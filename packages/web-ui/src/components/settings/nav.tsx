import { t } from "../../i18n";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "../../app/types";
import type { SettingsIconName } from "./types";
export { SettingsNavIcon } from "../../icons";

export function getSettingsGroups(): Array<{
  label: string;
  items: Array<{ id: SettingsSectionId; label: string; icon: SettingsIconName }>;
}> {
  return [
    {
      label: t("settings.group.personal"),
      items: [
        { id: "general", label: t("settings.nav.general"), icon: "sliders" },
        { id: "appearance", label: t("settings.nav.appearance"), icon: "appearance" },
      ],
    },
    {
      label: t("settings.group.server"),
      items: [
        { id: "provider", label: t("settings.nav.provider"), icon: "spark" },
        { id: "models", label: t("settings.nav.models"), icon: "models" },
        { id: "mcp", label: t("settings.nav.mcp"), icon: "server" },
        { id: "search", label: t("settings.nav.search"), icon: "search" },
      ],
    },
    {
      label: t("settings.group.data"),
      items: [
        { id: "data", label: t("settings.nav.data"), icon: "database" },
        { id: "usage", label: t("settings.nav.usage"), icon: "usage" },
        { id: "kb", label: t("settings.nav.knowledgeBase"), icon: "kb" },
        { id: "memory", label: t("settings.nav.memory"), icon: "memory" },
      ],
    },
  ];
}

export function normalizeSettingsSection(section?: SettingsSectionId): SettingsSectionId {
  return section && SETTINGS_SECTION_IDS.includes(section) ? section : "general";
}
