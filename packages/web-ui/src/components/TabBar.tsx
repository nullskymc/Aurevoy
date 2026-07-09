import type { RightPanelTab } from "../hooks/useTabs";
import { t } from "../i18n";

interface TabBarProps {
  tabs: RightPanelTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelect, onClose }: TabBarProps) {
  if (tabs.length === 0) {
    return <div className="right-tabbar right-tabbar-empty">{t("rightPanel.noOpenTabs")}</div>;
  }

  return (
    <div className="right-tabbar" role="tablist" aria-label={t("rightPanel.tabs")}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="right-tab"
          data-active={tab.id === activeTabId}
          role="tab"
          tabIndex={0}
          aria-selected={tab.id === activeTabId}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(tab.id);
            }
          }}
          title={tab.kind === "workspace" ? tab.path : tab.name}
        >
          <span className="right-tab-icon" aria-hidden="true">{tab.kind === "artifact" ? "◇" : "□"}</span>
          <span className="right-tab-name">{tab.name}</span>
          <span
            role="button"
            tabIndex={0}
            className="right-tab-close"
            aria-label={t("action.close")}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onClose(tab.id);
              }
            }}
          >
            ×
          </span>
        </div>
      ))}
    </div>
  );
}
