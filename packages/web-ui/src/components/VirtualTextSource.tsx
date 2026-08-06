import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";

export const VIRTUAL_TEXT_LINE_THRESHOLD = 2_000;

export function shouldVirtualizeText(content: string): boolean {
  return content.split("\n").length > VIRTUAL_TEXT_LINE_THRESHOLD;
}

/**
 * 大文件源码只挂载视口附近的行，保留原有等宽字体、横向滚动和源码内容。
 * Markdown/HTML 的预览模式仍由上层渲染，不把不可信 HTML 交给这里的源码列表。
 */
export function VirtualTextSource({ content, label }: { content: string; label: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => `line:${index}`,
    estimateSize: () => 22,
    overscan: 16,
    initialRect: { width: 800, height: 600 },
    useAnimationFrameWithResizeObserver: true,
  });

  return (
    <div
      ref={scrollRef}
      className="file-viewer-pre file-viewer-pre-virtual"
      role="region"
      aria-label={label}
      data-virtualized="true"
    >
      <div
        className="file-viewer-code-canvas"
        style={{ height: `${virtualizer.getTotalSize() + 28}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualLine) => (
          <div
            key={virtualLine.key}
            ref={virtualizer.measureElement}
            className="file-viewer-code-line"
            data-line-index={virtualLine.index}
            style={{ transform: `translateY(${virtualLine.start + 14}px)` }}
          >
            <code>{lines[virtualLine.index]}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
