import { describe, expect, it } from 'vitest';
import { buildWindowsCreateProcessCommandLine, buildPowerShellArgs } from './windows-job-object.js';

describe('Windows Job Object bridge', () => {
  it('preserves cmd.exe shell text after /c', () => {
    const commandLine = buildWindowsCreateProcessCommandLine(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'echo "quoted" & echo done'],
    );
    expect(commandLine).toBe('C:\\Windows\\System32\\cmd.exe /d /s /c echo "quoted" & echo done');
  });

  it('quotes non-shell executable arguments for CreateProcess', () => {
    const commandLine = buildWindowsCreateProcessCommandLine(
      'C:\\Program Files\\Aurevoy\\tool.exe',
      ['--output', 'C:\\Users\\Test User\\out.txt'],
    );
    expect(commandLine).toBe('"C:\\Program Files\\Aurevoy\\tool.exe" --output "C:\\Users\\Test User\\out.txt"');
  });

  it('keeps the PowerShell bridge payload encoded', () => {
    const args = buildPowerShellArgs({
      program: 'cmd.exe',
      args: ['/d', '/s', '/c', 'echo safe & echo "not powershell"'],
      cwd: 'C:\\workspace',
    });
    const encodedScript = args.at(-1);
    expect(encodedScript).toBeTruthy();
    expect(encodedScript).not.toContain('echo safe');
    expect(args).toContain('-EncodedCommand');
  });
});
