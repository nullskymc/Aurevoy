import { accessSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface WindowsJobObjectStatus {
  available: boolean;
  reason: string;
  powershellPath?: string;
}

export interface WindowsJobObjectRequest {
  program: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WindowsJobObjectPlan {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

const PROBE_COMMAND = {
  program: process.env.ComSpec ?? 'cmd.exe',
  args: ['/d', '/s', '/c', 'exit 0'],
  cwd: process.cwd(),
};

let cachedStatus: WindowsJobObjectStatus | undefined;

/**
 * 检查 Windows PowerShell 和 Job Object API 是否可用。
 *
 * 探测只启动固定的 `cmd /c exit 0`，不会执行用户输入；真正的用户命令
 * 仍由 prepareWindowsJobObjectSpawn 以独立 job 启动。
 */
export function detectWindowsJobObject(): WindowsJobObjectStatus {
  if (process.platform !== 'win32') {
    return { available: false, reason: '当前平台不是 Windows' };
  }
  if (cachedStatus) return cachedStatus;

  const powershellPath = findWindowsPowerShell();
  if (!powershellPath) {
    cachedStatus = {
      available: false,
      reason: '未找到 Windows PowerShell，无法创建 Job Object',
    };
    return cachedStatus;
  }

  const result = spawnSync(
    powershellPath,
    buildPowerShellArgs(PROBE_COMMAND),
    {
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    },
  );
  cachedStatus = result.status === 0 && !result.error
    ? { available: true, reason: powershellPath, powershellPath }
    : {
        available: false,
        reason: `Windows Job Object 探测失败：${result.error?.message ?? `exit=${result.status ?? 'unknown'}`}`,
        powershellPath,
      };
  return cachedStatus;
}

/** 为已审批的 shell/可执行文件创建 Windows Job Object 启动计划。 */
export function prepareWindowsJobObjectSpawn(
  request: WindowsJobObjectRequest,
): WindowsJobObjectPlan {
  const powershellPath = findWindowsPowerShell();
  if (!powershellPath) {
    throw new Error('未找到 Windows PowerShell，无法创建 Job Object');
  }
  return {
    program: powershellPath,
    args: buildPowerShellArgs(request),
    env: request.env,
    cleanup: async () => {},
  };
}

/**
 * 生成 PowerShell 参数。脚本本身是固定内容，用户命令只放在 base64 JSON
 * payload 中，避免把命令拼进 PowerShell 源码或额外解释一层。
 */
export function buildPowerShellArgs(request: {
  program: string;
  args: readonly string[];
  cwd: string;
}): string[] {
  const payload = Buffer.from(JSON.stringify({
    commandLine: buildWindowsCreateProcessCommandLine(request.program, request.args),
    workingDirectory: request.cwd,
  }), 'utf8').toString('base64');
  const script = WINDOWS_JOB_OBJECT_SCRIPT.replace('__AUREVOY_PAYLOAD__', payload);
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

/**
 * CreateProcess 接收一条完整命令行，而不是 Node 的 argv 数组。
 * cmd.exe 的 `/c` 后必须保留原始 shell 文本，否则引号、管道和重定向
 * 会被 CreateProcess 的通用 argv 引号规则改变。
 */
export function buildWindowsCreateProcessCommandLine(
  program: string,
  args: readonly string[],
): string {
  // 在 macOS/Linux 的单元测试里也要正确识别 Windows 路径分隔符。
  const executableName = program.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const isCmdShell = (executableName === 'cmd.exe' || executableName === 'cmd')
    && args.length >= 4
    && args[2]?.toLowerCase() === '/c';
  if (isCmdShell) {
    const prefix = [quoteWindowsArg(program), args[0], args[1], args[2]].join(' ');
    return `${prefix} ${args.slice(3).join(' ')}`;
  }
  return [quoteWindowsArg(program), ...args.map(quoteWindowsArg)].join(' ');
}

function findWindowsPowerShell(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const path = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      accessSync(path);
      return path;
    } catch {
      // 继续尝试 PATH 中的 powershell.exe。
    }
  }
  return 'powershell.exe';
}

/** Windows argv 引号规则；只有非 cmd shell 参数才使用该通用路径。 */
function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let output = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += '\\'.repeat(backslashes * 2 + 1);
      output += '"';
      backslashes = 0;
      continue;
    }
    output += '\\'.repeat(backslashes);
    output += character;
    backslashes = 0;
  }
  output += '\\'.repeat(backslashes * 2);
  return `${output}"`;
}

/**
 * PowerShell 中的固定 C# bridge：
 * 1. 创建 KILL_ON_JOB_CLOSE Job Object；
 * 2. 以 suspended 状态创建用户进程并加入 job；
 * 3. 恢复并等待用户进程；
 * 4. PowerShell 被父进程终止时，job handle 关闭并回收整个进程树。
 */
const WINDOWS_JOB_OBJECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AurevoyJobObjectRunner
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint Infinite = 0xffffffff;
    private const uint StdInputHandle = unchecked((uint)-10);

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Cb;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Ptr;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        ref ExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static int Run(string commandLine, string workingDirectory)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObject");
        try
        {
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
            {
                throw LastError("SetInformationJobObject");
            }

            var startup = new StartupInfo();
            startup.Cb = Marshal.SizeOf(typeof(StartupInfo));
            var processInfo = new ProcessInformation();
            var mutableCommandLine = new StringBuilder(commandLine);
            if (!CreateProcess(
                null,
                mutableCommandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateSuspended | CreateNoWindow,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out processInfo))
            {
                throw LastError("CreateProcess");
            }

            try
            {
                if (!AssignProcessToJobObject(job, processInfo.Process))
                {
                    TerminateProcess(processInfo.Process, 1);
                    throw LastError("AssignProcessToJobObject");
                }
                if (ResumeThread(processInfo.Thread) == 0xffffffff)
                {
                    TerminateProcess(processInfo.Process, 1);
                    throw LastError("ResumeThread");
                }
                WaitForSingleObject(processInfo.Process, Infinite);
                uint exitCode;
                if (!GetExitCodeProcess(processInfo.Process, out exitCode))
                {
                    throw LastError("GetExitCodeProcess");
                }
                return unchecked((int)exitCode);
            }
            finally
            {
                CloseHandle(processInfo.Thread);
                CloseHandle(processInfo.Process);
            }
        }
        finally
        {
            CloseHandle(job);
        }
    }
}
'@
$encodedPayload = '__AUREVOY_PAYLOAD__'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload)) | ConvertFrom-Json
$exitCode = [AurevoyJobObjectRunner]::Run([string]$payload.commandLine, [string]$payload.workingDirectory)
exit $exitCode
`;
