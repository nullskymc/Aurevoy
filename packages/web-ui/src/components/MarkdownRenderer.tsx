import { useMemo, useCallback, useState, type MouseEvent } from "react";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { copySvgHtml } from "../icons";

// 按需注册常用语言，避免打包整个 highlight.js。
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);

// 数学公式：inline $...$ / \\(...\\)，块级 $$...$$ / \\[...\\]
// nonStandard：兼容 LLM 输出里 $ 两侧无空格的情况。
marked.use(
  markedKatex({
    throwOnError: false,
    nonStandard: true,
    output: "htmlAndMathml",
  }),
);

// marked v5+ 通过 marked-highlight 扩展注册语法高亮（同步高亮，parse() 同步返回 string）。
marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

marked.use({ gfm: true, breaks: false });

/**
 * 渲染侧兼容模型常见「不规范」公式写法，统一成 marked-katex 能识别的 $ / $$。
 * 不要求模型遵守特定定界符规范。
 *
 * 支持（在 code fence / 行内 code 之外）：
 * - 标准：`$...$` `$$...$$`（原样保留）
 * - LaTeX：`\[...\]` `\(...\)`
 * - 模型常写的裸括号块：`[ \text{FCFE} \approx ... ]`（含反斜杠命令）
 */
export function normalizeMarkdownMath(source: string): string {
  const { text, restore } = protectMarkdownCodeSegments(source);
  let s = text;

  // \[ ... \] → 块级 $$
  s = s.replace(/\\\[((?:\\.|[\s\S])*?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`);
  // \( ... \) → 行内 $
  s = s.replace(/\\\(((?:\\.|[\s\S])*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);

  // 裸 [ latex ]：排除 ![img]( 与 [link](
  s = s.replace(
    /(^|[^!\\\w])\[(?!\s*[^\n\]]{0,240}\]\()((?:[^\[\]\\]|\\[\s\S])+?)\](?!\()/g,
    (full, prefix: string, body: string) => {
      if (!looksLikeLatexMath(body)) return full;
      const trimmed = body.trim();
      const isBlock =
        /\n/.test(trimmed)
        || trimmed.length > 48
        || /\\(?:begin|frac|sum|int|prod|left|right|displaystyle|lim|partial|nabla|oint)/.test(trimmed);
      if (isBlock) return `${prefix}\n$$\n${trimmed}\n$$\n`;
      return `${prefix}$${trimmed}$`;
    },
  );

  // 模型偶尔会输出 `\Big \mathrm{...}` 或行尾 `\Big`。
  // 尺寸命令必须紧跟括号/竖线等定界符；无效时移除该命令，保留公式其余可解析部分。
  s = repairMalformedLatexSizingCommands(s);

  return restore(s);
}

function repairMalformedLatexSizingCommands(source: string): string {
  const sizingCommand = String.raw`\\(?:Bigg|bigg|Big|big)(?:l|m|r)?`;
  const delimiter = String.raw`[()[\]{}|]|\\(?:\||vert|Vert|lvert|rvert|lVert|rVert|langle|rangle|lbrace|rbrace|lfloor|rfloor|lceil|rceil)`;
  const invalidSizingCommand = new RegExp(
    `(${sizingCommand})(?!\\s*${delimiter})`,
    "g",
  );
  return source.replace(invalidSizingCommand, "");
}

function looksLikeLatexMath(body: string): boolean {
  const t = body.trim();
  if (!t || t.length > 8000) return false;
  // 至少一个 LaTeX 命令：\text \frac \left ...
  if (/\\[a-zA-Z]+/.test(t)) return true;
  // 弱启发：下标/上标 + 运算符（避免普通中文括号句）
  if (t.length <= 96 && /[_^]/.test(t) && /[=+\-*/<>≈≤≥]/.test(t)) return true;
  return false;
}

/** 保护 ```fence``` 与 `inline code`，避免误改代码里的括号/美元符。 */
function protectMarkdownCodeSegments(source: string): {
  text: string;
  restore: (value: string) => string;
} {
  const blocks: string[] = [];
  const stash = (match: string): string => {
    const i = blocks.length;
    blocks.push(match);
    return `\u0000MDCODE${i}\u0000`;
  };
  // 先 fence，再行内
  let text = source.replace(/```[\s\S]*?```/g, stash);
  text = text.replace(/`[^`\n]+`/g, stash);
  return {
    text,
    restore: (value: string) =>
      value.replace(/\u0000MDCODE(\d+)\u0000/g, (_m, idx: string) => blocks[Number(idx)] ?? ""),
  };
}

const PATH_CHIP_RE =
  /(?:^|[\s(「『"])((?:\/[\w.@+-]+)+(?:\/[\w.@+-]+)*|(?:[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+)|(?:[\w.-]+\.(?:ts|tsx|js|jsx|py|md|json|css|html|rs|go|java|rb|yml|yaml|toml|sh|sql|txt|ipynb|svg|png|jpg)))(?=$|[\s),。」』"'])/g;

interface MarkdownRendererProps {
  content: string;
  onOpenWorkspacePath?: (path: string) => void;
}

// Streamdown 的数学插件不默认将单美元符识别为公式；此处保持 Aurevoy 既有 $...$ 行内公式兼容。
const streamdownMath = createMathPlugin({ singleDollarTextMath: true });

function enhancePathChips(html: string): string {
  // 跳过 code/pre/katex 内文本，避免路径 chip 拆开公式或代码。
  // 用标签栈记录祖先 class，含 katex 则整段跳过。
  const parts = html.split(/(<[^>]+>)/g);
  let inCode = false;
  const classStack: string[] = [];
  return parts
    .map((part) => {
      if (part.startsWith("<")) {
        const lower = part.toLowerCase();
        if (/^<(code|pre)\b/.test(lower)) inCode = true;
        if (/^<\/(code|pre)>/.test(lower)) inCode = false;

        const isClose = /^<\//.test(part);
        const isSelfClose = /\/>$/.test(part) || /^<(?:br|hr|img|input|meta|link|path|line|use|mspace)\b/i.test(part);
        if (isClose) {
          classStack.pop();
        } else if (!isSelfClose) {
          const classMatch = /\bclass=(["'])(.*?)\1/i.exec(part);
          classStack.push(classMatch?.[2] ?? "");
        }
        return part;
      }
      const inKatex = classStack.some((cls) => /\bkatex\b/i.test(cls));
      if (inCode || inKatex || !part.trim()) return part;
      return part.replace(PATH_CHIP_RE, (match, path: string) => {
        const prefix = match.slice(0, match.indexOf(path));
        const escaped = escapeHtmlAttr(path);
        const chip = `<button type="button" class="markdown-path-chip" data-path="${escaped}">${escapeHtmlText(path)}</button>`;
        return `${prefix}${chip}`;
      });
    })
    .join("");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 外链：favicon + 蓝色文案（Codex 正文链接感） */
function enhanceExternalLinks(html: string): string {
  return html.replace(
    /<a\s+([^>]*?)href="(https?:\/\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
    (match, pre: string, href: string, post: string, text: string) => {
      if (/\bclass="/i.test(pre + post) && /markdown-ext-link|markdown-path-chip/i.test(pre + post)) {
        return match;
      }
      // 已有 favicon 的不重复包
      if (text.includes("markdown-link-favicon")) return match;
      let domain = "";
      try {
        domain = new URL(href).hostname.replace(/^www\./i, "");
      } catch {
        return match;
      }
      if (!domain) return match;
      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
      const attrs = `${pre}href="${href}"${post}`.replace(/\s+/g, " ").trim();
      const hasTarget = /\btarget=/i.test(attrs);
      const hasRel = /\brel=/i.test(attrs);
      const extra =
        `${hasTarget ? "" : ' target="_blank"'}${hasRel ? "" : ' rel="noopener noreferrer"'}`;
      return (
        `<a ${attrs}${extra} class="markdown-ext-link">` +
        `<img class="markdown-link-favicon" src="${favicon}" alt="" width="14" height="14" loading="lazy" decoding="async" />` +
        `<span class="markdown-ext-link-text">${text}</span>` +
        `</a>`
      );
    },
  );
}

function wrapCodeBlocks(html: string): string {
  // marked 输出 <pre><code class="hljs language-xxx">...</code></pre>
  return html.replace(
    /<pre><code class="hljs language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_m, lang: string, code: string) => {
      const safeLang = escapeHtmlText(lang || "text");
      return (
        `<div class="markdown-code-block" data-lang="${safeLang}">` +
        `<div class="markdown-code-header">` +
        `<span class="markdown-code-lang">${safeLang}</span>` +
        `<button type="button" class="markdown-code-copy" data-copy-code="1" aria-label="Copy code">` +
        `${copySvgHtml(14)}</button></div>` +
        `<pre><code class="hljs language-${safeLang}">${code}</code></pre></div>`
      );
    },
  ).replace(
    /<pre><code(?: class="hljs")?>([\s\S]*?)<\/code><\/pre>/g,
    (_m, code: string) => {
      if (code.includes("markdown-code-block")) return _m;
      return (
        `<div class="markdown-code-block" data-lang="text">` +
        `<div class="markdown-code-header">` +
        `<span class="markdown-code-lang">text</span>` +
        `<button type="button" class="markdown-code-copy" data-copy-code="1" aria-label="Copy code">` +
        `${copySvgHtml(14)}</button></div>` +
        `<pre><code class="hljs">${code}</code></pre></div>`
      );
    },
  );
}

/** 导出给单测：完整 MD→安全 HTML（含公式）。 */
export function renderMarkdownToSafeHtml(content: string): string {
  const normalized = normalizeMarkdownMath(content);
  const raw = marked.parse(normalized, { async: false }) as string;
  const withCode = wrapCodeBlocks(raw);
  const withChips = enhancePathChips(withCode);
  const withLinks = enhanceExternalLinks(withChips);
  // KaTeX 输出含 MathML + 内联 style/SVG；放行 html/svg/math 配置，并保留交互 attr。
  return DOMPurify.sanitize(withLinks, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ["button"],
    ADD_ATTR: [
      "data-path",
      "data-copy-code",
      "data-lang",
      "type",
      "loading",
      "decoding",
      "target",
      "rel",
      "aria-hidden",
      "focusable",
      "role",
      "xmlns",
      "encoding",
      "viewBox",
      "preserveAspectRatio",
      "d",
      "width",
      "height",
      "x",
      "y",
      "cx",
      "cy",
      "r",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
      "transform",
      "style",
      "class",
    ],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

function useMarkdownClickHandler(onOpenWorkspacePath?: (path: string) => void) {
  const [, setCopied] = useState(false);
  return useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const copyBtn = target.closest<HTMLElement>("[data-copy-code]");
      if (copyBtn) {
        const block = copyBtn.closest(".markdown-code-block");
        const codeEl = block?.querySelector("code");
        const text = codeEl?.textContent ?? "";
        if (text) {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }).catch(() => {});
        }
        event.preventDefault();
        return;
      }

      const chip = target.closest<HTMLElement>("[data-path]");
      if (chip && onOpenWorkspacePath) {
        const path = chip.getAttribute("data-path");
        if (path) {
          onOpenWorkspacePath(path);
          event.preventDefault();
        }
      }
    },
    [onOpenWorkspacePath],
  );
}

/** Streamdown 负责不完整 Markdown 的安全解析、分块及增量渲染。 */
export function StreamingMarkdownRenderer({ content, onOpenWorkspacePath }: MarkdownRendererProps) {
  const handleClick = useMarkdownClickHandler(onOpenWorkspacePath);
  return (
    <div className="markdown-body markdown-body--streaming" onClick={handleClick}>
      <Streamdown
        mode="streaming"
        isAnimating
        animated={false}
        // 使用消息卡片自己的操作区，避免 Streamdown 为表格/代码额外插入控件。
        controls={false}
        // 未闭合的公式交由下一次完整内容再解析，避免 SSE 分片触发 KaTeX 错误闪烁。
        parseIncompleteMarkdown={false}
        plugins={{ math: streamdownMath }}
        // 由桌面端统一处理链接打开策略，避免流式正文弹出网页安全确认框。
        linkSafety={{ enabled: false }}
        components={{ strong: "strong" }}
      >
        {normalizeMarkdownMath(content)}
      </Streamdown>
    </div>
  );
}

export function MarkdownRenderer({ content, onOpenWorkspacePath }: MarkdownRendererProps) {
  // marked 输出来自 LLM/工具的不可信内容，渲染前必须经 DOMPurify 净化，防 XSS。
  const html = useMemo(() => {
    try {
      return renderMarkdownToSafeHtml(content);
    } catch {
      // 解析失败时退化为纯文本（已转义），不抛 HTML。
      return DOMPurify.sanitize(content);
    }
  }, [content]);

  const handleClick = useMarkdownClickHandler(onOpenWorkspacePath);

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}
