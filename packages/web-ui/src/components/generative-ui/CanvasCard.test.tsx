import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContentBlock } from "@aurevoy/shared";
import { CanvasCard } from "./CanvasCard";

describe("CanvasCard", () => {
  it("renders a constrained sandbox iframe for a valid canvas block", () => {
    const block: ContentBlock = {
      id: "explorer-1",
      type: "ui",
      kind: "canvas",
      content: "数据探索器",
      props: {
        title: "数据探索器",
        state: { selected: "A" },
        html: '<button id="pick">选择</button><output id="value"></output>',
        script: 'document.querySelector("#value").textContent = window.aurevoy.state.selected;',
      },
    };

    const html = renderToStaticMarkup(<CanvasCard block={block} />);

    expect(html).toContain("gen-ui-canvas");
    expect(html).toContain('sandbox="allow-forms allow-modals allow-popups allow-scripts"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src &#x27;none&#x27;");
    expect(html).toContain("数据探索器");
    expect(html).toContain("window.aurevoy");
    expect(html).toContain("--av-bg: #f4f6f5");
    expect(html).toContain("--av-accent: #3d7a6e");
    expect(html).toContain("--av-accent-soft-bg: #d8ebe5");
  });

  it("shows fallback text when the canvas props are malformed", () => {
    const block = {
      id: "broken-ui",
      type: "ui",
      kind: "canvas",
      content: "",
      fallbackText: "无法显示这个交互片段",
    } as ContentBlock;

    const html = renderToStaticMarkup(<CanvasCard block={block} />);

    expect(html).toContain("gen-ui-fallback");
    expect(html).toContain("无法显示这个交互片段");
    expect(html).not.toContain("<iframe");
  });
});
