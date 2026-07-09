import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBAGENT_ROLE,
  formatSubagentRoleCatalogForTool,
  getSubagentProfile,
  isSubagentRole,
  listSubagentProfiles,
  resolveSubagentTools,
} from './subagent-profiles.js';

describe('subagent profiles', () => {
  it('defines six roles with non-empty tool surfaces', () => {
    const profiles = listSubagentProfiles();
    expect(profiles.map((p) => p.role).sort()).toEqual(
      ['coder', 'explore', 'general', 'research', 'shell', 'writer'].sort(),
    );
    for (const profile of profiles) {
      expect(profile.tools.length).toBeGreaterThan(0);
      expect(profile.timeoutMs).toBeGreaterThan(0);
      expect(profile.systemPromptAddon.length).toBeGreaterThan(0);
    }
  });

  it('defaults to general with a broad surface', () => {
    expect(DEFAULT_SUBAGENT_ROLE).toBe('general');
    const general = getSubagentProfile();
    expect(general.tools).toContain('read');
    expect(general.tools).toContain('write');
    expect(general.tools).toContain('bash');
    expect(general.tools).toContain('web_search');
    expect(general.tools).not.toContain('delegate_task');
    expect(general.tools).not.toContain('delegate');
  });

  it('keeps explore readonly (no write/bash)', () => {
    const explore = getSubagentProfile('explore');
    expect(explore.tools).toContain('read');
    expect(explore.tools).toContain('grep');
    expect(explore.tools).not.toContain('write');
    expect(explore.tools).not.toContain('bash');
  });

  it('resolveSubagentTools blocks nested delegate tools even if explicit', () => {
    const tools = resolveSubagentTools('explore', ['read', 'delegate_task', 'delegate', 'ask_user', 'write']);
    expect(tools).toEqual(['read', 'write']);
  });

  it('uses role defaults when tools omitted', () => {
    const tools = resolveSubagentTools('research');
    expect(tools).toContain('web_search');
    expect(tools).toContain('web_fetch');
    expect(tools).toContain('read');
  });

  it('isSubagentRole validates ids', () => {
    expect(isSubagentRole('coder')).toBe(true);
    expect(isSubagentRole('nope')).toBe(false);
    expect(isSubagentRole(1)).toBe(false);
  });

  it('formats catalog for tool description', () => {
    const catalog = formatSubagentRoleCatalogForTool();
    expect(catalog).toContain('explore');
    expect(catalog).toContain('general');
  });
});
