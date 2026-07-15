import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { MessageAttachment, Project } from "@aurevoy/shared";
import { createProject } from "../api";
import type { PlatformAdapter } from "../platform/types";

function makeAttachment(
  path: string,
  meta: { name: string; mimeType: string; size: number },
  dataUrl?: string,
): MessageAttachment {
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: meta.name,
    path,
    mimeType: meta.mimeType,
    size: meta.size,
    type: meta.mimeType.startsWith("image/") ? "image" : "file",
    dataUrl,
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

  function appendAttachment(
    path: string,
    meta: { name: string; mimeType: string; size: number },
    dataUrl?: string,
  ): void {
    setAttachments((prev) => {
      if (prev.some((a) => a.path === path || (dataUrl && a.dataUrl === dataUrl))) return prev;
      return [...prev, makeAttachment(path, meta, dataUrl)];
    });
  }

  /** 选择/拖入图片时先读取真实字节，避免把仅 Agent 可见的本地路径当作上传内容。 */
  async function appendLocalAttachment(path: string, meta: { name: string; mimeType: string; size: number }): Promise<void> {
    if (!meta.mimeType.startsWith('image/')) {
      appendAttachment(path, meta);
      return;
    }
    if (!platform.readImageDataUrl) {
      throw new Error('当前平台不支持读取图片内容，无法上传图片附件');
    }
    const dataUrl = await platform.readImageDataUrl(path);
    appendAttachment(path, meta, dataUrl);
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
              await appendLocalAttachment(p, meta);
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
          // 网页 object URL / 桌面绝对路径：图片必须带 dataUrl 才能上传到引擎
          if (meta.mimeType.startsWith('image/')) {
            await appendLocalAttachment(p, meta);
          } else {
            appendAttachment(p, meta);
          }
        } catch (err) {
          setNotice(`无法读取文件: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      setNotice(`选择文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handlePasteFiles(files: Array<{ name: string; dataUrl: string; mimeType: string }>): Promise<void> {
    for (const f of files) {
      try {
        if (!f.dataUrl?.startsWith('data:image/')) {
          setNotice(`图片「${f.name}」内容无效，请重新粘贴或选择`);
          continue;
        }
        if (!f.mimeType.startsWith('image/')) {
          setNotice(`暂不支持附件类型: ${f.mimeType || 'unknown'}`);
          continue;
        }
        // memory:// 仅前端占位；发送时必须带 dataUrl，由引擎落盘
        appendAttachment(`memory://${Date.now()}-${f.name}`, {
          name: f.name,
          mimeType: f.mimeType,
          size: dataUrlByteLength(f.dataUrl),
        }, f.dataUrl);
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

function dataUrlByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, '');
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}
