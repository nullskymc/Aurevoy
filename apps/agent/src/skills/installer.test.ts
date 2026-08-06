import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { installFromGit, readInstallMetadata, validateRepoUrl } from './installer.js';

describe('skill installer source contract', () => {
  it('only accepts repository protocols that can be inspected by git', () => {
    expect(validateRepoUrl('https://github.com/example/skills.git').valid).toBe(true);
    expect(validateRepoUrl('git@github.com:example/skills.git').valid).toBe(true);
    expect(validateRepoUrl('file:///tmp/skills.git').valid).toBe(false);
    expect(validateRepoUrl('https://example.com/article').valid).toBe(true);
    expect(validateRepoUrl('ftp://example.com/skills.git').valid).toBe(false);
  });

  it('requires an inspected skill path before any remote access', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'aurevoy-skill-target-'));
    await expect(
      installFromGit('https://github.com/example/skills.git', targetDir, {
        requireExpectedPaths: true,
      }),
    ).rejects.toThrow('安装前必须先检查仓库内容');
  });

  it('reads only complete install metadata and ignores malformed content', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'aurevoy-skill-meta-'));
    mkdirSync(join(skillDir, 'nested'), { recursive: true });
    writeFileSync(
      join(skillDir, '.install.json'),
      JSON.stringify({
        repoUrl: 'https://github.com/example/skills.git',
        installedAt: '2026-08-07T00:00:00.000Z',
        inspectedSource: 'https://github.com/example/skills/tree/main/research',
        inspectionSummary: '确认 SKILL.md 与 frontmatter 后安装',
      }),
    );
    expect(readInstallMetadata(skillDir)).toMatchObject({
      repoUrl: 'https://github.com/example/skills.git',
      inspectedSource: 'https://github.com/example/skills/tree/main/research',
    });

    writeFileSync(join(skillDir, '.install.json'), '{"repoUrl":"missing timestamp"}');
    expect(readInstallMetadata(skillDir)).toBeNull();
  });
});
