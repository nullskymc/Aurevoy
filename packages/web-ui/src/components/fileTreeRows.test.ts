import { describe, expect, it } from "vitest";
import { buildVisibleFileTreeRows, type FileTreeNodeView } from "./fileTreeRows";

function node(overrides: Partial<FileTreeNodeView> = {}): FileTreeNodeView {
  return {
    entries: [],
    open: false,
    loading: false,
    error: null,
    truncated: false,
    ...overrides,
  };
}

describe("buildVisibleFileTreeRows", () => {
  it("flattens only expanded directories in stable tree order", () => {
    const rows = buildVisibleFileTreeRows(
      {
        ".": node({
          entries: [
            { name: "src", path: "src", type: "directory" },
            { name: "README.md", path: "README.md", type: "file" },
          ],
        }),
        src: node({
          open: true,
          entries: [{ name: "app.ts", path: "src/app.ts", type: "file" }],
        }),
      },
      "",
    );

    expect(rows.filter((row) => row.kind === "entry").map((row) => row.entry.path)).toEqual([
      "src",
      "src/app.ts",
      "README.md",
    ]);
  });

  it("keeps the load-more sentinel after a truncated page", () => {
    const rows = buildVisibleFileTreeRows(
      {
        ".": node({
          entries: [{ name: "one.txt", path: "one.txt", type: "file" }],
          truncated: true,
          next: 501,
        }),
      },
      "",
    );

    expect(rows.at(-1)).toMatchObject({
      kind: "message",
      path: ".",
      status: "load-more",
    });
  });

  it("does not render unrelated rows when filtering", () => {
    const rows = buildVisibleFileTreeRows(
      {
        ".": node({
          entries: [
            { name: "notes.txt", path: "notes.txt", type: "file" },
            { name: "report.md", path: "report.md", type: "file" },
          ],
        }),
      },
      "report",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "entry", entry: { path: "report.md" } });
  });
});
