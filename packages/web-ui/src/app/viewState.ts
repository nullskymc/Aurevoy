import type { MainView, SettingsSectionId } from './types';

/** 实时尾部只在任务仍可能产生增量内容时展示，避免历史结果重复出现。 */
export function shouldShowLiveTail(params: {
  busy: boolean;
  liveToolCount: number;
  phase: string | null | undefined;
}): boolean {
  return params.busy || params.liveToolCount > 0 || params.phase === 'waiting_approval';
}

/** 输出栏与工作台共用右侧列；将互斥条件集中后，组件只负责渲染。 */
export function shouldShowOutputRail(params: {
  activeView: MainView;
  hasConversation: boolean;
  workbenchOpen: boolean;
  outputRailOpen: boolean;
}): boolean {
  return params.activeView === 'chat'
    && params.hasConversation
    && !params.workbenchOpen
    && params.outputRailOpen;
}

/** 外部入口可能传入未知 section，统一归一到设置页的安全默认值。 */
export function normalizeSettingsSection(
  section: unknown,
  allowed: readonly SettingsSectionId[],
): SettingsSectionId {
  return typeof section === 'string' && allowed.includes(section as SettingsSectionId)
    ? section as SettingsSectionId
    : 'general';
}

/** 页面标题计算是纯状态映射，避免在 App render 中嵌套条件和翻译耦合。 */
export function getMainViewTitle(
  activeView: MainView,
  labels: { chat: string; skills: string; automations: string; settings: string },
  taskTitle?: string | null,
): string {
  if (activeView === 'chat') return taskTitle || labels.chat;
  if (activeView === 'skills') return labels.skills;
  if (activeView === 'automations') return labels.automations;
  return labels.settings;
}
