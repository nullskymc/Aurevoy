import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Node 测试环境无完整 DOM；sanitize 在浏览器由 DOMPurify 负责，这里透传 HTML。
vi.mock("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

import {
  normalizeMarkdownMath,
  projectStreamingMarkdown,
  renderMarkdownToSafeHtml,
  StreamingMarkdownRenderer,
  updateStreamingMarkdownProjection,
} from "./MarkdownRenderer";

describe("StreamingMarkdownRenderer", () => {
  it("流式阶段直接保持 Markdown 排版，不再先显示裸语法", () => {
    const html = renderToStaticMarkup(
      createElement(StreamingMarkdownRenderer, { content: "**正在生成**" }),
    );
    expect(html).toContain("<strong>正在生成</strong>");
    expect(html).not.toContain("**正在生成**");
  });

  it("冻结已完成块，只把最后一个未完成段落标记为 live", () => {
    const blocks = projectStreamingMarkdown("# 标题\n\n第一段。\n\n**未完成");
    expect(blocks.map((block) => block.mode)).toEqual(["stable", "stable", "live"]);
    expect(blocks[0]?.source).toContain("# 标题");
    expect(blocks[2]?.source).toContain("未完成");
  });

  it("未闭合代码围栏使用轻量 code 块，避免每帧执行语法高亮", () => {
    const blocks = projectStreamingMarkdown("前文\n\n```ts\nconst value = 1");
    expect(blocks.at(-1)).toMatchObject({
      mode: "code",
      language: "ts",
      source: "const value = 1",
    });
  });

  it("纯追加时保留稳定前缀对象，只重新投影尾块", () => {
    const first = updateStreamingMarkdownProjection("# 标题\n\n第一段。\n\n第二");
    const second = updateStreamingMarkdownProjection("# 标题\n\n第一段。\n\n第二段。", first);

    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks[1]).toBe(first.blocks[1]);
    expect(second.blocks.at(-1)?.source).toContain("第二段");
  });

  it("非追加修改与引用定义回退全量投影", () => {
    const first = updateStreamingMarkdownProjection("旧标题\n\n[文档][ref]");
    const replaced = updateStreamingMarkdownProjection("新标题\n\n正文", first);
    const withReference = updateStreamingMarkdownProjection(
      "旧标题\n\n[文档][ref]\n\n[ref]: https://example.com",
      first,
    );

    expect(replaced.blocks[0]).not.toBe(first.blocks[0]);
    expect(withReference.blocks).toHaveLength(1);
    expect(withReference.blocks[0]?.mode).toBe("live");
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
