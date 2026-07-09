import type { RightPanelTab } from "../hooks/useTabs";
import { FileViewer } from "./FileViewer";
import { t } from "../i18n";

interface TabPanelProps {
  tab: RightPanelTab | null;
  taskId?: string;
  projectId?: string;
}

export function TabPanel({ tab, taskId, projectId }: TabPanelProps) {
  if (!tab) {
    return <div className="right-tabpanel-empty">{t("rightPanel.selectFile")}</div>;
  }

  if (tab.kind === "empty") {
    return <div className="right-tabpanel-empty">{t("rightPanel.selectFile")}</div>;
  }

  return (
    <div className="right-tabpanel" role="tabpanel">
      <FileViewer tab={tab} taskId={taskId} projectId={projectId} />
    </div>
  );
}
