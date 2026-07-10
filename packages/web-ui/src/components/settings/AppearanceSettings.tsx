import { useEffect, useState } from "react";
import { t, type Locale } from "../../i18n";
import type { ThemeMode } from "../../app/types";
import { SettingsActionRow, SettingsGroup, SettingsSelectRow } from "./layout";

export function AppearanceSettings({
  chatFontSize,
  uiFontSize,
  codeFontSize,
  themeMode,
  locale,
  onChatFontSizeChange,
  onUiFontSizeChange,
  onCodeFontSizeChange,
  onThemeModeChange,
  onLocaleChange,
}: {
  chatFontSize: number;
  uiFontSize: number;
  codeFontSize: number;
  themeMode: ThemeMode;
  locale: Locale;
  onChatFontSizeChange: (size: number) => void;
  onUiFontSizeChange: (size: number) => void;
  onCodeFontSizeChange: (size: number) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
}) {
  const isDefaultChatFontSize = Math.abs(chatFontSize - 14) < 0.001;
  const isDefaultUiFontSize = Math.abs(uiFontSize - 12.5) < 0.001;
  const isDefaultCodeFontSize = Math.abs(codeFontSize - 12) < 0.001;

  return (
    <SettingsGroup title={t("settings.appearance")}>
      <SettingsSelectRow
        title={t("settings.themeTitle")}
        description={t("settings.themeDesc")}
        value={themeMode}
        options={[
          { value: "system", label: t("settings.themeSystem") },
          { value: "light", label: t("settings.themeLight") },
          { value: "dark", label: t("settings.themeDark") },
        ]}
        onChange={(value) => onThemeModeChange(value as ThemeMode)}
      />
      <SettingsSelectRow
        title={t("settings.languageTitle")}
        description={t("settings.languageDesc")}
        value={locale}
        options={[
          { value: "zh", label: t("settings.languageZh") },
         { value: "en", label: t("settings.languageEn") },
          { value: "ko", label: t("settings.languageKo") },
          { value: "ja", label: t("settings.languageJa") },
        ]}
        onChange={(value) => onLocaleChange(value as Locale)}
      />
      <SettingsActionRow
        title={t("settings.uiFontSizeTitle")}
        description={t("settings.uiFontSizeDesc")}
        control={
          <FontSizeControl
            value={uiFontSize}
            defaultValue={12.5}
            min={10}
            max={20}
            step={0.5}
            ariaLabel={t("settings.uiFontSizeTitle")}
            resetDisabled={isDefaultUiFontSize}
            onChange={onUiFontSizeChange}
          />
        }
      />
      <SettingsActionRow
        title={t("settings.chatFontSizeTitle")}
        description={t("settings.chatFontSizeDesc")}
        control={
          <FontSizeControl
            value={chatFontSize}
            defaultValue={14}
            min={11}
            max={24}
            step={0.5}
            ariaLabel={t("settings.chatFontSizeTitle")}
            resetDisabled={isDefaultChatFontSize}
            onChange={onChatFontSizeChange}
          />
        }
      />
      <SettingsActionRow
        title={t("settings.codeFontSizeTitle")}
        description={t("settings.codeFontSizeDesc")}
        control={
          <FontSizeControl
            value={codeFontSize}
            defaultValue={12}
            min={10}
            max={18}
            ariaLabel={t("settings.codeFontSizeTitle")}
            resetDisabled={isDefaultCodeFontSize}
            onChange={onCodeFontSizeChange}
          />
        }
      />
    </SettingsGroup>
  );
}

export function FontSizeControl({
  value,
  defaultValue,
  min,
  max,
  step = 1,
  ariaLabel,
  resetDisabled,
  onChange,
}: {
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  resetDisabled: boolean;
  onChange: (size: number) => void;
}) {
  const [draft, setDraft] = useState(() => formatFontSizeInput(value));

  useEffect(() => {
    setDraft(formatFontSizeInput(value));
  }, [value]);

  function commitValue(rawValue: string): void {
    setDraft(rawValue);
    if (rawValue.trim() === "") return;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    onChange(parsed);
  }

  function restoreValidValue(): void {
    if (draft.trim() === "") {
      setDraft(formatFontSizeInput(value));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatFontSizeInput(value));
    }
  }

  return (
    <div className="settings-font-size-control">
      <div className="settings-font-size-input-wrap">
        <input
          className="settings-number-input settings-font-size-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-label={ariaLabel}
          onChange={(event) => commitValue(event.target.value)}
          onBlur={restoreValidValue}
        />
        <span className="settings-font-size-unit">px</span>
      </div>
      <button
        type="button"
        className="settings-inline-btn settings-font-size-reset"
        disabled={resetDisabled}
        onClick={() => onChange(defaultValue)}
      >
        {t("settings.fontSizeReset")}
      </button>
    </div>
  );
}

export function formatFontSizeInput(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
