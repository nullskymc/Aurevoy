import { useEffect, useRef } from "react";
import type { AgentEvent } from "@aurevoy/shared";
import { streamTask } from "../api";

export function useSSEStream() {
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => () => esRef.current?.close(), []);

  function closeStream(): void {
    esRef.current?.close();
    esRef.current = null;
  }

  function openStream(
    taskId: string,
    onEvent: (event: AgentEvent) => void,
    onDone: () => void,
  ): void {
    closeStream();
    esRef.current = streamTask(taskId, onEvent, onDone);
  }

  return { esRef, closeStream, openStream };
}
