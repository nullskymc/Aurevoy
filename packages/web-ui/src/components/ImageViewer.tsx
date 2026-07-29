import * as Dialog from "@radix-ui/react-dialog";
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

  const imgSrc = src.startsWith('data:image/') ? src : (() => {
    try {
      return platform.filePathToUrl(src);
    } catch {
      return null;
    }
  })();

  return (
    <Dialog.Root open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="image-viewer-backdrop" />
        <Dialog.Content className="image-viewer-content" aria-describedby={undefined}>
          <Dialog.Title className="image-viewer-title">{alt ?? "Image viewer"}</Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className="image-viewer-close" aria-label="Close image viewer">
              <CloseIcon />
            </button>
          </Dialog.Close>
          {imgSrc ? (
            <img
              className="image-viewer-img"
              src={imgSrc}
              alt={alt ?? ""}
              draggable={false}
            />
          ) : (
            <span className="image-viewer-placeholder">
              📷 {alt ?? "无法加载图片"}
            </span>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CloseIcon() {
  return <IconX size={28} strokeWidth={2} />;
}
