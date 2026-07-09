import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { MessageAttachment, Project } from "@aurevoy/shared";
import { createProject } from "../api";
import type { PlatformAdapter } from "../platform/types";

function makeAttachment(
  path: string,
  meta: { name: string; mimeType: string; size: number },
): MessageAttachment {
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: meta.name,
    path,
    mimeType: meta.mimeType,
    size: meta.size,
    type: meta.mimeType.startsWith("image/") ? "image" : "file",
  };
}

export function useAttachments({
  platform,
  setNotice,
  setProjects,
}: {
  platform: PlatformAdapter;
  setNotice: (message: string | null) => void;
  setProjects: Dispatch<SetStateAction<Project[]>>;
}) {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);

  function appendAttachment(path: string, meta: { name: string; mimeType: string; size: number }): void {
    setAttachments((prev) => {
      if (prev.some((a) => a.path === path)) return prev;
      return [...prev, makeAttachment(path, meta)];
    });
  }

  async function handleImportProjectPath(dirPath: string): Promise<void> {
    try {
      const project = await createProject({ path: dirPath });
      setProjects((prev) => [...prev, project]);
      setNotice(`已导入项目: ${project.name}`);
    } catch (err) {
      setNotice(`导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    const unlistenDrop = platform.onFileDrop?.((paths) => {
      if (!paths || paths.length === 0) return;
      void (async () => {
        for (const p of paths) {
          try {
            const meta = platform.getFileMetadata ? await platform.getFileMetadata(p) : null;
            if (!meta) continue;
            if (meta.isDir) {
              void handleImportProjectPath(p);
            } else {
              appendAttachment(p, meta);
            }
          } catch {
            setNotice(`无法读取文件信息: ${p}`);
          }
        }
      })();
    });
    return () => {
      unlistenDrop?.();
    };
  }, [platform]);

  async function handlePickAttachments(): Promise<void> {
    if (!platform.openFileDialog) return;
    try {
      const selected = await platform.openFileDialog({ multiple: true });
      if (!selected || selected.length === 0) return;
      for (const p of selected) {
        try {
          const meta = platform.getFileMetadata ? await platform.getFileMetadata(p) : null;
          if (!meta || meta.isDir) continue;
          appendAttachment(p, meta);
        } catch {
          setNotice(`无法读取文件信息: ${p}`);
        }
      }
    } catch (err) {
      setNotice(`选择文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handlePasteFiles(files: Array<{ name: string; dataUrl: string; mimeType: string }>): Promise<void> {
    for (const f of files) {
      try {
        const path = platform.saveTempFile ? await platform.saveTempFile(f.name, f.dataUrl) : f.dataUrl;
        appendAttachment(path, {
          name: f.name,
          mimeType: f.mimeType,
          size: f.dataUrl.length,
        });
      } catch (err) {
        setNotice(`粘贴图片失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    attachments,
    handlePickAttachments,
    handlePasteFiles,
    setAttachments,
  };
}
