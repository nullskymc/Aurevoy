import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Node 测试环境无完整 DOM；sanitize 在浏览器由 DOMPurify 负责，这里透传 HTML。
vi.mock("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

vi.mock("streamdown", () => ({
  Streamdown: ({ children, mode, isAnimating, controls }: {
    children: string;
    mode?: string;
    isAnimating?: boolean;
    controls?: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-streamdown-mode": mode,
        "data-is-animating": String(isAnimating),
        "data-streamdown-controls": String(controls),
      },
      children,
    ),
}));

import {
  normalizeMarkdownMath,
  renderMarkdownToSafeHtml,
  StreamingMarkdownRenderer,
} from "./MarkdownRenderer";

describe("StreamingMarkdownRenderer", () => {
  it("委托 Streamdown 的 streaming 模式解析不完整 Markdown", () => {
    const html = renderToStaticMarkup(
      createElement(StreamingMarkdownRenderer, { content: "**正在生成**" }),
    );
    expect(html).toContain('data-streamdown-mode="streaming"');
    expect(html).toContain('data-is-animating="true"');
    expect(html).toContain('data-streamdown-controls="false"');
    expect(html).toContain("**正在生成**");
  });
});

describe("MarkdownRenderer math (KaTeX)", () => {
  it("renders inline math with $...$", () => {
    const html = renderMarkdownToSafeHtml("能量 $E=mc^2$ 成立。");
    expect(html).toContain("katex");
    expect(html).toMatch(/E|mc/);
    // 原文定界符不应原样残留为纯文本主导
    expect(html).not.toMatch(/\$E=mc\^2\$/);
  });

  it("renders display math with $$...$$", () => {
    const html = renderMarkdownToSafeHtml("$$\n\\frac{a}{b}\n$$");
    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
  });

  it("normalizes \\[ \\] and \\( \\) to dollar delimiters", () => {
    expect(normalizeMarkdownMath(String.raw`\[\frac{a}{b}\]`)).toContain("$$");
    expect(normalizeMarkdownMath(String.raw`inline \(x^2\) here`)).toContain("$x^2$");
  });

  it("renders bare [ latex ] blocks models often emit (screenshot case)", () => {
    const md =
      "不能按产业公司做 FCFF，要用 FCFE（股权自由现金流）：\n\n" +
      "[ \\text{FCFE} \\approx \\text{EPS}\\times\\left(1-\\frac{g}{\\text{ROE}}\\right) ]\n\n" +
      "在 g=4%、ROE=10% 时，再投资率=40%。";
    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    // 可视层应渲染为文字，而不是裸 `[ \text{...} ]` 段落
    expect(html).toContain("FCFE");
    expect(html).not.toMatch(/\[ \\text\{FCFE\}/);
  });

  it("does not rewrite markdown links as math", () => {
    const md = "see [docs](https://example.com) and [note]";
    const normalized = normalizeMarkdownMath(md);
    expect(normalized).toContain("[docs](https://example.com)");
    expect(normalized).toContain("[note]");
  });

  it("does not rewrite latex-looking text inside code fences", () => {
    const md = "```\n[ \\frac{a}{b} ]\n```";
    const normalized = normalizeMarkdownMath(md);
    expect(normalized).toContain("[ \\frac{a}{b} ]");
  });

  it("does not throw on invalid latex", () => {
    expect(() => renderMarkdownToSafeHtml("$\\unknowncommand{x}$")).not.toThrow();
  });

  it("still renders normal markdown", () => {
    const html = renderMarkdownToSafeHtml("**bold** and `code`");
    expect(html).toMatch(/<strong>bold<\/strong>/i);
    expect(html).toMatch(/<code>code<\/code>/i);
  });
});
