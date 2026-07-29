import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@aurevoy/shared";
import { mergeContentBlocks } from "./useAgentEventHandler";

describe("mergeContentBlocks", () => {
  it("upserts a present_ui block when a stable id is reused", () => {
    const oldBlock: ContentBlock = {
      id: "explorer",
      type: "ui",
      kind: "canvas",
      content: "旧版本",
      props: { html: "<p>old</p>" },
    };
    const newBlock: ContentBlock = {
      id: "explorer",
      type: "ui",
      kind: "canvas",
      content: "新版本",
      props: { html: "<p>new</p>" },
    };

    expect(mergeContentBlocks([oldBlock], [newBlock])).toEqual([newBlock]);
  });
});
