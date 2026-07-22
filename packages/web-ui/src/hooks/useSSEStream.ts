import { useCallback, useEffect, useRef } from "react";
import type { AgentEvent } from "@aurevoy/shared";
import { getBaseUrl } from "../api";

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * SSE 流管理 hook（带断线重连）。
 *
 * - EventSource 断开时自动指数退避重连（1s → 2s → 4s → … → 30s 上限）
 * - 收到 done / task_deleted 事件时终止重连
 * - 新 openStream 调用自动取消旧的待定重连
 * - 每次成功收到消息时重置退避计数器
 * - 后端 snapshot replay（server.ts:757-789）在重连时自动恢复所有丢失状态
 */
export function useSSEStream() {
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const onEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const onDoneRef = useRef<() => void>(() => {});

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeStream = useCallback((): void => {
    clearReconnectTimer();
    esRef.current?.close();
    esRef.current = null;
    taskIdRef.current = null;
    reconnectAttemptRef.current = 0;
  }, [clearReconnectTimer]);

  /**
   * 创建一个带重连逻辑的 EventSource。
   * onmessage / onerror 闭包通过 esRef 自引用以支持重连时重建。
   */
  const doConnect = useCallback(
    (taskId: string) => {
      const streamUrl = `${getBaseUrl()}/api/tasks/${taskId}/stream`;

      const setup = (es: EventSource) => {
        es.onmessage = (e: MessageEvent) => {
          try {
            const event = JSON.parse(e.data) as AgentEvent;
            // 成功收到消息 — 重置重连计数器
            reconnectAttemptRef.current = 0;

            // SSE 到达即按协议顺序分发；渲染隔离由下游 store/组件负责，不在传输层人为延迟。
            onEventRef.current(event);

            if (event.type === "done" || event.type === "task_deleted") {
              clearReconnectTimer();
              es.close();
              esRef.current = null;
              taskIdRef.current = null;
              onDoneRef.current();
            }
          } catch {
            // 忽略心跳（: ping）等非 JSON 行
          }
        };

        es.onerror = () => {
          es.close();
          // 仅当此 EventSource 仍是活跃实例时才重连（防止泄露）
          if (esRef.current !== es) return;
          esRef.current = null;

          // 如果 task 已完成或已被替换，不再重连
          if (taskIdRef.current !== taskId) return;

          const attempts = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = attempts;
          const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts - 1),
            MAX_RECONNECT_DELAY_MS,
          );

          clearReconnectTimer();
          reconnectTimerRef.current = setTimeout(() => {
            // 二次确认：重连时 taskId 未变更
            if (taskIdRef.current === taskId) {
              const newEs = new EventSource(streamUrl);
              setup(newEs);
              esRef.current = newEs;
            }
          }, delay);
        };
      };

      const es = new EventSource(streamUrl);
      setup(es);
      return es;
    },
    [clearReconnectTimer],
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
