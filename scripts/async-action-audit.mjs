#!/usr/bin/env node

/**
 * 前端异步动作的结构化审计门。
 *
 * 这里检查的是“动作是否仍保留状态反馈的源码契约”，不是用字符串扫描替代
 * 组件行为测试：每一项同时列出动作、pending、success/error 的可见锚点；
 * 具体时序由既有 Vitest、长循环和 UI smoke 负责验证。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const actions = [
  action("settings/general-save", "packages/web-ui/src/components/settings/GeneralSettings.tsx", ["handleSave", "disabled={saving}"], ["saveError", "role=\"alert\""]),
  action("settings/search-save", "packages/web-ui/src/components/settings/SearchSettings.tsx", ["handleSave", "disabled={saving}"], ["saveError", "role=\"alert\""]),
  action("settings/mcp", "packages/web-ui/src/components/settings/McpSettings.tsx", ["testing", "saving"], ["formError", "role=\"alert\"", "catch"]),
  action("settings/memory", "packages/web-ui/src/components/settings/MemorySettings.tsx", ["busyAction", "isBusy"], ["actionError", "role=\"alert\""]),
  action("settings/knowledge-base", "packages/web-ui/src/components/settings/KbSettings.tsx", ["loading", "removingId"], ["const [error", "role=\"alert\""]),
  action("settings/data", "packages/web-ui/src/components/settings/DataSettings.tsx", ["diagnosticsLoading", "exporting", "backingUp", "cleanupBusy"], ["diagnosticsError", "taskMetricsError"]),
  action("settings/oauth", "packages/web-ui/src/components/settings/OauthLoginPanel.tsx", ["busy", "disabled={disabled || busy}"], ["error", "onNotice?.(message, \"error\")"]),
  action("settings/header-save", "packages/web-ui/src/components/settings/SettingsPanel.tsx", ["saveRefreshBusy", "headerBusy"], ["saveRefreshError", "role=\"alert\""]),
  action("automations", "packages/web-ui/src/pages/AutomationsPage.tsx", ["refreshing", "rowAction", "disabled={refreshing || loading}"], ["onNotice", "catch"]),
  action("skills", "packages/web-ui/src/pages/SkillsPage.tsx", ["browserRuntimeTesting", "installing", "reloading"], ["skill-install-error", "browser-runtime-error"]),
  action("task-history-delete", "packages/web-ui/src/components/TaskHistorySidebar.tsx", ["deletePendingKey", "aria-busy"], ["requestDelete", "disabled"]),
  action("session-tree", "packages/web-ui/src/components/SessionTreeDialog.tsx", ["loading", "navigating", "disabled={!canNavigate}"], ["error", "role=\"alert\""]),
  action("file-tree", "packages/web-ui/src/components/FileTree.tsx", ["loading", "disabled={node?.loading === true}"], ["catch", "error"]),
  action("file-viewer", "packages/web-ui/src/components/FileViewer.tsx", ["status: \"loading\"", "async function load"], ["status: \"error\"", "catch"]),
  action("app-toast-boundary", "packages/web-ui/src/App.tsx", ["notice", "ToastNotice"], ["setNotice", "actionError", "role=\"alert\""]),
];

const failures = [];
for (const item of actions) {
  const source = await readFile(resolve(root, item.file), "utf8");
  const missingPending = item.pending.filter((marker) => !source.includes(marker));
  const missingError = item.error.filter((marker) => !source.includes(marker));
  if (missingPending.length || missingError.length) {
    failures.push({ id: item.id, file: item.file, missingPending, missingError });
  }
}

console.log(`Async action audit: ${actions.length - failures.length}/${actions.length} contracts present`);
if (failures.length) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}

function action(id, file, pending, error) {
  return { id, file, pending, error };
}
