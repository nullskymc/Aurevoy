// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchTabs, type WorkbenchTab } from "./useWorkbenchTabs";

let root: ReturnType<typeof createRoot> | undefined;
let controls: ReturnType<typeof useWorkbenchTabs> | undefined;
const storage = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size; },
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ projectId, taskId }: { projectId?: string; taskId?: string }) {
  controls = useWorkbenchTabs({ projectId, taskId });
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  controls = undefined;
  storage.clear();
  document.body.innerHTML = "";
});

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageStub });
});

describe("useWorkbenchTabs", () => {
  it("reuses the same workspace/artifact tab and prunes artifacts across tasks", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Harness, { projectId: "project-1", taskId: "task-1" })));

    act(() => {
      controls?.openWorkspaceFile("docs/report.md");
      controls?.openWorkspaceFile("docs/report.md");
      controls?.openArtifact({ id: "artifact-1", name: "report.html", mimeType: "text/html" }, "task-1");
      controls?.openArtifact({ id: "artifact-1", name: "report.html", mimeType: "text/html" }, "task-1");
    });

    expect(controls?.tabs).toHaveLength(2);
    expect(controls?.tabs.map((tab: WorkbenchTab) => tab.id)).toEqual([
      "workspace:docs/report.md",
      "artifact:task-1:artifact-1",
    ]);

    act(() => root?.render(createElement(Harness, { projectId: "project-1", taskId: "task-2" })));
    expect(controls?.tabs).toEqual([
      { id: "workspace:docs/report.md", kind: "workspace", path: "docs/report.md", name: "report.md" },
    ]);
  });

  it("restores project-scoped tabs from localStorage", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Harness, { projectId: "project-restore", taskId: "task-1" })));
    act(() => controls?.openWorkspaceFile("src/app.ts"));
    expect(window.localStorage.getItem("aurevoy.workbenchTabs.v2")).toContain("src/app.ts");

    act(() => root?.unmount());
    root = createRoot(host);
    act(() => root?.render(createElement(Harness, { projectId: "project-restore", taskId: "task-1" })));
    expect(controls?.activeTab?.kind === "workspace" ? controls.activeTab.path : undefined).toBe("src/app.ts");
  });
});
