import { useCallback, useEffect, useRef } from "react";
import { EventStreamContentType, fetchEventSource } from "@microsoft/fetch-event-source";
import type { AgentEvent } from "@aurevoy/shared";
import { getBaseUrl } from "../api";

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * SSE 流管理 hook（带断线重连）。
 *
 * - fetch-event-source 断开时自动指数退避重连（1s → 2s → 4s → … → 30s 上限）
 * - 收到 done / task_deleted 事件时终止重连
 * - 新 openStream 调用自动取消旧的待定重连
 * - 每次成功收到消息时重置退避计数器
 * - 后端 snapshot replay（server.ts:757-789）在重连时自动恢复所有丢失状态
 */
export function useSSEStream() {
  const esRef = useRef<AbortController | null>(null);
  const reconnectAttemptRef = useRef(0);
  const taskIdRef = useRef<string | null>(null);
  const onEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const onDoneRef = useRef<() => void>(() => {});

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
    (taskId: string) => {
      const streamUrl = `${getBaseUrl()}/api/tasks/${taskId}/stream`;
      const controller = new AbortController();

      void fetchEventSource(streamUrl, {
        method: "GET",
        headers: { Accept: EventStreamContentType },
        signal: controller.signal,
        // Tauri 窗口被遮挡或最小化时，任务仍应完整接收，而不是重新建连回放。
        openWhenHidden: true,
        async onopen(response) {
          const contentType = response.headers.get("content-type");
          if (!response.ok || !contentType?.startsWith(EventStreamContentType)) {
            throw new Error(`SSE connection failed: ${response.status}`);
          }
        },
        onmessage(message) {
          try {
            const event = JSON.parse(message.data) as AgentEvent;
            reconnectAttemptRef.current = 0;

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
  ): void {
    closeStream();
    onEventRef.current = onEvent;
    onDoneRef.current = onDone;
    taskIdRef.current = taskId;
    reconnectAttemptRef.current = 0;
    esRef.current = doConnect(taskId);
  }

  /** App 每次 render 同步最新闭包，避免长连接持续调用建连时的旧任务状态。 */
  function syncEventHandler(handler: (event: AgentEvent) => void): void {
    onEventRef.current = handler;
  }

  // 组件卸载时关闭连接
  useEffect(() => () => closeStream(), [closeStream]);

  return { esRef, closeStream, openStream, syncEventHandler };
}
