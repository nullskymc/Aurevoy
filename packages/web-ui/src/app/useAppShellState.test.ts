import { describe, expect, it } from "vitest";
import { inferNoticeTone } from "./useAppShellState";

describe("app shell notice classification", () => {
  it("keeps explicit tone authoritative", () => {
    expect(inferNoticeTone("连接失败", "info")).toBe("info");
  });

  it("classifies localized failure text as persistent error", () => {
    expect(inferNoticeTone("无法授权工作区预览")).toBe("error");
    expect(inferNoticeTone("failed to connect")).toBe("error");
  });

  it("uses info for ordinary status text", () => {
    expect(inferNoticeTone("已保存")).toBe("info");
  });
});
