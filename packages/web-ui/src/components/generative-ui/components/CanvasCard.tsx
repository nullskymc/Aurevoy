import { useEffect, useMemo, useRef, useState } from "react";
import type {
  UiCanvasAction,
  UiCanvasNode,
  UiCanvasPrimitive,
  UiCanvasProps,
} from "@aurevoy/shared";
import type { GenerativeUiComponentProps } from "../registry";

type CanvasState = Record<string, UiCanvasPrimitive>;

export function CanvasCard({
  id,
  data,
  onChoiceSubmit,
}: GenerativeUiComponentProps & { data: UiCanvasProps }) {
  const initialState = useMemo(() => data.state ?? {}, [data.state]);
  const [state, setState] = useState<CanvasState>(initialState);
  const [submittedAction, setSubmittedAction] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // iframe 不共享宿主 DOM，因此监听应用主题并重新生成文档，避免 JS 卡片出现白底割裂。
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !data.html) return;

    // JS UI 只能通过 postMessage 触发结构化事件，不能直接访问宿主窗口。
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.contentWindow || !isCanvasMessage(event.data)) return;
      onChoiceSubmit?.({
        partId: id,
        actionId: event.data.actionId,
        selection: event.data.payload,
      });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [data.html, id, onChoiceSubmit]);

  useEffect(() => {
    // Agent 使用相同 id 更新卡片时，重新以服务端给出的 state 作为交互起点。
    setState(initialState);
    setSubmittedAction(null);
  }, [initialState]);

  function updateState(key: string, value: UiCanvasPrimitive): void {
    setState((previous) => ({ ...previous, [key]: value }));
    setSubmittedAction(null);
  }

  function runAction(action: UiCanvasAction | undefined): void {
    if (!action) return;
    if (action.type === "set" && action.stateKey) {
      updateState(action.stateKey, action.value ?? null);
      return;
    }
    if (action.type === "toggle" && action.stateKey) {
      updateState(action.stateKey, state[action.stateKey] !== true);
      return;
    }
    if (action.type !== "submit" || !onChoiceSubmit) return;

    const actionId = action.id || "submit";
    const selection = action.includeState === false
      ? action.value ?? null
      : { ...state, ...(action.value !== undefined ? { value: action.value } : {}) };
    setSubmittedAction(actionId);
    onChoiceSubmit({ partId: id, actionId, selection });
  }

  if (data.html && data.script) {
    return (
      <section className="gen-ui-card gen-ui-canvas gen-ui-canvas-code" data-mode="javascript">
        {(data.title || data.description) && (
          <header className="gen-ui-canvas-head">
            {data.title && <h3>{data.title}</h3>}
            {data.description && <p>{data.description}</p>}
          </header>
        )}
        <iframe
          ref={frameRef}
          className="gen-ui-canvas-frame"
          title={data.title || "Agent interactive UI"}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          srcDoc={buildCanvasDocument(data, theme)}
        />
      </section>
    );
  }

  return (
    <section className="gen-ui-card gen-ui-canvas">
      {(data.title || data.description) && (
        <header className="gen-ui-canvas-head">
          {data.title && <h3>{renderTemplate(data.title, state)}</h3>}
          {data.description && <p>{renderTemplate(data.description, state)}</p>}
        </header>
      )}
      <div className="gen-ui-canvas-body">
        {(data.body ?? []).map((node, index) => (
          <CanvasNodeView
            key={node.id || `${node.type}-${index}`}
            node={node}
            state={state}
            submittedAction={submittedAction}
            onStateChange={updateState}
            onAction={runAction}
          />
        ))}
      </div>
    </section>
  );
}

interface CanvasNodeViewProps {
  node: UiCanvasNode;
  state: CanvasState;
  submittedAction: string | null;
  onStateChange: (key: string, value: UiCanvasPrimitive) => void;
  onAction: (action: UiCanvasAction | undefined) => void;
}

function CanvasNodeView({
  node,
  state,
  submittedAction,
  onStateChange,
  onAction,
}: CanvasNodeViewProps) {
  if (node.visibleWhen && state[node.visibleWhen.stateKey] !== node.visibleWhen.equals) return null;

  const className = canvasClassName(node);
  const text = renderTemplate(node.text ?? "", state);
  const value = node.stateKey ? state[node.stateKey] ?? node.value ?? "" : node.value ?? "";
  const children = node.children?.map((child, index) => (
    <CanvasNodeView
      key={child.id || `${child.type}-${index}`}
      node={child}
      state={state}
      submittedAction={submittedAction}
      onStateChange={onStateChange}
      onAction={onAction}
    />
  ));

  switch (node.type) {
    case "section":
    case "row":
    case "column":
    case "grid":
      return <div className={className}>{children}</div>;
    case "heading":
      return <h4 className={className}>{text}</h4>;
    case "text":
      return <p className={className}>{text}</p>;
    case "badge":
      return <span className={className}>{text}</span>;
    case "divider":
      return <hr className={className} />;
    case "spacer":
      return <span className={className} aria-hidden="true" />;
    case "progress": {
      const numeric = typeof value === "number" ? value : Number(value);
      const progress = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
      return (
        <div className={className}>
          {node.label && <span>{renderTemplate(node.label, state)}</span>}
          <div className="gen-ui-canvas-progress-track"><i style={{ width: `${progress}%` }} /></div>
          <strong>{progress}%</strong>
        </div>
      );
    }
    case "input":
      return (
        <label className={className}>
          {node.label && <span>{renderTemplate(node.label, state)}</span>}
          <input
            value={String(value)}
            placeholder={node.placeholder}
            onChange={(event) => node.stateKey && onStateChange(node.stateKey, event.currentTarget.value)}
          />
        </label>
      );
    case "textarea":
      return (
        <label className={className}>
          {node.label && <span>{renderTemplate(node.label, state)}</span>}
          <textarea
            value={String(value)}
            placeholder={node.placeholder}
            onChange={(event) => node.stateKey && onStateChange(node.stateKey, event.currentTarget.value)}
          />
        </label>
      );
    case "select":
      return (
        <label className={className}>
          {node.label && <span>{renderTemplate(node.label, state)}</span>}
          <select
            value={String(value)}
            onChange={(event) => node.stateKey && onStateChange(node.stateKey, event.currentTarget.value)}
          >
            {node.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      );
    case "checkbox":
      return (
        <label className={className}>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => node.stateKey && onStateChange(node.stateKey, event.currentTarget.checked)}
          />
          <span>{node.label ? renderTemplate(node.label, state) : text}</span>
        </label>
      );
    case "button": {
      const submitted = node.action?.type === "submit" && submittedAction === (node.action.id || "submit");
      return (
        <button
          type="button"
          className={className}
          disabled={submitted}
          onClick={() => onAction(node.action)}
        >
          {submitted ? "已提交" : text}
        </button>
      );
    }
    default:
      return null;
  }
}

function isCanvasMessage(value: unknown): value is { type: string; actionId: string; payload: unknown } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "aurevoy_ui_action" && typeof record.actionId === "string" && record.actionId.length <= 100 && isJsonValue(record.payload, 0);
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 6 || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.keys(value).length <= 100 && Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}

/** 只把 Agent 提供的代码放进隔离文档；关闭同源访问与外部资源。 */
function buildCanvasDocument(data: UiCanvasProps, theme: "light" | "dark"): string {
  const state = JSON.stringify(data.state ?? {}).replace(/</g, "\\u003c");
  const script = (data.script ?? "").replace(/<\/script/gi, "<\\/script");
  const tokens = theme === "dark"
    ? { bg: "#232325", surface: "#2a2a2e", border: "#3a3a3c", text: "#f2f2f4", secondary: "#a0a0a6", tertiary: "#6e6e74", accent: "#f2f2f4", contrast: "#1c1c1e", input: "#2e2e31", hover: "#323236" }
    : { bg: "#ffffff", surface: "#f8f8f8", border: "#dedee3", text: "#202124", secondary: "#686a70", tertiary: "#9a9ca3", accent: "#1f2328", contrast: "#ffffff", input: "#ffffff", hover: "#f1f1f3" };
  const baseCss = `:root{color-scheme:${theme};--bg:${tokens.bg};--surface:${tokens.surface};--border:${tokens.border};--text:${tokens.text};--text-secondary:${tokens.secondary};--text-tertiary:${tokens.tertiary};--accent:${tokens.accent};--accent-contrast:${tokens.contrast};--input-bg:${tokens.input};--hover:${tokens.hover};--ui-font-size:12.5px}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:var(--ui-font-size);-webkit-font-smoothing:antialiased}body{padding:16px}button,input,textarea,select{font:inherit}button{cursor:pointer}`;
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:;"><style>${baseCss}${data.css ?? ""}</style></head><body>${data.html ?? ""}<script>window.aurevoy={state:Object.freeze(${state}),emit:function(actionId,payload){try{parent.postMessage({type:"aurevoy_ui_action",actionId:actionId,payload:payload},"*")}catch(_error){/* 隔离 iframe 只能使用通配目标源，发送失败不应打断 Agent UI。 */}}};</script><script>${script}</script></body></html>`;
}

/** 模板只读取本地 state，不解析表达式或执行代码。 */
function renderTemplate(template: string, state: CanvasState): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) =>
    String(state[key] ?? ""),
  );
}

function canvasClassName(node: UiCanvasNode): string {
  const style = node.style;
  return [
    "gen-ui-canvas-node",
    `is-${node.type}`,
    style?.tone ? `tone-${style.tone}` : "",
    style?.variant ? `variant-${style.variant}` : "",
    style?.width ? `width-${style.width}` : "",
    style?.columns ? `cols-${style.columns}` : "",
    style?.gap !== undefined ? `gap-${style.gap}` : "",
    style?.padding !== undefined ? `pad-${style.padding}` : "",
    style?.align ? `align-${style.align}` : "",
  ].filter(Boolean).join(" ");
}
