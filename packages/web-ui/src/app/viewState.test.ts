import { describe, expect, it } from 'vitest';
import {
  getMainViewTitle,
  normalizeSettingsSection,
  shouldShowLiveTail,
  shouldShowOutputRail,
} from './viewState';
import { SETTINGS_SECTION_IDS } from './types';

describe('app view state', () => {
  it('keeps live tail for active, approval, and live-tool states', () => {
    expect(shouldShowLiveTail({ busy: true, liveToolCount: 0, phase: null })).toBe(true);
    expect(shouldShowLiveTail({ busy: false, liveToolCount: 0, phase: 'waiting_approval' })).toBe(true);
    expect(shouldShowLiveTail({ busy: false, liveToolCount: 1, phase: 'completed' })).toBe(true);
    expect(shouldShowLiveTail({ busy: false, liveToolCount: 0, phase: 'completed' })).toBe(false);
  });

  it('enforces output rail mutual exclusion with workbench and non-chat views', () => {
    const base = { hasConversation: true, workbenchOpen: false, outputRailOpen: true };
    expect(shouldShowOutputRail({ ...base, activeView: 'chat' })).toBe(true);
    expect(shouldShowOutputRail({ ...base, activeView: 'settings' })).toBe(false);
    expect(shouldShowOutputRail({ ...base, activeView: 'chat', workbenchOpen: true })).toBe(false);
  });

  it('normalizes unknown settings sections and maps titles', () => {
    expect(normalizeSettingsSection('models', SETTINGS_SECTION_IDS)).toBe('models');
    expect(normalizeSettingsSection('unknown', SETTINGS_SECTION_IDS)).toBe('general');
    expect(getMainViewTitle('chat', {
      chat: 'Aurevoy',
      skills: 'Skills',
      automations: 'Automations',
      settings: 'Settings',
    }, 'Task')).toBe('Task');
    expect(getMainViewTitle('skills', {
      chat: 'Aurevoy',
      skills: 'Skills',
      automations: 'Automations',
      settings: 'Settings',
    })).toBe('Skills');
  });
});
