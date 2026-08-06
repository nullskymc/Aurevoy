// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LlmReadiness, Message, Task } from "@aurevoy/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { Composer } from "./Composer";
import { ApprovalsDock, Conversation } from "./Conversation";

const noop = () => {};
let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function baseTask(overrides: Partial<Task> = {}): Task {
  const messages: Message[] = overrides.messages ?? [
    {
      id: "user-1",
      role: "user",
      content: "整理项目",
      createdAt: "2026-08-06T00:00:00.000Z",
    },
  ];
  return {
    id: "task-workflow",
    goal: "整理项目",
    title: "整理项目",
    status: "failed",
    phase: "failed",
    plan: [],
    messages,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

const readyLlm: LlmReadiness = {
  state: "ready",
  ready: true,
  provider: "openai",
  model: "gpt-5",
};

beforeEach(() => setLocale("en"));

describe("task workflow components", () => {
  it("shows create-task prerequisites in Composer before sending", () => {
    const html = renderToStaticMarkup(
      <Composer
        value="Summarize the selected files"
        busy={false}
        online
        variant="hero"
        llm={readyLlm}
        attachments={[{
          id: "att-1",
          name: "notes.md",
          path: "/tmp/notes.md",
          type: "file",
          mimeType: "text/markdown",
          size: 128,
        }]}
        onChange={noop}
        onSubmit={noop}
        onOpenModelSelector={noop}
        executionMode="plan"
        onExecutionModeChange={noop}
      />,
    );

    expect(html).toContain("notes.md");
    expect(html).toContain("gpt-5");
    expect(html).toContain("composer-send");
    expect(html).not.toContain('disabled=""');
  });

  it("renders approval target, risk context and both decisions in place", () => {
    const html = renderToStaticMarkup(
      <ApprovalsDock
        liveToolActivity={[{
          id: "call-shell",
          name: "execute_command",
          args: { command: "npm test" },
          status: "awaiting",
          riskLevel: "caution",
        }]}
        onToolDecision={noop}
      />,
    );

    expect(html).toContain("npm test");
    expect(html).toContain("Needs Confirmation");
    expect(html).toContain("approval-card");
    expect(html).toContain("Approve Once");
    expect(html).toContain("Reject");
  });

  it("replaces the pending approval with a decided state after an action", async () => {
    const onToolDecision = vi.fn(() => Promise.resolve());
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ApprovalsDock
          liveToolActivity={[{
            id: "call-shell",
            name: "execute_command",
            args: { command: "npm test" },
            status: "awaiting",
            riskLevel: "dangerous",
          }]}
          onToolDecision={onToolDecision}
        />,
      );
    });

    const approveButton = container.querySelector<HTMLButtonElement>(".approval-card-btn--allow");
    expect(approveButton).not.toBeNull();
    await act(async () => {
      approveButton?.click();
      await Promise.resolve();
    });

    expect(onToolDecision).toHaveBeenCalledWith("call-shell", true);
    expect(container.querySelector('[data-decision="approve"]')).not.toBeNull();
    expect(container.querySelector(".approval-card-btn--allow")).toBeNull();
  });

  it("keeps approval actionable after a failed decision request", async () => {
    const onToolDecision = vi.fn(() => Promise.reject(new Error("offline")));
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ApprovalsDock
          liveToolActivity={[{
            id: "call-shell",
            name: "execute_command",
            args: { command: "npm test" },
            status: "awaiting",
            riskLevel: "caution",
          }]}
          onToolDecision={onToolDecision}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".approval-card-btn--allow")?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-status="error"]')).not.toBeNull();
    expect(container.querySelector(".approval-card-error")?.textContent).toContain("Approval failed");
    expect(container.querySelector(".approval-card-btn--allow")).not.toBeNull();
    expect(onToolDecision).toHaveBeenCalledTimes(1);
  });

  it("keeps clarification and resume actions in the conversation surface", () => {
    const clarificationTask = baseTask({
      status: "paused",
      phase: "waiting_clarification",
      clarifications: [{
        id: "clarification-1",
        callId: "call-ask",
        status: "pending",
        createdAt: "2026-08-06T00:00:01.000Z",
        question: "Which folder should I update?",
        options: ["src", "docs"],
      }],
    });
    const clarificationHtml = renderToStaticMarkup(
      <Conversation
        task={clarificationTask}
        status="paused"
        phase="waiting_clarification"
        plan={[]}
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );
    expect(clarificationHtml).toContain("Which folder should I update?");
    expect(clarificationHtml).toContain("src");

    const resumeHtml = renderToStaticMarkup(
      <Conversation
        task={baseTask()}
        status="failed"
        phase="failed"
        plan={[]}
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        canResume
        onResume={noop}
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );
    expect(resumeHtml).toContain("Resume");
  });

  it("renders network and engine failures as distinct user-facing categories", () => {
    const html = renderToStaticMarkup(
      <Conversation
        task={baseTask({
          messages: [
            ...baseTask().messages,
            {
              id: "assistant-failure",
              role: "assistant",
              content: "The engine could not continue.",
              createdAt: "2026-08-06T00:00:02.000Z",
              failure: { message: "The engine could not continue.", category: "engine" },
            },
          ],
        })}
        status="failed"
        phase="failed"
        plan={[]}
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain('data-kind="engine"');
    expect(html).toContain("Engine");
  });

  it("exposes edit-and-retry on completed user turns but not while editing is disabled", () => {
    const editable = renderToStaticMarkup(
      <Conversation
        task={baseTask({ status: "completed", phase: "finalizing" })}
        status="completed"
        phase="finalizing"
        plan={[]}
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        onUserMessageEdit={noop}
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );
    expect(editable).toContain("Edit");

    const disabled = renderToStaticMarkup(
      <Conversation
        task={baseTask({ status: "running", phase: "thinking" })}
        status="running"
        phase="thinking"
        plan={[]}
        busy
        liveToolActivity={[]}
        hasLiveTail
        onUserMessageEdit={noop}
        editDisabled
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );
    expect(disabled).toContain("disabled");
  });
});
