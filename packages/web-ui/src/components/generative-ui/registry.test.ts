import { describe, expect, it } from "vitest";
import { generativeUiRegistry } from "./registry";

describe("generative UI canvas registry", () => {
  it("accepts sandboxed HTML/CSS/JS canvas without declaration nodes", () => {
    const result = generativeUiRegistry.canvas.validate({
      title: "自定义面板",
      html: '<button id="go">继续</button>',
      css: "button { color: red; }",
      script: 'document.querySelector("#go").onclick = () => aurevoy.emit("continue", { ok: true });',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ html: expect.any(String), script: expect.any(String) });
      expect((result.data as { body?: unknown[] }).body).toBeUndefined();
    }
  });

  it("still validates declaration canvas nodes", () => {
    const result = generativeUiRegistry.canvas.validate({
      state: { ready: false },
      body: [
        { type: "text", text: "准备中" },
        { type: "button", text: "继续", action: { type: "submit", id: "continue" } },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a partial JS canvas instead of silently falling back", () => {
    const result = generativeUiRegistry.canvas.validate({ html: "<p>缺少脚本</p>" });

    expect(result).toEqual({ ok: false, error: "JS 模式需要 html + script" });
  });
});
