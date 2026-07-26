import { describe, expect, it } from 'vitest';
import { registerEffectTool } from '../../effect-bridge.js';
import { unifiedToolRegistry } from '../../unified-registry.js';
import { attachContentTool, presentUiTool } from './presentation.js';

describe('presentation Effect tools', () => {
  it('keeps content blocks in registry details for harness delivery', async () => {
    registerEffectTool(attachContentTool);
    registerEffectTool(presentUiTool);
    const attach = unifiedToolRegistry.get('attach_content')!;
    const ui = unifiedToolRegistry.get('present_ui')!;
    const context = { taskId: 'test', workspaceDir: '/tmp', callId: 'call' };
    await expect(attach.execute({ type: 'link', content: 'https://example.com', name: 'Example' }, context))
      .resolves.toEqual({ contentBlock: { type: 'link', content: 'https://example.com', name: 'Example', mimeType: undefined, size: undefined } });
    await expect(ui.execute({ kind: 'canvas', props: { html: '<button>Go</button>' }, fallbackText: 'UI' }, context))
      .resolves.toEqual({ contentBlock: expect.objectContaining({ type: 'ui', kind: 'canvas', content: 'UI', fallbackText: 'UI' }) });
  });
});
