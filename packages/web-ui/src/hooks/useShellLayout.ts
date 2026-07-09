import { useEffect, useState, type CSSProperties, type PointerEvent } from "react";
import { setLocale } from "../i18n";
import type { Locale } from "../i18n";
import {
  CHAT_FONT_SIZE_KEY,
  CODE_FONT_SIZE_KEY,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  MAX_INSPECTOR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  TOOL_DETAILS_OPEN_KEY,
  UI_FONT_SIZE_KEY,
  WORK_MODE_KEY,
  clamp,
  readStoredBoolean,
  readStoredLocale,
  readStoredNumber,
  readStoredThemeMode,
  readStoredWorkMode,
} from "../app/preferences";
import type { ThemeMode, WorkMode } from "../app/types";

export function useShellLayout() {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredNumber("aurevoy.sidebarWidth", 330, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readStoredNumber("aurevoy.inspectorWidth", 760, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
  );
  const [chatFontSize, setChatFontSize] = useState(() =>
    readStoredNumber(CHAT_FONT_SIZE_KEY, DEFAULT_CHAT_FONT_SIZE, 11, 24),
  );
  const [uiFontSize, setUiFontSize] = useState(() =>
    readStoredNumber(UI_FONT_SIZE_KEY, DEFAULT_UI_FONT_SIZE, 10, 20),
  );
  const [codeFontSize, setCodeFontSize] = useState(() =>
    readStoredNumber(CODE_FONT_SIZE_KEY, DEFAULT_CODE_FONT_SIZE, 10, 18),
  );
  const [defaultToolDetailsOpen, setDefaultToolDetailsOpen] = useState(() =>
    readStoredBoolean(TOOL_DETAILS_OPEN_KEY, false),
  );
  const [workMode, setWorkMode] = useState<WorkMode>(() =>
    readStoredWorkMode(defaultToolDetailsOpen),
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());

  useEffect(() => {
    window.localStorage.setItem("aurevoy.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("aurevoy.inspectorWidth", String(inspectorWidth));
  }, [inspectorWidth]);

  useEffect(() => {
    window.localStorage.setItem(CHAT_FONT_SIZE_KEY, String(chatFontSize));
  }, [chatFontSize]);

  useEffect(() => {
    window.localStorage.setItem(UI_FONT_SIZE_KEY, String(uiFontSize));
  }, [uiFontSize]);

  useEffect(() => {
    window.localStorage.setItem(CODE_FONT_SIZE_KEY, String(codeFontSize));
  }, [codeFontSize]);

  useEffect(() => {
    window.localStorage.setItem(TOOL_DETAILS_OPEN_KEY, String(defaultToolDetailsOpen));
  }, [defaultToolDetailsOpen]);

  useEffect(() => {
    window.localStorage.setItem(WORK_MODE_KEY, workMode);
  }, [workMode]);

  useEffect(() => {
    window.localStorage.setItem("aurevoy.themeMode", themeMode);
    if (themeMode === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = themeMode;
    }
  }, [themeMode]);

  useEffect(() => {
    setLocale(locale);
    window.localStorage.setItem("aurevoy.locale", locale);
  }, [locale]);

  function handleWorkModeChange(mode: WorkMode): void {
    setWorkMode(mode);
    // 工作模式影响默认信息密度；用户仍可在外观页单独覆盖工具详情开关。
    setDefaultToolDetailsOpen(mode === "coding");
  }

  function handleChatFontSizeChange(nextSize: number): void {
    setChatFontSize(clamp(nextSize, 11, 24));
  }

  function handleUiFontSizeChange(nextSize: number): void {
    setUiFontSize(clamp(nextSize, 10, 20));
  }

  function handleCodeFontSizeChange(nextSize: number): void {
    setCodeFontSize(clamp(nextSize, 10, 18));
  }

  function startResize(panel: "left" | "right", event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "left" ? sidebarWidth : inspectorWidth;

    // 拖拽只修改布局宽度状态；具体列宽由 CSS 变量消费，避免组件互相知道布局细节。
    function handleMove(moveEvent: globalThis.PointerEvent): void {
      const delta = moveEvent.clientX - startX;
      if (panel === "left") {
        setSidebarWidth(clamp(startWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
      } else {
        setInspectorWidth(clamp(startWidth - delta, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH));
      }
    }

    function handleUp(): void {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--inspector-width": `${inspectorWidth}px`,
    "--ui-font-size": `${uiFontSize}px`,
    "--chat-font-size": `${chatFontSize}px`,
    "--code-font-size": `${codeFontSize}px`,
  } as CSSProperties;

  return {
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
  };
}
