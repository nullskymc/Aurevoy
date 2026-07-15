import { describe, expect, it } from 'vitest';
import {
  buildAgentIdentityMessage,
  buildSystemContextMessage,
  buildToolGuidanceMessage,
} from './context.js';

describe('main agent system prompt builders', () => {
  it('identity states product contract without obsolete file tools', () => {
    const msg = buildAgentIdentityMessage();
    expect(msg.role).toBe('system');
    expect(msg.content).toContain('Aurevoy');
    expect(msg.content).toContain('attach_content');
    expect(msg.content).not.toContain('present_ui');
    expect(msg.content).not.toContain('open_file');
    expect(msg.content).not.toContain('write_file');
    expect(msg.content).not.toContain('session_open');
  });

  it('operating protocol covers real tools, delivery, and multi-agent', () => {
    const msg = buildToolGuidanceMessage();
    const text = msg.content;

    expect(text).toContain('<operating_protocol>');
    expect(text).toContain('</operating_protocol>');

    // Current workspace tools
    for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'bash', 'list_directory']) {
      expect(text).toContain(name);
    }

    // Delivery surface
    for (const name of ['attach_content', 'bundle_report', 'report-design']) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('present_ui');
    expect(text).toContain('Inline conversation UI is temporarily unavailable');
    expect(text).not.toContain('data_table');
    expect(text).toContain('report-design` is for long-form file reports');

    // Multi-agent
    expect(text).toContain('delegate');
    for (const role of ['explore', 'research', 'coder', 'shell', 'writer', 'general']) {
      expect(text).toContain(role);
    }

    // Explicitly reject obsolete primitives
    expect(text).toContain('open_file');
    expect(text).toMatch(/Do not invent obsolete tools/);
  });

  it('system context stays cache-friendly at minute precision', () => {
    const msg = buildSystemContextMessage('/tmp/ws');
    expect(msg.content).toContain('<system_context>');
    expect(msg.content).toContain('Workspace: /tmp/ws');
    // ISO timestamp truncated to :00Z (minute precision)
    expect(msg.content).toMatch(/Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z/);
  });
});
