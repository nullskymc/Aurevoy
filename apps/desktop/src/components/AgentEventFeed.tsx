import type { AgentEvent } from "@aurevoy/shared";
import { getPhaseLabel, getStatusLabel } from "./status";
import { t } from "../i18n";

export interface FeedItem {
  id: string;
  event: AgentEvent;
  createdAt: string;
}

interface AgentEventFeedProps {
  events: FeedItem[];
}

function getEventTitle(event: AgentEvent): string {
  switch (event.type) {
    case "task_created":
      return t("event.taskCreated");
    case "status":
      return getStatusLabel(event.status);
    case "phase":
      return getPhaseLabel(event.phase);
    case "plan":
      return t("event.planGenerated");
    case "step_update":
      return t("event.stepUpdate");
    case "token":
      return t("event.generating");
    case "reasoning":
      return t("event.reasoning");
    case "message":
      return t("event.fullReply");
    case "tool_call":
      return `${t("event.toolCall")}${event.call.toolName}`;
    case "tool_result":
      return event.result.ok ? t("event.toolResultOk") : t("event.toolResultFail");
    case "approval_request":
      return `${t("event.approvalRequest")}${event.call.toolName}`;
    case "clarification_request":
      return t("event.clarificationRequest");
    case "clarification_resolved":
      return t("event.clarificationResolved");
    case "artifact_created":
      return `${t("event.artifactCreated")}${event.artifact.name}`;
    case "artifact_updated":
      return `${t("event.artifactUpdated")}${event.artifact.name}`;
    case "checkpoint_created":
      return `${t("event.checkpoint")}${event.checkpoint.label}`;
    case "budget_usage":
      return t("event.budgetUsage");
    case "token_usage":
      return t("event.tokenUsage");
    case "reverted":
      return t("event.reverted");
    case "unreverted":
      return t("event.unreverted");
    case "branched":
      return t("event.branched");
    case "compacted":
      return t("event.compacted");
    case "task_deleted":
      return t("event.taskDeleted");
    case "done":
      return `${t("event.taskDonePrefix")}${getStatusLabel(event.status)}`;
    case "error":
      return t("event.error");
    case "scout_started":
      return t("event.scoutStarted");
    case "scout_report":
      return t("event.scoutReport");
    case "plan_generated":
      return t("event.planGenerated");
    case "plan_approval_request":
      return t("event.planApprovalRequest");
    case "plan_approval_resolved":
      return event.approved ? t("event.planApproved") : t("event.planRejected");
    case "skill_activated":
      return `${t("event.skillActivated")}${event.skillName}${event.description ? ` — ${event.description}` : ''}`;
    case "skill_deactivated":
      return event.previousSkill ? `${t("event.skillDeactivated")} (${event.previousSkill})` : t("event.skillDeactivated");
  }
  return (event as AgentEvent).type;
}

function getEventDetail(event: AgentEvent): string {
  switch (event.type) {
    case "status":
      return event.status;
    case "phase":
      return event.detail ? `${event.phase}\n${event.detail}` : event.phase;
    case "plan":
      return `${event.plan.length} ${t("event.unitPlanSteps")}`;
    case "step_update":
      return event.step.description;
    case "token":
      return event.delta.trim() ? event.delta : t("event.streamFragment");
    case "reasoning":
      return event.delta.trim() ? event.delta : t("event.streamFragment");
    case "message":
      return event.message.content;
    case "tool_call":
      return JSON.stringify(event.call.args, null, 2);
    case "tool_result":
      return event.result.ok
        ? JSON.stringify(event.result.output ?? {}, null, 2)
        : event.result.error ?? t("tool.unknownError");
    case "approval_request":
      return `${t("event.riskLevel")} ${event.riskLevel}\n${JSON.stringify(event.call.args, null, 2)}`;
    case "clarification_request":
      return event.clarification.question;
    case "clarification_resolved":
      return event.clarification.answer ?? event.clarification.status;
    case "artifact_created":
    case "artifact_updated":
      return `${event.artifact.type} · ${event.artifact.status}`;
    case "checkpoint_created":
      return event.checkpoint.message ?? event.checkpoint.createdAt;
    case "budget_usage":
      return `${event.usage.iterations} ${t("budget.unitIterations")} / ${event.usage.toolCalls} ${t("budget.tools")} / ${event.usage.outputBytes} bytes`;
    case "token_usage":
      return event.usage.available
        ? `${event.usage.totalTokens ?? 0} total`
        : t("event.providerNoUsage");
    case "reverted":
      return `${event.removedCount} messages removed, ${event.archivedCount} archived`;
    case "unreverted":
      return `${event.restoredCount} messages restored`;
    case "branched":
      return `${event.messageCount} messages branched from ${event.parentTaskId.slice(0, 8)}`;
    case "compacted":
      return `${event.originalCount} messages → ${event.summaryLength} chars`;
    case "task_deleted":
      return event.taskId;
    case "done":
      return event.status;
    case "error":
      return event.message;
    case "task_created":
      return event.task.goal;
    case "scout_started":
      return t("event.scoutStartedDetail");
    case "scout_report":
      return `${event.report.keyFiles.length} key files, ${event.report.rounds} rounds`;
    case "plan_generated":
      return `${event.plan.length} steps (${event.source})`;
    case "plan_approval_request":
      return `${event.plan.length} steps · ${event.reasoning}`;
    case "plan_approval_resolved":
      return event.approved
        ? t("event.planApproved")
        : `${t("event.planRejected")}${event.reason ? ` (${event.reason})` : ''}`;
    case "skill_activated":
      return event.allowedTools
        ? `${t("event.toolsRestricted")}${event.allowedTools.join(', ')}`
        : t("event.allToolsAvailable");
    case "skill_deactivated":
      return t("event.skillDeactivatedDetail");
  }
  return '';
}

export function AgentEventFeed({ events }: AgentEventFeedProps) {
  const visibleEvents = events.filter((item) => item.event.type !== "token").slice(-24);

  return (
    <section className="inspector-section" aria-labelledby="event-title">
      <div className="inspector-label-row">
        <p className="inspector-label" id="event-title">{t("event.title")}</p>
        <span className="inspector-count">{events.length}</span>
      </div>

      {visibleEvents.length === 0 ? (
        <p className="inspector-empty">{t("event.empty")}</p>
      ) : (
        <div className="event-feed">
          {visibleEvents.map((item) => (
            <article key={item.id} className="event-item" data-type={item.event.type}>
              <div className="event-dot" aria-hidden="true" />
              <div>
                <header>
                  <strong>{getEventTitle(item.event)}</strong>
                  <time>{new Date(item.createdAt).toLocaleTimeString("zh-CN")}</time>
                </header>
                <pre>{getEventDetail(item.event)}</pre>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
