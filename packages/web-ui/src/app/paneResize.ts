import type { PointerEvent as ReactPointerEvent } from "react";
import { clamp } from "./preferences";

/** Start a pointer-driven 1D resize; updates on every move until pointerup. */
export function startPaneResize(
  event: ReactPointerEvent<HTMLElement>,
  options: {
    axis: "x" | "y";
    startSize: number;
    min: number;
    max: number;
    /** When true, positive pointer delta shrinks the pane (handle on the leading edge). */
    invert?: boolean;
    onSize: (size: number) => void;
  },
): void {
  event.preventDefault();
  event.stopPropagation();
  const startPos = options.axis === "x" ? event.clientX : event.clientY;
  const { startSize, min, max, invert = false, onSize } = options;

  function handleMove(moveEvent: PointerEvent): void {
    const pos = options.axis === "x" ? moveEvent.clientX : moveEvent.clientY;
    const delta = pos - startPos;
    const next = invert ? startSize - delta : startSize + delta;
    onSize(clamp(next, min, max));
  }

  function handleUp(): void {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

export function readStoredPaneSize(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  const parsed = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}
