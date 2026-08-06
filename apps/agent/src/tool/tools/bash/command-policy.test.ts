import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assertShellCommandBoundary, inspectShellCommand } from './command-policy.js';

describe('shell command boundary', () => {
  it('rejects absolute and traversal paths before spawning a shell', () => {
    const root = join('/tmp', 'aurevoy-shell-root');
    expect(inspectShellCommand('cat /etc/hosts', root, root)).toContain('路径越界');
    expect(inspectShellCommand('cd ../outside', root, root)).toContain('路径越界');
    expect(inspectShellCommand('echo $(cat /etc/passwd)', root, root)).toContain('命令替换');
    expect(inspectShellCommand('sudo rm -rf .', root, root)).toContain('系统级命令');
  });

  it('rejects interpreter inline code and allows ordinary workspace commands', () => {
    const root = join('/tmp', 'aurevoy-shell-root');
    expect(inspectShellCommand('node -e console.log("secret")', root, root)).toContain('内联代码');
    expect(inspectShellCommand('python --eval print(1)', root, root)).toContain('内联代码');
    expect(inspectShellCommand('echo $HOME', root, root)).toContain('变量展开');
    expect(inspectShellCommand('. ./setup.sh', root, root)).toContain('动态引入');
    expect(inspectShellCommand('find . -exec cat notes.md \\;', root, root)).toContain('find -exec');
    expect(inspectShellCommand('cmd /c whoami', root, root)).toContain('嵌套 shell');
    expect(inspectShellCommand('powershell -Command Get-Date', root, root)).toContain('嵌套 shell');
    expect(inspectShellCommand('diskutil list', root, root)).toContain('系统级命令');
    expect(inspectShellCommand('kill 1234', root, root)).toContain('系统级命令');
    expect(inspectShellCommand('npm test', root, root)).toBeNull();
    expect(inspectShellCommand('git -C . status', root, root)).toBeNull();
  });

  it('resolves existing symlinks before allowing file command paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aurevoy-shell-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'aurevoy-shell-outside-'));
    await mkdir(join(root, 'links'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'links', 'outside'));

    await expect(
      assertShellCommandBoundary('cat links/outside/secret.txt', root, root),
    ).rejects.toThrow('路径越界');

    await expect(
      assertShellCommandBoundary('echo ok; cat links/outside/secret.txt', root, root),
    ).rejects.toThrow('路径越界');

    await expect(
      assertShellCommandBoundary('echo ok > links/outside/output.txt', root, root),
    ).rejects.toThrow('路径越界');
  });
});
