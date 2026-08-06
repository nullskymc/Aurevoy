import { describe, expect, it } from 'vitest';
import { diffMcpToolChanges } from './mcp-tool-diff.js';

describe('diffMcpToolChanges', () => {
  it('reports added, removed, and risk changes after reload', () => {
    expect(diffMcpToolChanges(
      ['read', 'submit'],
      { read: 'safe', submit: 'caution' },
      ['read', 'write'],
      { read: 'dangerous', write: 'caution' },
    )).toEqual({
      added: ['write'],
      removed: ['submit'],
      riskChanged: ['read'],
    });
  });

  it('does not report an initial connection as a reload change', () => {
    expect(diffMcpToolChanges(undefined, undefined, ['read'], { read: 'safe' })).toBeUndefined();
  });
});
