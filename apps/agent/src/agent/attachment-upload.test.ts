import { describe, expect, it } from 'vitest';
import { AttachmentUploadError, splitIncomingAttachments } from './attachment-upload.js';

describe('image message inputs', () => {
  it('keeps image bytes in a message image part instead of materializing a file', () => {
    const bytes = Buffer.from('image-bytes');
    const result = splitIncomingAttachments([{
      id: 'image-1', name: '截图.png', path: 'memory://image-1', mimeType: 'image/png', size: bytes.length,
      type: 'image', dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    }]);
    expect(result.attachments).toBeUndefined();
    expect(result.imageParts).toEqual([expect.objectContaining({
      id: 'image-1', mimeType: 'image/png', size: bytes.length,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    })]);
  });

  it('keeps regular files separate from image message content', () => {
    const result = splitIncomingAttachments([{
      id: 'file-1', name: 'notes.txt', path: '/tmp/notes.txt', mimeType: 'text/plain', size: 3, type: 'file',
    }]);
    expect(result.imageParts).toBeUndefined();
    expect(result.attachments).toEqual([expect.objectContaining({ path: '/tmp/notes.txt' })]);
  });

  it('rejects an image without renderable message content', () => {
    expect(() => splitIncomingAttachments([{
      id: 'image-1', name: 'clipboard.png', path: 'memory://clipboard.png', mimeType: 'image/png', size: 12, type: 'image',
    }])).toThrow(AttachmentUploadError);
  });
});
