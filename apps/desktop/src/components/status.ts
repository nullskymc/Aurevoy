import type { TaskPhase, TaskStatus } from "@aurevoy/shared";

export function getStatusLabel(status: TaskStatus | null): string {
  switch (status) {
    case "pending":
      return "等待中";
    case "planning":
      return "正在规划";
    case "running":
      return "执行中";
    case "paused":
      return "等待确认";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "未开始";
  }
}

export function getPhaseLabel(phase: TaskPhase | null): string {
  switch (phase) {
    case "initializing":
      return "初始化";
    case "thinking":
      return "模型思考";
    case "calling_tool":
      return "调用工具";
    case "waiting_approval":
      return "等待确认";
    case "waiting_clarification":
      return "等待补充信息";
    case "finalizing":
      return "整理结果";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "";
  }
}

export function getRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";

  const diffMs = Date.now() - time;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
