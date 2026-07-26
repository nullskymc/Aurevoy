import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentBlock, UiCanvasProps } from "@aurevoy/shared";
import "./generative-ui.css";

/** 在无同源权限的 sandbox iframe 内呈现 Agent 生成的对话内交互片段。 */
export function CanvasCard({ block }: { block: ContentBlock }) {
  const [themeVersion, setThemeVersion] = useState(0);
  const [frameHeight, setFrameHeight] = useState(320);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const props = asCanvasProps(block.props);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeVersion((version) => version + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleResize = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow || !isResizeMessage(event.data)) return;
      setFrameHeight(Math.max(160, Math.min(1_200, Math.ceil(event.data.height))));
    };
    window.addEventListener("message", handleResize);
    return () => window.removeEventListener("message", handleResize);
  }, []);

  const srcDoc = useMemo(
    () => props ? buildCanvasDocument(props) : null,
    [props, themeVersion],
  );

  if (!props || !srcDoc) {
    return (
      <p className="gen-ui-fallback" role="status">
        {block.fallbackText || block.content || "交互式内容无法渲染。"}
      </p>
    );
  }

  return (
    <section className="gen-ui-card gen-ui-canvas" aria-label={props.title || "交互式内容"}>
      {(props.title || props.description) && (
        <header className="gen-ui-canvas-head">
          {props.title && <h3>{props.title}</h3>}
          {props.description && <p>{props.description}</p>}
        </header>
      )}
      <iframe
        ref={frameRef}
        className="gen-ui-canvas-frame"
        title={props.title || "Agent interactive canvas"}
        sandbox="allow-forms allow-modals allow-popups allow-scripts"
        srcDoc={srcDoc}
        style={{ height: `${frameHeight}px` }}
      />
    </section>
  );
}

function asCanvasProps(value: ContentBlock["props"]): UiCanvasProps | null {
  if (!value || typeof value !== "object" || typeof value.html !== "string" || !value.html.trim()) {
    return null;
  }
  return {
    title: typeof value.title === "string" ? value.title : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    state: isPrimitiveRecord(value.state) ? value.state : undefined,
    html: value.html,
    css: typeof value.css === "string" ? value.css : undefined,
    script: typeof value.script === "string" ? value.script : undefined,
  };
}

function isResizeMessage(value: unknown): value is { type: "aurevoy_ui_resize"; height: number } {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "aurevoy_ui_resize"
    && typeof message.height === "number"
    && Number.isFinite(message.height);
}

function isPrimitiveRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) => item === null || ["string", "number", "boolean"].includes(typeof item),
  );
}

/** SSR/测试环境没有 document，使用 fallback 保持生成结果稳定。 */
function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function buildCanvasDocument(props: UiCanvasProps): string {
  const state = escapeInlineScript(JSON.stringify(props.state ?? {}));
  const script = escapeInlineScript(props.script ?? "");
  const canvasCss = props.css ?? "";
  const theme = {
    background: token("--bg", "#f4f6f5"),
    surface: token("--card-bg", "#ffffff"),
    text: token("--text", "#171c1a"),
    muted: token("--text-secondary", "#57615d"),
    border: token("--border", "#d5ddd9"),
    accent: token("--accent", "#3d7a6e"),
    accentContrast: token("--accent-contrast", "#ffffff"),
    accentSoftBackground: token("--accent-soft-bg", "#d8ebe5"),
    accentSoftForeground: token("--accent-soft-fg", "#2d5f55"),
  };

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'" />
  <style>
    :root {
      color-scheme: light dark;
      --av-bg: ${theme.background};
      --av-surface: ${theme.surface};
      --av-text: ${theme.text};
      --av-muted: ${theme.muted};
      --av-border: ${theme.border};
      --av-accent: ${theme.accent};
      --av-accent-contrast: ${theme.accentContrast};
      --av-accent-soft-bg: ${theme.accentSoftBackground};
      --av-accent-soft-fg: ${theme.accentSoftForeground};
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 0; background: var(--av-bg); color: var(--av-text); }
    body { padding: 16px; overflow-x: hidden; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button, input, select, textarea {
      border: 1px solid var(--av-border);
      border-radius: 8px;
      background: var(--av-surface);
    }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--av-accent); outline-offset: 2px; }
    ${canvasCss}
  </style>
</head>
<body>
  ${props.html}
  <script>
    window.aurevoy = Object.freeze({ state: Object.freeze(${state}) });
    (() => {
      const notifyHeight = () => {
        const height = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );
        parent.postMessage({ type: "aurevoy_ui_resize", height }, "*");
      };
      new ResizeObserver(notifyHeight).observe(document.body);
      window.addEventListener("load", notifyHeight);
      notifyHeight();
    })();
    ${script}
  </script>
</body>
</html>`;
}
