// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalShortcut, useGlobalShortcuts, type ShortcutEventLike } from "./useGlobalShortcuts";

let root: ReturnType<typeof createRoot> | undefined;

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "k",
    code: "KeyK",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function Harness(props: Parameters<typeof useGlobalShortcuts>[0]) {
  useGlobalShortcuts(props);
  return null;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

describe("global shortcuts", () => {
  it("maps Cmd/Ctrl K, N and comma without stealing modified variants", () => {
    expect(resolveGlobalShortcut(event({ key: "k" }))).toBe("search");
    expect(resolveGlobalShortcut(event({ key: "n" }))).toBe("new-task");
    expect(resolveGlobalShortcut(event({ key: ",", code: "Comma" }))).toBe("settings");
    expect(resolveGlobalShortcut(event({ key: "Comma", code: "Comma" }))).toBe("settings");
    expect(resolveGlobalShortcut(event({ key: "k", shiftKey: true }))).toBeNull();
    expect(resolveGlobalShortcut(event({ key: "k", altKey: true }))).toBeNull();
    expect(resolveGlobalShortcut(event({ key: "k", isComposing: true }))).toBeNull();
    expect(resolveGlobalShortcut(event({ key: "k", defaultPrevented: true }))).toBeNull();
  });

  it("dispatches shortcuts once and leaves secondary actions to an open search popover", () => {
    const onToggleSearch = vi.fn();
    const onNewTask = vi.fn();
    const onOpenSettings = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <Harness
          searchOpen={false}
          onToggleSearch={onToggleSearch}
          onNewTask={onNewTask}
          onOpenSettings={onOpenSettings}
        />,
      );
    });

    const searchEvent = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
    act(() => window.dispatchEvent(searchEvent));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
    expect(searchEvent.defaultPrevented).toBe(true);

    const newTaskEvent = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, cancelable: true });
    act(() => window.dispatchEvent(newTaskEvent));
    expect(onNewTask).toHaveBeenCalledTimes(1);

    const settingsEvent = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, cancelable: true });
    act(() => window.dispatchEvent(settingsEvent));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <Harness
          searchOpen
          onToggleSearch={onToggleSearch}
          onNewTask={onNewTask}
          onOpenSettings={onOpenSettings}
        />,
      );
    });
    const delegatedNewTaskEvent = new KeyboardEvent("keydown", { key: "n", metaKey: true, cancelable: true });
    act(() => window.dispatchEvent(delegatedNewTaskEvent));
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(delegatedNewTaskEvent.defaultPrevented).toBe(false);

    const settingsWhileSearchOpen = new KeyboardEvent("keydown", { key: ",", metaKey: true, cancelable: true });
    act(() => window.dispatchEvent(settingsWhileSearchOpen));
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
    expect(settingsWhileSearchOpen.defaultPrevented).toBe(true);
  });
});
