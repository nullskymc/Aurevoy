import type { Project, TaskSummary } from "@aurevoy/shared";
import type { TrayRecentItem } from "../platform/types";

type TrayTaskSource = Pick<TaskSummary, "id" | "title" | "goal" | "projectId" | "updatedAt">;
type TrayProjectSource = Pick<Project, "id" | "name">;

/**
 * 将完整任务状态压缩成托盘真正消费的最近任务摘要。
 * plan、phase、messages 等 SSE 高频字段不会进入结果，也不会影响摘要签名。
 */
export function buildTrayRecentItems(
  tasks: readonly TrayTaskSource[],
  projects: readonly TrayProjectSource[],
): TrayRecentItem[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return [...tasks]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20)
    .map((task) => ({
      id: task.id,
      title: (task.title || task.goal || "Untitled").trim(),
      subtitle: task.projectId ? projectNames.get(task.projectId) ?? null : null,
    }));
}

/** 只用原生菜单可见内容生成签名，阻止无关任务状态触发 set_menu。 */
export function createTrayRecentSignature(items: readonly TrayRecentItem[]): string {
  return JSON.stringify(items);
}
