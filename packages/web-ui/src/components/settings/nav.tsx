import { t } from "../../i18n";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "../../app/types";
import type { SettingsIconName } from "./types";

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

export function SettingsNavIcon({ name }: { name: SettingsIconName }) {
  if (name === "appearance") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M4 13.5c1.1-4.1 3.3-7.1 6-8.8 2.8 1.7 4.9 4.7 6 8.8"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M7.2 13.5h5.6M10 5v8.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "database") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <ellipse cx="10" cy="5.3" rx="5.8" ry="2.4" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path
          d="M4.2 5.3v7.8c0 1.3 2.6 2.4 5.8 2.4s5.8-1.1 5.8-2.4V5.3M4.2 9.2c0 1.3 2.6 2.4 5.8 2.4s5.8-1.1 5.8-2.4"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === "server") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <rect x="3.5" y="4" width="13" height="4.8" rx="1.3" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <rect x="3.5" y="11.2" width="13" height="4.8" rx="1.3" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M6.2 6.4h.1M6.2 13.6h.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "spark") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M10 3.5l1.4 3.9 3.9 1.4-3.9 1.4L10 14.1l-1.4-3.9-3.9-1.4 3.9-1.4L10 3.5z"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M15.2 13.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z" fill="currentColor" />
      </svg>
    );
  }

  if (name === "models") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M10 2.8l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.6 5.8 15.8l.8-4.7L3.2 7.8l4.7-.7L10 2.8z"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === "memory") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M10 6.5V10l2.5 1.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "search") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M13 13l3.5 3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "kb") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path d="M4 3.5h12v13H4z" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" />
        <path d="M7 7.5h6M7 10.5h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "usage") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <rect x="2.5" y="7" width="3.5" height="9" rx="0.5" fill="currentColor" opacity="0.4" />
        <rect x="7" y="3" width="3.5" height="13" rx="0.5" fill="currentColor" opacity="0.55" />
        <rect x="11.5" y="5" width="3.5" height="11" rx="0.5" fill="currentColor" opacity="0.8" />
        <rect x="16" y="2" width="3.5" height="14" rx="0.5" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path d="M4 6h7M4 14h7M13 6h3M13 14h3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="12" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.35" fill="none" />
      <circle cx="8" cy="14" r="1.7" stroke="currentColor" strokeWidth="1.35" fill="none" />
    </svg>
  );
}
