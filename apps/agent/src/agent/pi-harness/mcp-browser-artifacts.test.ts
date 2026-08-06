import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeMcpBrowserContentBlocks } from "./mcp-browser-artifacts.js";

describe("browser MCP artifact materialization", () => {
  it("writes screenshots, DOM text, and resources as untrusted workbench blocks", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "aurevoy-browser-artifacts-"));
    const result = await materializeMcpBrowserContentBlocks({
      taskId: "task/1",
      callId: "call:1",
      workspaceDir,
      result: {
        server: "playwright",
        result: {
          content: [
            { type: "image", data: Buffer.from("png-fixture").toString("base64"), mimeType: "image/png" },
            { type: "text", text: "<main>untrusted DOM</main>" },
            {
              type: "resource",
              resource: {
                blob: Buffer.from("download-fixture").toString("base64"),
                mimeType: "application/json",
              },
            },
          ],
        },
      },
    });

    expect(result).toHaveLength(3);
    expect(result.every((block) => block.untrusted === true && block.source === "external_untrusted")).toBe(true);
    expect(result[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(result[1]).toMatchObject({ type: "file_reference", mimeType: "text/plain" });
    expect(result[2]).toMatchObject({ type: "file_reference", mimeType: "application/json" });
    expect(await readFile(result[1]!.content, "utf8")).toContain("untrusted DOM");
    expect((await stat(result[2]!.content)).isFile()).toBe(true);
    expect(result.every((block) => block.content.includes(join(workspaceDir, ".aurevoy", "browser-artifacts")))).toBe(true);
  });

  it("does not materialize unrelated MCP servers or oversized content", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "aurevoy-browser-artifacts-"));
    const unrelated = await materializeMcpBrowserContentBlocks({
      taskId: "task",
      callId: "call",
      workspaceDir,
      result: { server: "filesystem", result: { content: [{ type: "text", text: "not browser" }] } },
    });
    expect(unrelated).toEqual([]);

    const oversized = await materializeMcpBrowserContentBlocks({
      taskId: "task",
      callId: "call",
      workspaceDir,
      result: { server: "browser", result: { content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }] } },
    });
    expect(oversized).toEqual([]);
  });
});
