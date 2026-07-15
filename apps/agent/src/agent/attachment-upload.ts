import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { MessageAttachment } from '@aurevoy/shared';

export const MAX_UPLOADED_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** 用户输入不符合图片上传协议时抛出，路由层将其转成可读的 400 响应。 */
export class AttachmentUploadError extends Error {}

/**
 * 将图片 data URL 写入引擎管理目录，并从持久化附件中移除内联二进制。
 *
 * 文件附件仍沿用路径引用；图片则不依赖桌面壳与 Agent 进程能否共享原始文件路径。
 */
export async function materializeUploadedAttachments(
  attachments: MessageAttachment[] | undefined,
  uploadDir: string,
): Promise<MessageAttachment[] | undefined> {
  if (!attachments?.length) return attachments;

  const materialized: MessageAttachment[] = [];
  for (const attachment of attachments) {
    const { dataUrl, ...persisted } = attachment;
    if (attachment.type !== 'image' || !dataUrl) {
      materialized.push(persisted);
      continue;
    }

    const image = decodeImageDataUrl(dataUrl);
    const fileName = normalizeImageFileName(attachment.name, image.mimeType);
    await fs.mkdir(uploadDir, { recursive: true });
    const path = join(uploadDir, `${randomUUID()}-${fileName}`);
    await fs.writeFile(path, image.bytes, { flag: 'wx' });
    materialized.push({
      ...persisted,
      path,
      mimeType: image.mimeType,
      size: image.bytes.length,
      type: 'image',
    });
  }
  return materialized;
}

function decodeImageDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) {
    throw new AttachmentUploadError('图片上传仅支持 PNG、JPEG、GIF 或 WebP 的 base64 data URL');
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, '');
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) {
    throw new AttachmentUploadError('图片 base64 数据无效');
  }
  if (base64.length > Math.ceil(MAX_UPLOADED_IMAGE_BYTES * 4 / 3) + 4) {
    throw new AttachmentUploadError(`图片不能超过 ${MAX_UPLOADED_IMAGE_BYTES / 1024 / 1024}MB`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new AttachmentUploadError('图片内容为空');
  if (bytes.length > MAX_UPLOADED_IMAGE_BYTES) {
    throw new AttachmentUploadError(`图片不能超过 ${MAX_UPLOADED_IMAGE_BYTES / 1024 / 1024}MB`);
  }
  return { mimeType, bytes };
}

function normalizeImageFileName(name: string, mimeType: string): string {
  const extension = IMAGE_EXTENSIONS[mimeType] ?? '.img';
  const source = basename(name || 'image');
  const safe = source.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'image';
  return extname(safe).toLowerCase() === extension ? safe : `${safe}${extension}`;
}
