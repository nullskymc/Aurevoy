import { randomUUID } from 'node:crypto';
import type { MessageAttachment, MessageImagePart } from '@aurevoy/shared';

export const MAX_UPLOADED_IMAGE_BYTES = 5 * 1024 * 1024;

/** 用户输入不符合图片消息协议时抛出，路由层将其转成可读的 400 响应。 */
export class AttachmentUploadError extends Error {}

/**
 * 将 composer 的混合附件拆为普通文件引用和图片消息内容。
 * 图片永不落进工作区，也不会转换成可被 read 工具访问的本地路径。
 */
export function splitIncomingAttachments(
  attachments: MessageAttachment[] | undefined,
): { attachments?: MessageAttachment[]; imageParts?: MessageImagePart[] } {
  if (!attachments?.length) return {};
  const files: MessageAttachment[] = [];
  const imageParts: MessageImagePart[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'image' || attachment.mimeType.startsWith('image/')) {
      const image = decodeImageDataUrl(attachment.dataUrl, attachment.name);
      imageParts.push({
        id: attachment.id || `image-${randomUUID()}`,
        name: attachment.name || 'image',
        mimeType: image.mimeType,
        size: image.bytes,
        dataUrl: image.dataUrl,
      });
      continue;
    }
    if (isClientPlaceholderPath(attachment.path)) {
      throw new AttachmentUploadError(`附件「${attachment.name}」使用了无效的 memory:// 路径，无法作为文件附件发送。`);
    }
    const { dataUrl: _dataUrl, ...file } = attachment;
    files.push(file);
  }
  return {
    attachments: files.length ? files : undefined,
    imageParts: imageParts.length ? imageParts : undefined,
  };
}

function isClientPlaceholderPath(path: string): boolean {
  return path.startsWith('memory://') || path.startsWith('blob:') || path.startsWith('data:');
}

function decodeImageDataUrl(dataUrl: string | undefined, name: string): { mimeType: MessageImagePart['mimeType']; bytes: number; dataUrl: string } {
  if (!dataUrl) throw new AttachmentUploadError(`图片「${name}」缺少图片内容，请重新粘贴或选择后发送。`);
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new AttachmentUploadError('图片仅支持 PNG、JPEG、GIF 或 WebP 的 base64 data URL');
  const payload = match[2].replace(/\s/g, '');
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(payload)) throw new AttachmentUploadError('图片 base64 数据无效');
  const bytes = Buffer.from(payload, 'base64').length;
  if (!bytes) throw new AttachmentUploadError('图片内容为空');
  if (bytes > MAX_UPLOADED_IMAGE_BYTES) throw new AttachmentUploadError(`图片不能超过 ${MAX_UPLOADED_IMAGE_BYTES / 1024 / 1024}MB`);
  return { mimeType: match[1].toLowerCase() as MessageImagePart['mimeType'], bytes, dataUrl: `data:${match[1].toLowerCase()};base64,${payload}` };
}
