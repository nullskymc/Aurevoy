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
  readonly policy = createCommandExecutionPolicy();

  async execute(): Promise<CommandExecutionResult> {
    throw new Error('命令执行默认关闭。需通过设置显式启用，并接入审批、轨迹、超时和输出上限后才能使用。');
  }
}

export const commandExecutor: CommandExecutor = new DisabledCommandExecutor();
