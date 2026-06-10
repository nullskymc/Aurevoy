import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

function renderMd(content: string) {
  const { container } = render(<MarkdownRenderer content={content} />);
  return container.querySelector(".markdown-body") as HTMLElement;
}

describe("MarkdownRenderer (marked + highlight.js + DOMPurify)", () => {
  it("renders ordered lists", () => {
    const body = renderMd("1. first\n2. second\n3. third");
    const ol = body.querySelector("ol");
    expect(ol).toBeInTheDocument();
    expect(ol?.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders GFM tables", () => {
    const body = renderMd("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(body.querySelector("table")).toBeInTheDocument();
    expect(body.querySelectorAll("th")).toHaveLength(2);
    expect(body.querySelectorAll("td")).toHaveLength(2);
  });

  it("renders blockquotes", () => {
    const body = renderMd("> quoted text");
    expect(body.querySelector("blockquote")).toBeInTheDocument();
  });

  it("applies syntax highlighting classes to fenced code blocks", () => {
    const body = renderMd("```ts\nconst x: number = 1;\n```");
    const code = body.querySelector("pre code");
    expect(code).toBeInTheDocument();
    expect(code?.className).toContain("hljs");
    // 语法令牌被高亮（keyword/类型等被包裹为 span）
    expect(code?.querySelector("span")).toBeInTheDocument();
  });

  it("sanitizes script tags from untrusted content", () => {
    const body = renderMd("hello <script>window.__x = 1;</script> world");
    expect(body.querySelector("script")).not.toBeInTheDocument();
    expect(body.innerHTML).not.toContain("window.__x");
  });

  it("strips dangerous event handlers and javascript: urls", () => {
    const body = renderMd('<img src="x" onerror="alert(1)" /> [link](javascript:alert(1))');
    const img = body.querySelector("img");
    if (img) expect(img.getAttribute("onerror")).toBeNull();
    const link = body.querySelector("a");
    if (link) expect(link.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
