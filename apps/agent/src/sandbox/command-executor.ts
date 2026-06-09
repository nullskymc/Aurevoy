import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';

export interface CommandExecutionPolicy {
  enabled: boolean;
  workspaceDir: string;
  timeoutMs: number;
  outputLimitBytes: number;
  envAllowlist: string[];
  isolation: 'disabled' | 'process' | 'container';
}

export interface CommandExecutionRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface CommandExecutor {
  readonly policy: CommandExecutionPolicy;
  execute(request: CommandExecutionRequest, signal?: AbortSignal): Promise<CommandExecutionResult>;
}

export function createCommandExecutionPolicy(): CommandExecutionPolicy {
  return {
    enabled: config.sandbox.commandExecutionEnabled,
    workspaceDir: resolve(config.workspaceDir),
    timeoutMs: config.sandbox.commandTimeoutMs,
    outputLimitBytes: config.sandbox.commandOutputLimitBytes,
    envAllowlist: config.sandbox.commandEnvAllowlist,
    isolation: config.sandbox.commandExecutionEnabled ? 'process' : 'disabled',
  };
}

/**
 * 默认执行器只暴露权限边界，不执行任何命令。
 * 未来接入真实执行能力时，必须替换为隔离实现并接入审批/轨迹/回归。
 */
export class DisabledCommandExecutor implements CommandExecutor {
  get policy(): CommandExecutionPolicy {
    return createCommandExecutionPolicy();
  }

  async execute(): Promise<CommandExecutionResult> {
    throw new Error('命令执行默认关闭。需通过设置显式启用，并接入审批、轨迹、超时和输出上限后才能使用。');
  }
}

export class ProcessCommandExecutor implements CommandExecutor {
  get policy(): CommandExecutionPolicy {
    return createCommandExecutionPolicy();
  }

  async execute(
    request: CommandExecutionRequest,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult> {
    const policy = this.policy;
    if (!policy.enabled) {
      throw new Error('命令执行默认关闭。请先在设置页启用基础命令执行。');
    }
    if (!request.command.trim()) throw new Error('command 必须是非空字符串');
    const cwd = resolveCommandCwd(request.cwd, policy.workspaceDir);
    const env = buildAllowedEnv(request.env, policy.envAllowlist);

    return new Promise<CommandExecutionResult>((resolveResult, reject) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const child = spawn(request.command, request.args ?? [], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, policy.timeoutMs);

      const finish = (result: CommandExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolveResult(result);
      };

      const onAbort = () => {
        child.kill('SIGTERM');
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        const captured = appendLimited(stdout, chunk, policy.outputLimitBytes);
        stdout = captured.text;
        truncated ||= captured.truncated;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const captured = appendLimited(stderr, chunk, policy.outputLimitBytes);
        stderr = captured.text;
        truncated ||= captured.truncated;
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('close', (exitCode) => {
        finish({
          exitCode,
          stdout,
          stderr,
          timedOut,
          truncated,
        });
      });
    });
  }
}

export const commandExecutor: CommandExecutor = new ProcessCommandExecutor();

function resolveCommandCwd(input: string | undefined, workspaceDir: string): string {
  const root = resolve(workspaceDir);
  const cwd = resolve(root, input ?? '.');
  if (cwd !== root && !cwd.startsWith(`${root}/`)) {
    throw new Error(`cwd 越界：只允许在工作区内执行 (${root})`);
  }
  return cwd;
}

function buildAllowedEnv(
  extraEnv: Record<string, string> | undefined,
  allowlist: string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (allowlist.includes(key)) env[key] = value;
  }
  return env;
}

function appendLimited(
  current: string,
  chunk: Buffer,
  limitBytes: number,
): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= limitBytes) return { text: current, truncated: true };
  const remaining = limitBytes - currentBytes;
  if (chunk.byteLength <= remaining) return { text: current + chunk.toString('utf8'), truncated: false };
  return { text: current + chunk.subarray(0, remaining).toString('utf8'), truncated: true };
}
