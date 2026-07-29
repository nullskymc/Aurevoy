import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFileTool, deleteFileTool, moveFileTool } from './workspace.js';

const context = (workspaceDir: string) => ({ sessionID: 'test', taskID: 'test', agent: 'test', assistantMessageID: '', toolCallID: 'call', workspaceDir, externalPaths: [] });

describe('workspace Effect tools', () => {
  it('refuses overwrite by default, permits explicit overwrite, and recycles files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aurevoy-workspace-'));
    await writeFile(join(root, 'source.txt'), 'source');
    await writeFile(join(root, 'target.txt'), 'target');
    const copy = copyFileTool.runtime();
    await expect(copy.settle({ sourcePath: 'source.txt', targetPath: 'target.txt' }, context(root))).rejects.toThrow('已存在');
    await expect(copy.settle({ sourcePath: 'source.txt', targetPath: 'target.txt', overwrite: true }, context(root))).resolves.toMatchObject({ output: { bytesCopied: 6 } });
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('source');
    const deleted = await deleteFileTool.runtime().settle({ path: 'target.txt' }, context(root));
    expect((deleted.output as { trashedPath: string }).trashedPath).toMatch(/^\.aurevoy-trash\//);
  });

  it('rejects traversal and symlink escapes while allowing an explicitly trusted external path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aurevoy-workspace-'));
    const external = await mkdtemp(join(tmpdir(), 'aurevoy-external-'));
    await writeFile(join(root, 'source.txt'), 'source');
    await writeFile(join(external, 'external.txt'), 'external');
    await mkdir(join(root, 'nested'));
    await symlink(external, join(root, 'nested', 'escape'));
    const move = moveFileTool.runtime();
    await expect(move.settle({ sourcePath: '../outside.txt', targetPath: 'x.txt' }, context(root))).rejects.toThrow('路径越界');
    await expect(move.settle({ sourcePath: 'nested/escape/external.txt', targetPath: 'x.txt' }, context(root))).rejects.toThrow('符号链接');
    await expect(move.settle({ sourcePath: 'source.txt', targetPath: `${external}/moved.txt` }, { ...context(root), externalPaths: [external] })).resolves.toMatchObject({ output: { bytesMoved: 6 } });
  });
});
