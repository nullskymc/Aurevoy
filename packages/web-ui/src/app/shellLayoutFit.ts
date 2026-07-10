import {
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKBENCH_WIDTH,
  RESIZE_HANDLE_WIDTH,
} from "./preferences";

/** Absolute floors when the viewport is smaller than soft mins + main. */
const EMERGENCY_MIN_SIDEBAR = 200;
const EMERGENCY_MIN_WORKBENCH = 240;

/**
 * Extra pixels required before auto-restoring the workbench after a collapse.
 * Avoids flapping when the window sits near the threshold.
 */
export const WORKBENCH_AUTO_RESTORE_HYSTERESIS = 80;

export interface ShellLayoutSnapshot {
  sidebarWidth: number;
  workbenchWidth: number;
  workbenchOpen: boolean;
  leftCollapsed: boolean;
}

export interface WorkbenchAutoCollapseInput {
  sidebarWidth: number;
  leftCollapsed: boolean;
}

/**
 * Minimum viewport width that can host the workbench at its soft minimum
 * while keeping the main column usable.
 */
export function minViewportForWorkbench(input: WorkbenchAutoCollapseInput): number {
  // Reserve the current preferred sidebar (at least soft min) so collapse happens
  // before the workbench is crushed below MIN_WORKBENCH_WIDTH.
  const sidebar = input.leftCollapsed ? 0 : Math.max(MIN_SIDEBAR_WIDTH, input.sidebarWidth);
  const handles =
    (input.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH) + RESIZE_HANDLE_WIDTH;
  return sidebar + handles + MIN_MAIN_WIDTH + MIN_WORKBENCH_WIDTH;
}

/** True when the right workbench should be force-closed for space. */
export function shouldAutoCollapseWorkbench(
  input: WorkbenchAutoCollapseInput,
  viewportWidth: number,
): boolean {
  return viewportWidth < minViewportForWorkbench(input);
}

/** True when a previously auto-collapsed workbench may safely reopen. */
export function shouldRestoreWorkbench(
  input: WorkbenchAutoCollapseInput,
  viewportWidth: number,
): boolean {
  return viewportWidth >= minViewportForWorkbench(input) + WORKBENCH_AUTO_RESTORE_HYSTERESIS;
}

export interface WindowWidthToOpenWorkbenchInput {
  currentInnerWidth: number;
  sidebarWidth: number;
  leftCollapsed: boolean;
  workbenchWidth: number;
}

/**
 * Target window width when opening the workbench.
 *
 * Uses an **absolute** layout (sidebar + main min + preferred workbench + handles),
 * then takes max(current, absolute). This grows a narrow window once to fit the
 * workbench without crushing the main column, but does **not** keep adding the
 * workbench width on every subsequent open/close cycle.
 */
export function windowWidthToOpenWorkbench(input: WindowWidthToOpenWorkbenchInput): number {
  const sidebar = input.leftCollapsed
    ? 0
    : Math.max(MIN_SIDEBAR_WIDTH, input.sidebarWidth);
  const leftHandle = input.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH;
  const rightHandle = RESIZE_HANDLE_WIDTH;
  const workbench = Math.max(MIN_WORKBENCH_WIDTH, input.workbenchWidth);
  const absoluteNeeded =
    sidebar + leftHandle + MIN_MAIN_WIDTH + rightHandle + workbench;
  return Math.max(input.currentInnerWidth, absoluteNeeded);
}

/**
 * Shrink side panels so sidebar + handles + main(min) + workbench fit the viewport.
 * Prefer reducing workbench first, then sidebar. Never auto-close panels here —
 * open/close is handled by the shell hook via shouldAutoCollapseWorkbench.
 * Soft mins are preferred; emergency floors apply only when the window is very narrow.
 */
export function fitPanelWidths(
  snapshot: ShellLayoutSnapshot,
  viewportWidth: number,
): { sidebarWidth: number; workbenchWidth: number } {
  let sidebarWidth = snapshot.sidebarWidth;
  let workbenchWidth = snapshot.workbenchWidth;

  const handles =
    (snapshot.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH) +
    (snapshot.workbenchOpen ? RESIZE_HANDLE_WIDTH : 0);

  const overflowOf = (sb: number, wb: number): number => {
    const sidebarUsed = snapshot.leftCollapsed ? 0 : sb;
    const workbenchUsed = snapshot.workbenchOpen ? wb : 0;
    return sidebarUsed + workbenchUsed + handles + MIN_MAIN_WIDTH - viewportWidth;
  };

  let overflow = overflowOf(sidebarWidth, workbenchWidth);

  // Pass 1: soft mins (normal IDE feel).
  if (overflow > 0 && snapshot.workbenchOpen) {
    const reducible = Math.max(0, workbenchWidth - MIN_WORKBENCH_WIDTH);
    const reduce = Math.min(overflow, reducible);
    workbenchWidth -= reduce;
    overflow -= reduce;
  }

  if (overflow > 0 && !snapshot.leftCollapsed) {
    const reducible = Math.max(0, sidebarWidth - MIN_SIDEBAR_WIDTH);
    const reduce = Math.min(overflow, reducible);
    sidebarWidth -= reduce;
    overflow -= reduce;
  }

  // Pass 2: emergency floors for very narrow windows (still keep both panels usable).
  if (overflow > 0 && snapshot.workbenchOpen) {
    const reducible = Math.max(0, workbenchWidth - EMERGENCY_MIN_WORKBENCH);
    const reduce = Math.min(overflow, reducible);
    workbenchWidth -= reduce;
    overflow -= reduce;
  }

  if (overflow > 0 && !snapshot.leftCollapsed) {
    const reducible = Math.max(0, sidebarWidth - EMERGENCY_MIN_SIDEBAR);
    const reduce = Math.min(overflow, reducible);
    sidebarWidth -= reduce;
  }

  return { sidebarWidth, workbenchWidth };
}
