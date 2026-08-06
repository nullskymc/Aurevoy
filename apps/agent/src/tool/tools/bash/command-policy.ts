import { isAbsolute, relative, resolve } from 'node:path';
import { assertRealPathInside } from '../../filesystem/workspace-paths.js';

const BLOCKED_SYSTEM_COMMANDS = new Set([
  'chpasswd',
  'diskutil',
  'dscl',
  'doas',
  'defaults',
  'groupadd',
  'groupdel',
  'ifconfig',
  'init',
  'iptables',
  'ip6tables',
  'kill',
  'killall',
  'launchctl',
  'login',
  'mount',
  'networksetup',
  'nmcli',
  'nft',
  'osascript',
  'passwd',
  'pfctl',
  'pkill',
  'pkexec',
  'poweroff',
  'rc-service',
  'reboot',
  'route',
  'scutil',
  'security',
  'service',
  'shutdown',
  'sudo',
  'su',
  'systemctl',
  'systemd-run',
  'taskkill',
  'telinit',
  'umount',
  'useradd',
  'userdel',
  'usermod',
]);

const BLOCKED_DYNAMIC_COMMANDS = new Set([
  '.',
  'command',
  'env',
  'eval',
  'exec',
  'nohup',
  'parallel',
  'setsid',
  'source',
  'xargs',
]);

const NESTED_SHELL_COMMANDS = new Set([
  'bash',
  'cmd',
  'powershell',
  'pwsh',
  'sh',
  'zsh',
]);

const FILE_PATH_COMMANDS = new Set([
  'awk',
  'cat',
  'cd',
  'chmod',
  'chown',
  'cp',
  'find',
  'git',
  'grep',
  'head',
  'less',
  'mkdir',
  'mv',
  'node',
  'npm',
  'python',
  'python3',
  'rg',
  'rm',
  'sed',
  'tail',
  'tar',
  'touch',
  'unzip',
  'zip',
]);

/**
 * 检查 shell 输入中能在 spawn 前确定的路径和系统级逃逸。
 *
 * 这不是操作系统 sandbox：无法替代 macOS seatbelt、Linux namespace 或 Windows Job Object。
 * 它的职责是先拒绝最常见、可静态证明越界的命令，并让剩余平台门有明确接口。
 */
export async function assertShellCommandBoundary(
  command: string,
  cwd: string,
  workspaceRoot: string,
  externalPaths: readonly string[] = [],
): Promise<void> {
  const tokens = tokenizeShellCommand(command);
  const violation = inspectShellCommandTokens(tokens, cwd, workspaceRoot, externalPaths);
  if (violation) throw new Error(`命令边界拒绝：${violation}`);

  for (const candidate of pathCandidates(tokens, cwd)) {
    await assertRealPathInside(candidate, workspaceRoot, externalPaths);
  }
}

/** 供单测和设置页诊断使用的同步静态检查；不做文件系统访问。 */
export function inspectShellCommand(
  command: string,
  cwd: string,
  workspaceRoot: string,
  externalPaths: readonly string[] = [],
): string | null {
  return inspectShellCommandTokens(tokenizeShellCommand(command), cwd, workspaceRoot, externalPaths);
}

interface ShellToken {
  value: string;
  operator: boolean;
}

function inspectShellCommandTokens(
  tokens: ShellToken[],
  cwd: string,
  workspaceRoot: string,
  externalPaths: readonly string[],
): string | null {
  const trimmed = tokens.map((token) => token.value).filter(Boolean);
  if (trimmed.length === 0) return 'command 必须是非空字符串';
  const text = trimmed.join(' ');
  if (/[`]|\$\(|\$\{|\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?@!*#-])/.test(text)) {
    return '不允许命令替换或变量展开；请把脚本放入工作区后直接执行';
  }
  if (/(?:^|[;|&])\s*(?:node|python3?|perl|ruby)\s+(?:-[^\s]*(?:e|c|p)|--(?:eval|print|command))\b/i.test(text)) {
    return '不允许通过解释器内联代码绕过路径边界；请把脚本放入工作区后直接执行';
  }

  let commandPosition = true;
  let currentCommandName = '';
  let previous = '';
  for (const token of tokens) {
    const value = token.value;
    if (!value) continue;
    if (token.operator) {
      const isRedirect = value === '>' || value === '<';
      commandPosition = !isRedirect;
      if (commandPosition) currentCommandName = '';
      previous = value;
      continue;
    }
    if (commandPosition) {
      currentCommandName = value.split('/').pop()?.toLowerCase() ?? value.toLowerCase();
      if (BLOCKED_SYSTEM_COMMANDS.has(currentCommandName)) {
        return `禁止系统级命令 ${currentCommandName}`;
      }
      if (NESTED_SHELL_COMMANDS.has(currentCommandName)) {
        return `不允许嵌套 shell ${currentCommandName}；请把脚本放入工作区后直接执行`;
      }
      if (BLOCKED_DYNAMIC_COMMANDS.has(currentCommandName)) {
        return `不允许通过 ${currentCommandName} 动态引入或转发命令`;
      }
      commandPosition = false;
    }
    if (currentCommandName === 'find' && (value === '-exec' || value === '-execdir')) {
      return '不允许 find -exec 动态启动子命令';
    }
    if (isAbsolute(value) || value.startsWith('~')) {
      if (!isAllowedPath(value, cwd, workspaceRoot, externalPaths)) {
        return `路径越界：${value}`;
      }
    }
    if (value === '..' || value.startsWith('../') || value.startsWith('..\\')) {
      const target = resolve(cwd, value);
      if (!isAllowedPath(target, cwd, workspaceRoot, externalPaths)) {
        return `路径越界：${value}`;
      }
    }
    if (previous === '>' || previous === '>>' || previous === '<' || previous === '<<') {
      if (!isAllowedPath(value, cwd, workspaceRoot, externalPaths)) {
        return `重定向目标越界：${value}`;
      }
    }
    if (previous === '-C' || previous === '--directory') {
      const target = resolve(cwd, value);
      if (!isAllowedPath(target, cwd, workspaceRoot, externalPaths)) {
        return `工作目录越界：${value}`;
      }
    }
    previous = value;
  }
  return null;
}

function pathCandidates(tokens: ShellToken[], cwd: string): string[] {
  const candidates: string[] = [];
  let commandName = '';
  let previous = '';
  for (const token of tokens) {
    if (token.operator) {
      // 新命令段必须重新识别命令名；否则 `echo ok; cat link/file`
      // 会沿用前一个命令，漏掉后半段的符号链接真实路径检查。
      if (token.value !== '>' && token.value !== '<') commandName = '';
      previous = token.value;
      continue;
    }
    const value = token.value;
    if (!commandName) {
      commandName = value.split('/').pop()?.toLowerCase() ?? value.toLowerCase();
      previous = value;
      continue;
    }
    const isExplicitPath = isAbsolute(value) || value.startsWith('.') || value.startsWith('~');
    const isKnownPathCommand = FILE_PATH_COMMANDS.has(commandName) && !value.startsWith('-');
    const isDirectoryFlag = previous === '-C' || previous === '--directory';
    const isRedirectTarget = previous === '>' || previous === '>>' || previous === '<' || previous === '<<';
    if (isExplicitPath || isKnownPathCommand || isDirectoryFlag || isRedirectTarget) {
      if (value.startsWith('~')) continue;
      candidates.push(isAbsolute(value) ? value : resolve(cwd, value));
    }
    previous = value;
  }
  return candidates;
}

function isAllowedPath(
  candidate: string,
  cwd: string,
  workspaceRoot: string,
  externalPaths: readonly string[],
): boolean {
  if (candidate.startsWith('~')) return false;
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const roots = [workspaceRoot, ...externalPaths].map((root) => resolve(root));
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  const push = () => {
    if (current) tokens.push({ value: current, operator: false });
    current = '';
  };
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (';|&<>'.includes(char)) {
      push();
      tokens.push({ value: char, operator: true });
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  push();
  return tokens;
}
