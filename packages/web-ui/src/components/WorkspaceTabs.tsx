import type { RightPanelTab } from "../hooks/useTabs";
import { TabPanel } from "./TabPanel";
import { t } from "../i18n";

interface WorkspaceTabsProps {
  tabs: RightPanelTab[];
  activeTab: RightPanelTab | null;
  activeTabId: string | null;
  taskId?: string;
  projectId?: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

export function WorkspaceTabs({
  tabs,
  activeTab,
  activeTabId,
  taskId,
  projectId,
  onSelect,
  onClose,
  onAdd,
}: WorkspaceTabsProps) {
  return (
    <section className="workspace-tabs">
      <div className="workspace-tabbar" role="tablist" aria-label={t("rightPanel.tabs")}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="workspace-tab"
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
            <span className="workspace-tab-icon" aria-hidden="true">{iconForTab(tab)}</span>
            <span className="workspace-tab-name">{tab.name}</span>
            <button
              type="button"
              className="workspace-tab-close"
              aria-label={t("action.close")}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="workspace-tab-add" onClick={onAdd} aria-label={t("rightPanel.newTab")}>
          +
        </button>
      </div>

      <div className="workspace-breadcrumb">
        <span>Aurevoy</span>
        {activeTab?.kind === "workspace" ? (
          <>
            <span aria-hidden="true">›</span>
            <strong>{activeTab.path}</strong>
          </>
        ) : activeTab ? (
          <>
            <span aria-hidden="true">›</span>
            <strong>{activeTab.name}</strong>
          </>
        ) : null}
      </div>

      <div className="workspace-tab-content">
        <TabPanel tab={activeTab} taskId={taskId} projectId={projectId} />
      </div>
    </section>
  );
}

function iconForTab(tab: RightPanelTab): string {
  if (tab.kind === "artifact") return "◇";
  if (tab.kind === "empty") return "□";
  const ext = tab.name.split(".").pop()?.toLowerCase();
  if (ext === "md") return "M";
  if (ext === "json" || ext === "yml" || ext === "yaml") return "{}";
  return "□";
}
