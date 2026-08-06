/** Timeline 中不应重复展示、已有专用 UI 承载的内部工具。 */
export function shouldHideToolFromWorkflow(toolName: string): boolean {
  // 计划更新已有独立的计划进度条承载；其余内部工具也有专用展示区域。
  return toolName === "attach_content"
    || toolName === "present_ui"
    || toolName === "delegate"
    || toolName === "update_plan";
}

/** 将取消/重启时补写的悬空工具结果与真实工具失败区分开。 */
export function isCancelledToolError(error?: string): boolean {
  return !!error && /返回前中断|任务(?:被|已)取消|父任务已取消|用户取消|\b(?:cancelled|canceled|aborted)\b/i.test(error);
}

export type TimelineToolStatus = "success" | "failed" | "cancelled";

/** 历史结果缺失时按任务阶段判定，统一 live/history 两条渲染路径。 */
export function classifyTimelineToolStatus(
  result: { ok: boolean; error?: string } | undefined,
  phaseCancelled: boolean,
): TimelineToolStatus {
  if (!result) return phaseCancelled ? "cancelled" : "success";
  if (result.ok) return "success";
  return isCancelledToolError(result.error) ? "cancelled" : "failed";
}
