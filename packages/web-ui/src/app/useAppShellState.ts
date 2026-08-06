import { useCallback, useEffect, useState } from "react";
import type { AutomationSeed } from "../pages/AutomationsPage";
import type { ToastTone } from "../components/ToastNotice";
import type { MainView, SettingsSectionId } from "./types";
import { OUTPUT_RAIL_OPEN_KEY, readStoredBoolean } from "./preferences";

export interface AppNotice {
  message: string;
  tone: ToastTone;
}

/** App 壳层的导航、浮层和短反馈状态；任务/设置数据仍由各自领域 hooks 管理。 */
export function useAppShellState() {
  const [activeView, setActiveView] = useState<MainView>("chat");
  const [automationSeed, setAutomationSeed] = useState<AutomationSeed | null>(null);
  const [searchPopoverOpen, setSearchPopoverOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("general");
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [notice, setNoticeState] = useState<AppNotice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | undefined>();
  const [outputRailOpen, setOutputRailOpen] = useState(() =>
    readStoredBoolean(OUTPUT_RAIL_OPEN_KEY, true),
  );

  const setNotice = useCallback((message: string | null, tone?: ToastTone) => {
    if (!message) {
      setNoticeState(null);
      setActionError(null);
      return;
    }
    const inferred = inferNoticeTone(message, tone);
    // Toast 只承载短暂成功/状态反馈；错误留在当前页面，直到用户主动关闭。
    if (inferred === "error") {
      setNoticeState(null);
      setActionError(message);
      return;
    }
    setActionError(null);
    setNoticeState({ message, tone: inferred });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OUTPUT_RAIL_OPEN_KEY, String(outputRailOpen));
  }, [outputRailOpen]);

  return {
    activeView,
    setActiveView,
    automationSeed,
    setAutomationSeed,
    searchPopoverOpen,
    setSearchPopoverOpen,
    settingsInitialSection,
    setSettingsInitialSection,
    modelDrawerOpen,
    setModelDrawerOpen,
    sessionTreeOpen,
    setSessionTreeOpen,
    tracePanelOpen,
    setTracePanelOpen,
    online,
    setOnline,
    notice,
    actionError,
    setNotice,
    setActionError,
    draftProjectId,
    setDraftProjectId,
    outputRailOpen,
    setOutputRailOpen,
  };
}

/** 统一短暂提示与持久错误的分类，避免各异步动作自行猜测反馈语义。 */
export function inferNoticeTone(message: string, explicit?: ToastTone): ToastTone {
  return explicit
    ?? (/失败|失敗|failed|error|错误|錯誤|無法|无法|못|에러/i.test(message) ? "error" : "info");
}
