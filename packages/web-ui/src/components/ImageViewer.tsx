import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePlatform } from "../platform/context";
import { IconX } from "../icons";

interface ImageViewerProps {
  /** 图片的本地绝对路径 */
  src: string;
  /** 图片名（alt text） */
  alt?: string;
  /** 关闭回调 */
  onClose: () => void;
}

export function ImageViewer({ src, alt, onClose }: ImageViewerProps) {
  const platform = usePlatform();
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const imgSrc = src.startsWith('data:image/') ? src : (() => {
    try {
      return platform.filePathToUrl(src);
    } catch {
      return null;
    }
  })();

  return createPortal(
    <div className="image-viewer-backdrop" onClick={onClose}>
      <button
        type="button"
        className="image-viewer-close"
        aria-label="Close image viewer"
        onClick={onClose}
      >
        <CloseIcon />
      </button>
      {imgSrc ? (
        <img
          className="image-viewer-img"
          src={imgSrc}
          alt={alt ?? ""}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      ) : (
        <span className="image-viewer-placeholder">
          📷 {alt ?? "无法加载图片"}
        </span>
      )}
    </div>,
    document.body,
  );
}

function CloseIcon() {
  return <IconX size={28} strokeWidth={2} />;
}
