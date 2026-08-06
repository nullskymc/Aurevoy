import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { detectOsIsolation, prepareIsolatedSpawn, type IsolatedSpawnRequest } from './os-isolation.js';

function makeRequest(root: string, requested: 'auto' | 'required' | 'process'): IsolatedSpawnRequest {
  return {
    program: '/bin/sh',
    args: ['-c', 'true'],
    cwd: root,
    workspaceRoot: root,
    externalPaths: [],
    env: { PATH: '/usr/bin:/bin' },
    requested,
  };
}

describe('OS command isolation', () => {
  it('keeps an explicit process mode transparent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aurevoy-isolation-test-'));
    try {
      const plan = await prepareIsolatedSpawn(makeRequest(root, 'process'));
      expect(plan.mode).toBe('process');
      expect(plan.program).toBe('/bin/sh');
      expect(plan.args).toEqual(['-c', 'true']);
      await plan.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the actual platform plan and cleans generated runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aurevoy-isolation-test-'));
    try {
      const status = detectOsIsolation();
      const plan = await prepareIsolatedSpawn(makeRequest(root, 'auto'));
      expect(plan.mode).toBe(status.available ? status.mode : 'process');

      if (plan.mode === 'macos-sandbox-exec') {
        const profilePath = plan.args[1];
        expect(profilePath).toBeTruthy();
        const profile = await readFile(profilePath, 'utf8');
        expect(profile).toContain('(deny default)');
        expect(profile).toContain(`(allow file-write* (subpath "${root}"))`);
        await plan.cleanup();
        await expect(access(profilePath)).rejects.toThrow();
      } else if (plan.mode === 'linux-bubblewrap') {
        expect(plan.program).toMatch(/(?:^|\/)bwrap$/);
        expect(plan.args).toContain('--unshare-pid');
        expect(plan.args).toContain('--ro-bind');
        await plan.cleanup();
      } else if (plan.mode === 'windows-job-object') {
        expect(plan.program.toLowerCase()).toContain('powershell');
        expect(plan.args).toContain('-EncodedCommand');
        await plan.cleanup();
      } else {
        expect(plan.program).toBe('/bin/sh');
        await plan.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when required isolation is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aurevoy-isolation-test-'));
    try {
      const status = detectOsIsolation();
      if (status.available) {
        const plan = await prepareIsolatedSpawn(makeRequest(root, 'required'));
        expect(plan.mode).toBe(status.mode);
        await plan.cleanup();
      } else {
        await expect(
          prepareIsolatedSpawn(makeRequest(root, 'required')),
        ).rejects.toThrow('没有可用的 OS 级命令隔离');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
