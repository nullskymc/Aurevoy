import { useMemo } from "react";
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

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  // marked 输出来自 LLM/工具的不可信内容，渲染前必须经 DOMPurify 净化，防 XSS。
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content, { async: false }) as string;
      return DOMPurify.sanitize(raw);
    } catch {
      // 解析失败时退化为纯文本（已转义），不抛 HTML。
      return DOMPurify.sanitize(content);
    }
  }, [content]);

  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
