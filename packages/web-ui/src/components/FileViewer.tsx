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

export function FileViewer({ tab, taskId, projectId }: FileViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState({ status: "loading" });
      try {
        if (tab.kind === "workspace") {
          const result = await readWorkspaceEntry({ path: tab.path, taskId, projectId, limit: 2000 });
          if (cancelled) return;
          if (result.type === "image") {
            setState({
              status: "image",
              content: result.content,
              mimeType: result.mimeType,
              path: result.path,
            });
          } else if (result.type === "text") {
            setState({
              status: "text",
              content: result.content,
              path: result.path,
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

  return <TextPreview path={state.path} content={state.content} truncated={state.truncated} />;
}

function TextPreview({
  path,
  content,
  truncated,
}: {
  path: string;
  content: string;
  truncated: boolean;
}) {
  const formatted = useMemo(() => formatStructuredText(path, content), [content, path]);
  const isMarkdown = /\.(md|mdx)$/i.test(path);
  return (
    <div className="file-viewer-text">
      {truncated && <div className="file-viewer-truncated">{t("workbench.contentTruncated")}</div>}
      {isMarkdown ? (
        <div className="file-viewer-markdown">
          <MarkdownRenderer content={content} />
        </div>
      ) : (
        <pre className="file-viewer-pre">
          <code>{formatted}</code>
        </pre>
      )}
    </div>
  );
}

function formatStructuredText(path: string, content: string): string {
  if (!/\.(json)$/i.test(path)) return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
