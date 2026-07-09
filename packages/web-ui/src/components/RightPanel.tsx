import type { Task } from "@aurevoy/shared";
import { FileTree } from "./FileTree";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useFileTree } from "../hooks/useFileTree";
import type { RightPanelTab } from "../hooks/useTabs";
import { t } from "../i18n";
import "./RightPanel.css";

interface RightPanelProps {
  open: boolean;
  task: Task | null;
  projectId?: string;
  tabs: RightPanelTab[];
  activeTab: RightPanelTab | null;
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
  onOpenFile: (path: string) => void;
}

export function RightPanel({
  open,
  task,
  projectId,
  tabs,
  activeTab,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onOpenFile,
}: RightPanelProps) {
  const tree = useFileTree({ taskId: task?.id, projectId });

  return (
    <aside className="right-panel" data-open={open} aria-label={t("rightPanel.panelLabel")} aria-hidden={!open}>
      {open && (
        <div className="right-panel-body">
          <WorkspaceTabs
            tabs={tabs}
            activeTab={activeTab}
            activeTabId={activeTabId}
            taskId={task?.id}
            projectId={projectId}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onAdd={onAddTab}
          />
          <FileTree
            tree={tree}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </aside>
  );
}
