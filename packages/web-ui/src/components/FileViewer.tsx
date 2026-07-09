import { useEffect, useMemo, useState } from "react";
import { getArtifactContent, readWorkspaceEntry } from "../api";
import type { WorkbenchTab } from "../hooks/useWorkbenchTabs";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { t } from "../i18n";

interface FileViewerProps {
  tab: WorkbenchTab;
  taskId?: string;
  projectId?: string;
}

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; content: string; path: string; truncated: boolean }
  | { status: "image"; content: string; mimeType: string; path: string };

export function isWorkbenchPreviewablePath(path: string): boolean {
  return /\.(md|mdx|html?|htm|json|txt|csv|tsv|log|ya?ml|xml|svg)$/i.test(path);
}

export function FileViewer({ tab, taskId, projectId }: FileViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setShowSource(false);
    async function load() {
      setState({ status: "loading" });
      try {
        if (tab.kind === "workspace") {
          // full=1：工作台全量读，避免 agent read 工具 50KB/2000 行分页导致 HTML/MD 预览残缺
          // 展示路径始终用 tab.path，不改写定位身份
          const result = await readWorkspaceEntry({
            path: tab.path,
            taskId,
            projectId,
            full: true,
          });
          if (cancelled) return;
          if (result.type === "image") {
            setState({
              status: "image",
              content: result.content,
              mimeType: result.mimeType,
              path: tab.path,
            });
          } else if (result.type === "text") {
            setState({
              status: "text",
              content: result.content,
              path: tab.path,
              truncated: result.truncated,
            });
          } else {
            setState({ status: "error", message: t("workbench.directoryPreviewUnsupported") });
          }
          return;
        }

        const artifact = await getArtifactContent(tab.taskId, tab.artifactId);
        if (cancelled) return;
        setState({
          status: "text",
          content: artifact.content,
          path: tab.name,
          truncated: false,
        });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, tab, taskId]);

  if (state.status === "loading") {
    return <div className="file-viewer-state">{t("workbench.loading")}</div>;
  }

  if (state.status === "error") {
    return <div className="file-viewer-state file-viewer-error">{state.message}</div>;
  }

  if (state.status === "image") {
    return (
      <div className="file-viewer-image-wrap">
        <img
          className="file-viewer-image"
          src={`data:${state.mimeType};base64,${state.content}`}
          alt={state.path}
        />
      </div>
    );
  }

  return (
    <TextPreview
      path={state.path}
      content={state.content}
      truncated={state.truncated}
      showSource={showSource}
      onToggleSource={() => setShowSource((v) => !v)}
    />
  );
}

function TextPreview({
  path,
  content,
  truncated,
  showSource,
  onToggleSource,
}: {
  path: string;
  content: string;
  truncated: boolean;
  showSource: boolean;
  onToggleSource: () => void;
}) {
  const mode = useMemo(() => detectPreviewMode(path, content), [path, content]);
  const formatted = useMemo(() => formatStructuredText(path, content), [content, path]);
  const canToggleSource = mode === "markdown" || mode === "html";
  const isRenderMode = canToggleSource && !showSource;
  // 截断提示仅在源码/纯文本视图显示，预览渲染模式不打扰阅读
  const showTruncatedHint = truncated && !isRenderMode;

  return (
    <div className="file-viewer-text" data-mode={mode} data-has-mode-toggle={canToggleSource || undefined}>
      {/* 源码/预览切换：右上角悬浮，不单独占一行 */}
      {canToggleSource && (
        <button
          type="button"
          className="file-viewer-mode-fab"
          onClick={onToggleSource}
          title={showSource ? t("workbench.showPreview") : t("workbench.showSource")}
          aria-label={showSource ? t("workbench.showPreview") : t("workbench.showSource")}
        >
          {showSource ? t("workbench.showPreview") : t("workbench.showSource")}
        </button>
      )}
      {showTruncatedHint && (
        <div className="file-viewer-truncated-float" role="status">
          {t("workbench.contentTruncated")}
        </div>
      )}
      {isRenderMode && mode === "markdown" ? (
        <div className="file-viewer-markdown">
          <MarkdownRenderer content={content} />
        </div>
      ) : isRenderMode && mode === "html" ? (
        <iframe
          className="file-viewer-html-frame"
          title={path}
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          srcDoc={content}
          referrerPolicy="no-referrer"
        />
      ) : (
        <pre className="file-viewer-pre">
          <code>{formatted}</code>
        </pre>
      )}
    </div>
  );
}

function detectPreviewMode(path: string, content: string): "markdown" | "html" | "text" {
  if (/\.(md|mdx)$/i.test(path)) return "markdown";
  if (/\.(html?|htm)$/i.test(path)) return "html";
  // 无扩展名时按内容猜 HTML（report 偶发）
  const head = content.slice(0, 256).toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) return "html";
  return "text";
}

function formatStructuredText(path: string, content: string): string {
  if (!/\.(json)$/i.test(path)) return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
