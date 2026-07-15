import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentUploadError,
  materializeUploadedAttachments,
} from './attachment-upload.js';

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('uploaded image attachments', () => {
  it('persists image bytes and removes the request-only data URL', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'aurevoy-upload-'));
    temporaryDirs.push(uploadDir);
    const bytes = Buffer.from('image-bytes');
    const [attachment] = await materializeUploadedAttachments([{
      id: 'image-1',
      name: '截图.png',
      path: 'memory://image-1',
      mimeType: 'image/png',
      size: bytes.length,
      type: 'image',
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    }], uploadDir) ?? [];

    expect(attachment.dataUrl).toBeUndefined();
    expect(attachment.path).toMatch(new RegExp(`^${uploadDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(attachment.mimeType).toBe('image/png');
    await expect(readFile(attachment.path)).resolves.toEqual(bytes);
  });

  it('rejects unsupported uploaded image payloads', async () => {
    await expect(materializeUploadedAttachments([{
      id: 'image-1', name: 'image.svg', path: 'memory://image-1', mimeType: 'image/svg+xml', size: 1,
      type: 'image', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
    }], join(tmpdir(), 'unused-aurevoy-upload'))).rejects.toBeInstanceOf(AttachmentUploadError);
  });
});
