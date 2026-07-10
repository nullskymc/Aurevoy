import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_WORKBENCH_WIDTH,
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKBENCH_WIDTH,
  RESIZE_HANDLE_WIDTH,
} from "./preferences";
import {
  fitPanelWidths,
  minViewportForWorkbench,
  shouldAutoCollapseWorkbench,
  shouldRestoreWorkbench,
  windowWidthToOpenWorkbench,
  WORKBENCH_AUTO_RESTORE_HYSTERESIS,
} from "./shellLayoutFit";

function usedWidth(
  result: { sidebarWidth: number; workbenchWidth: number },
  opts: { workbenchOpen: boolean; leftCollapsed: boolean },
): number {
  return (
    (opts.leftCollapsed ? 0 : result.sidebarWidth) +
    (opts.workbenchOpen ? result.workbenchWidth : 0) +
    (opts.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH) +
    (opts.workbenchOpen ? RESIZE_HANDLE_WIDTH : 0) +
    MIN_MAIN_WIDTH
  );
}

describe("fitPanelWidths", () => {
  it("keeps preferred widths when the viewport is wide enough", () => {
    const result = fitPanelWidths(
      {
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        workbenchWidth: DEFAULT_WORKBENCH_WIDTH,
        workbenchOpen: true,
        leftCollapsed: false,
      },
      1600,
    );
    expect(result.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(result.workbenchWidth).toBe(DEFAULT_WORKBENCH_WIDTH);
  });

  it("shrinks workbench first when the window is moderately narrow", () => {
    const viewport = 1200;
    const result = fitPanelWidths(
      {
        sidebarWidth: 330,
        workbenchWidth: 720,
        workbenchOpen: true,
        leftCollapsed: false,
      },
      viewport,
    );

    expect(usedWidth(result, { workbenchOpen: true, leftCollapsed: false })).toBeLessThanOrEqual(
      viewport,
    );
    expect(result.workbenchWidth).toBeLessThan(720);
    expect(result.workbenchWidth).toBeGreaterThanOrEqual(MIN_WORKBENCH_WIDTH);
    expect(result.sidebarWidth).toBe(330);
  });

  it("also shrinks sidebar when workbench is already at soft minimum", () => {
    const viewport = 1000;
    const result = fitPanelWidths(
      {
        sidebarWidth: 400,
        workbenchWidth: 720,
        workbenchOpen: true,
        leftCollapsed: false,
      },
      viewport,
    );

    expect(result.workbenchWidth).toBeLessThanOrEqual(MIN_WORKBENCH_WIDTH);
    expect(result.sidebarWidth).toBeLessThan(400);
    expect(usedWidth(result, { workbenchOpen: true, leftCollapsed: false })).toBeLessThanOrEqual(
      viewport,
    );
  });

  it("uses emergency floors on very narrow windows", () => {
    const viewport = 840;
    const result = fitPanelWidths(
      {
        sidebarWidth: 330,
        workbenchWidth: 720,
        workbenchOpen: true,
        leftCollapsed: false,
      },
      viewport,
    );

    expect(result.sidebarWidth).toBeGreaterThanOrEqual(200);
    expect(result.workbenchWidth).toBeGreaterThanOrEqual(240);
    expect(result.sidebarWidth).toBeLessThan(MIN_SIDEBAR_WIDTH);
    expect(usedWidth(result, { workbenchOpen: true, leftCollapsed: false })).toBeLessThanOrEqual(
      viewport,
    );
  });

  it("ignores collapsed sidebar and closed workbench footprints", () => {
    const result = fitPanelWidths(
      {
        sidebarWidth: 400,
        workbenchWidth: 900,
        workbenchOpen: false,
        leftCollapsed: true,
      },
      700,
    );
    expect(result.sidebarWidth).toBe(400);
    expect(result.workbenchWidth).toBe(900);
  });
});

describe("workbench auto-collapse", () => {
  const input = { sidebarWidth: 280, leftCollapsed: false };

  it("computes the minimum viewport that still fits the workbench", () => {
    // 280 + 6 + 360 + 6 + 320 = 972
    expect(minViewportForWorkbench(input)).toBe(
      280 + RESIZE_HANDLE_WIDTH * 2 + MIN_MAIN_WIDTH + MIN_WORKBENCH_WIDTH,
    );
  });

  it("collapses when the viewport cannot host min workbench + main", () => {
    const threshold = minViewportForWorkbench(input);
    expect(shouldAutoCollapseWorkbench(input, threshold - 1)).toBe(true);
    expect(shouldAutoCollapseWorkbench(input, threshold)).toBe(false);
  });

  it("restores only after hysteresis above the collapse threshold", () => {
    const threshold = minViewportForWorkbench(input);
    expect(shouldRestoreWorkbench(input, threshold)).toBe(false);
    expect(
      shouldRestoreWorkbench(input, threshold + WORKBENCH_AUTO_RESTORE_HYSTERESIS - 1),
    ).toBe(false);
    expect(
      shouldRestoreWorkbench(input, threshold + WORKBENCH_AUTO_RESTORE_HYSTERESIS),
    ).toBe(true);
  });

  it("uses less space when the left sidebar is already collapsed", () => {
    const openLeft = minViewportForWorkbench({ sidebarWidth: 280, leftCollapsed: false });
    const closedLeft = minViewportForWorkbench({ sidebarWidth: 280, leftCollapsed: true });
    expect(closedLeft).toBeLessThan(openLeft);
  });

  it("grows a narrow window to the absolute open layout, not current+workbench", () => {
    // 280 + 6 + 360 + 6 + 520 = 1172
    const absolute = 280 + RESIZE_HANDLE_WIDTH * 2 + MIN_MAIN_WIDTH + 520;
    expect(
      windowWidthToOpenWorkbench({
        currentInnerWidth: 900,
        sidebarWidth: 280,
        leftCollapsed: false,
        workbenchWidth: 520,
      }),
    ).toBe(absolute);
  });

  it("does not keep growing when the window is already wide enough", () => {
    const alreadyWide = 1600;
    expect(
      windowWidthToOpenWorkbench({
        currentInnerWidth: alreadyWide,
        sidebarWidth: 280,
        leftCollapsed: false,
        workbenchWidth: 520,
      }),
    ).toBe(alreadyWide);
  });

  it("is stable across repeated open calculations at the same width", () => {
    const input = {
      currentInnerWidth: 1200,
      sidebarWidth: 280,
      leftCollapsed: false,
      workbenchWidth: 520,
    };
    const first = windowWidthToOpenWorkbench(input);
    const second = windowWidthToOpenWorkbench({ ...input, currentInnerWidth: first });
    expect(second).toBe(first);
  });
});
