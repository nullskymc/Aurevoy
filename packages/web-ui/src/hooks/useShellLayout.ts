import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react";
import { setLocale } from "../i18n";
import type { Locale } from "../i18n";
import {
  CHAT_FONT_SIZE_KEY,
  CODE_FONT_SIZE_KEY,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_WORKBENCH_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MAX_WORKBENCH_WIDTH,
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKBENCH_WIDTH,
  RESIZE_HANDLE_WIDTH,
  TOOL_DETAILS_OPEN_KEY,
  UI_FONT_SIZE_KEY,
  WORK_MODE_KEY,
  WORKBENCH_OPEN_KEY,
  WORKBENCH_WIDTH_KEY,
  clamp,
  readStoredBoolean,
  readStoredLocale,
  readStoredNumber,
  readStoredThemeMode,
  readStoredWorkMode,
} from "../app/preferences";
import {
  fitPanelWidths,
  shouldAutoCollapseWorkbench,
  shouldRestoreWorkbench,
  windowWidthToOpenWorkbench,
} from "../app/shellLayoutFit";
import { usePlatform } from "../platform/context";
import type { ThemeMode, WorkMode } from "../app/types";

const SIDEBAR_WIDTH_KEY = "aurevoy.sidebarWidth";

function maxSidebarWidth(
  snapshot: {
    workbenchWidth: number;
    workbenchOpen: boolean;
    leftCollapsed: boolean;
  },
  viewportWidth: number,
): number {
  if (snapshot.leftCollapsed) return MAX_SIDEBAR_WIDTH;
  const handles =
    RESIZE_HANDLE_WIDTH + (snapshot.workbenchOpen ? RESIZE_HANDLE_WIDTH : 0);
  const workbenchUsed = snapshot.workbenchOpen ? snapshot.workbenchWidth : 0;
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - handles - workbenchUsed - MIN_MAIN_WIDTH),
  );
}

function maxWorkbenchWidth(
  snapshot: {
    sidebarWidth: number;
    workbenchOpen: boolean;
    leftCollapsed: boolean;
  },
  viewportWidth: number,
): number {
  if (!snapshot.workbenchOpen) return MAX_WORKBENCH_WIDTH;
  const handles =
    (snapshot.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH) + RESIZE_HANDLE_WIDTH;
  const sidebarUsed = snapshot.leftCollapsed ? 0 : snapshot.sidebarWidth;
  return Math.max(
    MIN_WORKBENCH_WIDTH,
    Math.min(MAX_WORKBENCH_WIDTH, viewportWidth - handles - sidebarUsed - MIN_MAIN_WIDTH),
  );
}

export function useShellLayout() {
  const platform = usePlatform();
  const [workbenchOpen, setWorkbenchOpenState] = useState(() =>
    readStoredBoolean(WORKBENCH_OPEN_KEY, true),
  );
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // Preferred widths (user drag / defaults). Effective widths are viewport-fitted.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredNumber(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
  );
  const [workbenchWidth, setWorkbenchWidth] = useState(() =>
    readStoredNumber(WORKBENCH_WIDTH_KEY, DEFAULT_WORKBENCH_WIDTH, MIN_WORKBENCH_WIDTH, MAX_WORKBENCH_WIDTH),
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
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

  /** True only when the shell closed the workbench due to a narrow viewport. */
  const workbenchAutoCollapsedRef = useRef(false);
  /**
   * User explicitly opened the workbench while space was tight — do not immediately
   * re-collapse until the viewport is comfortably wide again (then shrink logic resumes).
   */
  const workbenchUserForcedOpenRef = useRef(false);
  /** Bumped to cancel an in-flight "expand window then open" sequence. */
  const workbenchOpenSeqRef = useRef(0);

  const fitted = useMemo(
    () =>
      fitPanelWidths(
        { sidebarWidth, workbenchWidth, workbenchOpen, leftCollapsed },
        viewportWidth,
      ),
    [sidebarWidth, workbenchWidth, workbenchOpen, leftCollapsed, viewportWidth],
  );

  useEffect(() => {
    function handleResize(): void {
      setViewportWidth(window.innerWidth);
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Auto-collapse / restore the right workbench based on available width.
  useEffect(() => {
    const input = { sidebarWidth, leftCollapsed };

    if (shouldRestoreWorkbench(input, viewportWidth)) {
      // Viewport is wide enough again; future shrinks may auto-collapse.
      workbenchUserForcedOpenRef.current = false;
    }

    if (
      workbenchOpen &&
      shouldAutoCollapseWorkbench(input, viewportWidth) &&
      !workbenchUserForcedOpenRef.current
    ) {
      workbenchAutoCollapsedRef.current = true;
      setWorkbenchOpenState(false);
      return;
    }

    if (
      !workbenchOpen &&
      workbenchAutoCollapsedRef.current &&
      shouldRestoreWorkbench(input, viewportWidth)
    ) {
      workbenchAutoCollapsedRef.current = false;
      setWorkbenchOpenState(true);
    }
  }, [viewportWidth, sidebarWidth, leftCollapsed, workbenchOpen]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(WORKBENCH_WIDTH_KEY, String(workbenchWidth));
  }, [workbenchWidth]);

  useEffect(() => {
    window.localStorage.setItem(WORKBENCH_OPEN_KEY, String(workbenchOpen));
  }, [workbenchOpen]);

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

  const setWorkbenchOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (action) => {
      setWorkbenchOpenState((prev) => {
        const next = typeof action === "function" ? action(prev) : action;

        // Opening from closed: expand the OS window first so the main column is
        // not crushed, then commit open state.
        if (next && !prev) {
          // Absolute layout target (not current+workbench) so re-opening does not
          // accumulate width forever after a previous expand.
          const needed = windowWidthToOpenWorkbench({
            currentInnerWidth: window.innerWidth,
            sidebarWidth,
            leftCollapsed,
            workbenchWidth,
          });
          const ensure = platform.ensureWindowMinWidth?.(needed);

          if (!ensure) {
            // Browser / no platform support: open immediately; fit logic handles squeeze.
            workbenchOpenSeqRef.current += 1;
            workbenchAutoCollapsedRef.current = false;
            workbenchUserForcedOpenRef.current = true;
            return true;
          }

          const seq = ++workbenchOpenSeqRef.current;
          const openInput = { sidebarWidth, leftCollapsed };
          void Promise.resolve(ensure)
            .then(() => {
              if (workbenchOpenSeqRef.current !== seq) return;
              const width = window.innerWidth;
              workbenchAutoCollapsedRef.current = false;
              // If expand failed or was capped by the monitor, keep forced-open so
              // auto-collapse does not immediately close the panel (flash).
              workbenchUserForcedOpenRef.current = shouldAutoCollapseWorkbench(
                openInput,
                width,
              );
              setViewportWidth(width);
              setWorkbenchOpenState(true);
            })
            .catch(() => {
              if (workbenchOpenSeqRef.current !== seq) return;
              // Expand threw (e.g. missing set-size permission): still open, but
              // mark forced so the panel stays visible until the user closes it.
              workbenchAutoCollapsedRef.current = false;
              workbenchUserForcedOpenRef.current = true;
              setViewportWidth(window.innerWidth);
              setWorkbenchOpenState(true);
            });
          return prev;
        }

        // Explicit user/API close (or no-op true→true): clear auto flags and
        // cancel any pending expand-then-open.
        workbenchOpenSeqRef.current += 1;
        workbenchAutoCollapsedRef.current = false;
        workbenchUserForcedOpenRef.current = false;
        return next;
      });
    },
    [platform, workbenchWidth, sidebarWidth, leftCollapsed],
  );

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
    // Drag against currently fitted sizes so the handle tracks the visible edge.
    const startWidth = panel === "left" ? fitted.sidebarWidth : fitted.workbenchWidth;
    // While dragging, only reserve the other panel's *minimum* so the active
    // handle can steal space from the fitted remainder (main stays ≥ MIN_MAIN).
    const dragLeftCollapsed = leftCollapsed;
    const dragWorkbenchOpen = workbenchOpen;

    function handleMove(moveEvent: globalThis.PointerEvent): void {
      const delta = moveEvent.clientX - startX;
      const viewport = window.innerWidth;
      if (panel === "left") {
        const max = maxSidebarWidth(
          {
            workbenchWidth: MIN_WORKBENCH_WIDTH,
            workbenchOpen: dragWorkbenchOpen,
            leftCollapsed: false,
          },
          viewport,
        );
        setSidebarWidth(clamp(startWidth + delta, MIN_SIDEBAR_WIDTH, max));
      } else {
        const max = maxWorkbenchWidth(
          {
            sidebarWidth: MIN_SIDEBAR_WIDTH,
            workbenchOpen: true,
            leftCollapsed: dragLeftCollapsed,
          },
          viewport,
        );
        setWorkbenchWidth(clamp(startWidth - delta, MIN_WORKBENCH_WIDTH, max));
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
    "--sidebar-width": `${fitted.sidebarWidth}px`,
    "--workbench-width": `${fitted.workbenchWidth}px`,
    "--ui-font-size": `${uiFontSize}px`,
    "--chat-font-size": `${chatFontSize}px`,
    "--code-font-size": `${codeFontSize}px`,
  } as CSSProperties;

  return {
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
  };
}
