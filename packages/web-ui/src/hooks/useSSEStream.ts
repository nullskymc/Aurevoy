import { useCallback, useEffect, useRef } from "react";
import { EventStreamContentType, fetchEventSource } from "@microsoft/fetch-event-source";
import type { AgentEvent, StreamAgentEvent } from "@aurevoy/shared";
import { getBaseUrl } from "../api";

const MAX_RECONNECT_DELAY_MS = 5_000;
const BASE_RECONNECT_DELAY_MS = 250;

/**
 * SSE 流管理 hook（带断线重连）。
 *
 * - 本地引擎断开时自动指数退避重连（250ms → 500ms → 1s → … → 5s 上限）
 * - 收到 done / task_deleted 事件时终止重连
 * - 新 openStream 调用自动取消旧的待定重连
 * - 每次成功收到消息时重置退避计数器
 * - 后端按 SSE id 增量回放；日志缺口时自动回退完整任务快照
 */
export function useSSEStream() {
  const esRef = useRef<AbortController | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastSeqByTaskRef = useRef(new Map<string, number>());
  const taskIdRef = useRef<string | null>(null);
  const onEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const onDoneRef = useRef<() => void>(() => {});
  const firstEventSeenRef = useRef(false);
  const firstTokenSeenRef = useRef(false);

  const closeStream = useCallback((): void => {
    esRef.current?.abort();
    esRef.current = null;
    taskIdRef.current = null;
    reconnectAttemptRef.current = 0;
  }, []);

  /**
   * 使用 fetch-event-source 创建可取消的 SSE 连接。
   * 它通过 Fetch 支持自定义请求、页面隐藏时持续连接和由 onerror 控制的退避策略。
   */
  const doConnect = useCallback(
    (taskId: string, hasSnapshot: boolean) => {
      const lastSeq = lastSeqByTaskRef.current.get(taskId) ?? 0;
      const query = new URLSearchParams({ afterSeq: String(lastSeq) });
      if (hasSnapshot) query.set("snapshot", "0");
      const streamUrl = `${getBaseUrl()}/api/tasks/${taskId}/stream?${query.toString()}`;
      const controller = new AbortController();
      const headers: Record<string, string> = { Accept: EventStreamContentType };
      if (lastSeq > 0) headers["Last-Event-ID"] = String(lastSeq);
      markSseMilestone(taskId, "connect-start");

      void fetchEventSource(streamUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
        // Tauri 窗口被遮挡或最小化时，任务仍应完整接收，而不是重新建连回放。
        openWhenHidden: true,
        async onopen(response) {
          const contentType = response.headers.get("content-type");
          if (!response.ok || !contentType?.startsWith(EventStreamContentType)) {
            throw new Error(`SSE connection failed: ${response.status}`);
          }
          markSseMilestone(taskId, "open");
        },
        onmessage(message) {
          try {
            const event = JSON.parse(message.data) as StreamAgentEvent;
            const previousSeq = lastSeqByTaskRef.current.get(taskId) ?? 0;
            if (event.seq > previousSeq) {
              lastSeqByTaskRef.current.set(taskId, event.seq);
              // fetch-event-source 重试会复用 headers；同步游标后可从断点续传。
              headers["Last-Event-ID"] = String(event.seq);
            }
            reconnectAttemptRef.current = 0;
            if (!firstEventSeenRef.current) {
              firstEventSeenRef.current = true;
              markSseMilestone(taskId, "first-event", event);
            }
            if (event.type === "token" && !firstTokenSeenRef.current) {
              firstTokenSeenRef.current = true;
              markSseMilestone(taskId, "first-token", event);
            }

            // SSE 到达即按协议顺序分发；渲染合帧只在 LiveOutputStore 中进行。
            onEventRef.current(event);

            if (event.type === "done" || event.type === "task_deleted") {
              taskIdRef.current = null;
              esRef.current = null;
              controller.abort();
              onDoneRef.current();
            }
          } catch {
            // 忽略心跳（: ping）等非 JSON 行。
          }
        },
        onclose() {
          // 没有终态事件就断开，交给 onerror 走原有退避重连策略。
          if (!controller.signal.aborted && taskIdRef.current === taskId) {
            throw new Error("SSE connection closed before task completion");
          }
        },
        onerror() {
          if (controller.signal.aborted || taskIdRef.current !== taskId) return 0;
          const attempts = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = attempts;
          return Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts - 1),
            MAX_RECONNECT_DELAY_MS,
          );
        },
      }).catch(() => {
        // fetch-event-source 的可恢复错误已由 onerror 调度；取消连接无需向 UI 报错。
      });

      return controller;
    },
    [],
  );

  function openStream(
    taskId: string,
    onEvent: (event: AgentEvent) => void,
    onDone: () => void,
    options: { hasSnapshot?: boolean } = {},
  ): void {
    closeStream();
    onEventRef.current = onEvent;
    onDoneRef.current = onDone;
    taskIdRef.current = taskId;
    reconnectAttemptRef.current = 0;
    firstEventSeenRef.current = false;
    firstTokenSeenRef.current = false;
    esRef.current = doConnect(taskId, options.hasSnapshot === true);
  }

  /** App 每次 render 同步最新闭包，避免长连接持续调用建连时的旧任务状态。 */
  function syncEventHandler(handler: (event: AgentEvent) => void): void {
    onEventRef.current = handler;
  }

  // 组件卸载时关闭连接
  useEffect(() => () => closeStream(), [closeStream]);

  return { esRef, closeStream, openStream, syncEventHandler };
}

/** Performance 面板可直接读取 milestone；detail 同时给出服务端到达延迟。 */
function markSseMilestone(taskId: string, milestone: string, event?: StreamAgentEvent): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  const emittedAtMs = event ? Date.parse(event.emittedAt) : Number.NaN;
  performance.mark(`aurevoy:sse:${milestone}:${taskId}`, {
    detail: event
      ? {
          seq: event.seq,
          transportMs: Number.isFinite(emittedAtMs) ? Math.max(0, Date.now() - emittedAtMs) : undefined,
        }
      : undefined,
  });
}
