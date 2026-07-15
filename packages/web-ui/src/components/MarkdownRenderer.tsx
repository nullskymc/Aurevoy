import { useMemo, useCallback, useState, type MouseEvent } from "react";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";

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

const PATH_CHIP_RE =
  /(?:^|[\s(「『"])((?:\/[\w.@+-]+)+(?:\/[\w.@+-]+)*|(?:[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+)|(?:[\w.-]+\.(?:ts|tsx|js|jsx|py|md|json|css|html|rs|go|java|rb|yml|yaml|toml|sh|sql|txt|ipynb|svg|png|jpg)))(?=$|[\s),。」』"'])/g;

interface MarkdownRendererProps {
  content: string;
  onOpenWorkspacePath?: (path: string) => void;
}

function enhancePathChips(html: string): string {
  // 跳过已在 code/pre/a 内的内容：粗略保护 — 仅处理不在标签属性中的文本节点片段很难，
  // 这里只对「不在标签内」的纯文本块做有限替换：先 split by tags。
  const parts = html.split(/(<[^>]+>)/g);
  let inCode = false;
  return parts
    .map((part) => {
      if (part.startsWith("<")) {
        const lower = part.toLowerCase();
        if (/^<(code|pre)\b/.test(lower)) inCode = true;
        if (/^<\/(code|pre)>/.test(lower)) inCode = false;
        return part;
      }
      if (inCode || !part.trim()) return part;
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
        `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">` +
        `<rect x="5.5" y="5.5" width="7" height="8" rx="1.2" stroke="currentColor" stroke-width="1.2"/>` +
        `<path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>` +
        `</svg></button></div>` +
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
        `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">` +
        `<rect x="5.5" y="5.5" width="7" height="8" rx="1.2" stroke="currentColor" stroke-width="1.2"/>` +
        `<path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>` +
        `</svg></button></div>` +
        `<pre><code class="hljs">${code}</code></pre></div>`
      );
    },
  );
}

export function MarkdownRenderer({ content, onOpenWorkspacePath }: MarkdownRendererProps) {
  const [, setCopied] = useState(false);
  // marked 输出来自 LLM/工具的不可信内容，渲染前必须经 DOMPurify 净化，防 XSS。
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content, { async: false }) as string;
      const withCode = wrapCodeBlocks(raw);
      const withChips = enhancePathChips(withCode);
      const withLinks = enhanceExternalLinks(withChips);
      return DOMPurify.sanitize(withLinks, {
        ADD_ATTR: ["data-path", "data-copy-code", "data-lang", "type", "loading", "decoding", "target", "rel"],
        ADD_TAGS: ["button"],
        ALLOW_UNKNOWN_PROTOCOLS: false,
      });
    } catch {
      // 解析失败时退化为纯文本（已转义），不抛 HTML。
      return DOMPurify.sanitize(content);
    }
  }, [content]);

  const handleClick = useCallback(
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

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}
