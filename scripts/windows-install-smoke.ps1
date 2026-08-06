param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$UpgradeInstallerPath,

    [string]$InstallDirectory = (Join-Path ([IO.Path]::GetTempPath()) "aurevoy-install-smoke-$PID"),
    [string]$ReportPath = (Join-Path ([IO.Path]::GetTempPath()) "aurevoy-install-smoke-$PID.json"),
    [int]$StartupTimeoutSeconds = 30,
    [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "windows-install-smoke.ps1 只能在真实 Windows runner 上执行。"
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$resolvedInstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$tempInstallPrefix = "$tempRoot$([IO.Path]::DirectorySeparatorChar)"
if ($resolvedInstallDirectory -eq $tempRoot -or -not $resolvedInstallDirectory.StartsWith($tempInstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallDirectory 必须是临时目录下的专用子目录，拒绝清理潜在的用户目录：$resolvedInstallDirectory"
}
$InstallDirectory = $resolvedInstallDirectory

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedUpgradeInstaller = (Resolve-Path -LiteralPath $UpgradeInstallerPath).Path
$report = [ordered]@{
    status = "failed"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    platform = "win32"
    installer = $resolvedInstaller
    upgradeInstaller = $resolvedUpgradeInstaller
    installDirectory = $InstallDirectory
    signatureRequired = [bool]$RequireSignature
    smartScreen = [ordered]@{
        status = "manual-ui-check-required"
        reason = "SmartScreen 首次信誉提示与普通用户交互不能由无头脚本证明。"
    }
}
$runningProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Write-InstallSmokeReport {
    $parent = Split-Path -Parent $ReportPath
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}

function Invoke-NsisInstaller([string]$Path, [string]$TargetDirectory) {
    New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
    $process = Start-Process -FilePath $Path -ArgumentList @("/S", "/D=$TargetDirectory") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "NSIS 安装器失败：$Path (exit=$($process.ExitCode))"
    }
}

function Resolve-InstalledExecutable([string]$TargetDirectory) {
    $candidates = @(Get-ChildItem -LiteralPath $TargetDirectory -Filter "*.exe" -Recurse -File |
        Where-Object { $_.Name -notmatch "(?i)uninstall" })
    if ($candidates.Count -eq 0) {
        throw "安装目录中没有发现 Aurevoy 主程序：$TargetDirectory"
    }
    $preferred = @($candidates | Where-Object { $_.BaseName -in @("Aurevoy", "desktop") })
    if ($preferred.Count -gt 0) {
        return $preferred[0]
    }
    return $candidates[0]
}

function Get-BinaryEvidence([IO.FileInfo]$Executable) {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Executable.FullName)
    $signature = Get-AuthenticodeSignature -LiteralPath $Executable.FullName
    return [ordered]@{
        path = $Executable.FullName
        sha256 = (Get-FileHash -LiteralPath $Executable.FullName -Algorithm SHA256).Hash
        fileVersion = $version.FileVersion
        productVersion = $version.ProductVersion
        signatureStatus = [string]$signature.Status
        signer = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    }
}

function Assert-Signature([string]$Path, [string]$Label) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($RequireSignature -and $signature.Status -ne "Valid") {
        throw "$Label 签名无效：$Path (status=$($signature.Status))"
    }
    return [ordered]@{
        label = $Label
        path = $Path
        status = [string]$signature.Status
        signer = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    }
}

function Start-And-StopInstalledApp([IO.FileInfo]$Executable, [string]$Stage) {
    $process = Start-Process -FilePath $Executable.FullName -PassThru
    $runningProcesses.Add($process)
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) {
            throw "$Stage 启动后立即退出：$($Executable.FullName) (exit=$($process.ExitCode))"
        }
        Start-Sleep -Milliseconds 500
        if (-not $process.HasExited) {
            break
        }
    }
    $process.Refresh()
    if ($process.HasExited) {
        throw "$Stage 未能保持运行：$($Executable.FullName)"
    }

    if (-not $process.CloseMainWindow()) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    } else {
        $process.WaitForExit(10000)
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-Uninstaller([string]$TargetDirectory) {
    $uninstaller = @(Get-ChildItem -LiteralPath $TargetDirectory -Filter "uninstall*.exe" -Recurse -File | Select-Object -First 1)
    if ($uninstaller.Count -eq 0) {
        throw "安装目录中没有发现卸载程序：$TargetDirectory"
    }
    $process = Start-Process -FilePath $uninstaller[0].FullName -ArgumentList @("/S") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "卸载程序失败：$($uninstaller[0].FullName) (exit=$($process.ExitCode))"
    }
    if (Test-Path -LiteralPath $TargetDirectory) {
        $remainingExecutables = @(Get-ChildItem -LiteralPath $TargetDirectory -Filter "*.exe" -Recurse -File -ErrorAction SilentlyContinue)
        if ($remainingExecutables.Count -gt 0) {
            throw "卸载后仍残留可执行文件：$($remainingExecutables[0].FullName)"
        }
    }
}

try {
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    $report.initialInstallerSignature = Assert-Signature $resolvedInstaller "initial-installer"
    $report.upgradeInstallerSignature = Assert-Signature $resolvedUpgradeInstaller "upgrade-installer"

    Invoke-NsisInstaller $resolvedInstaller $InstallDirectory
    $initialExecutable = Resolve-InstalledExecutable $InstallDirectory
    $initialEvidence = Get-BinaryEvidence $initialExecutable
    Start-And-StopInstalledApp $initialExecutable "首次安装"
    $report.initial = $initialEvidence

    Invoke-NsisInstaller $resolvedUpgradeInstaller $InstallDirectory
    $upgradeExecutable = Resolve-InstalledExecutable $InstallDirectory
    $upgradeEvidence = Get-BinaryEvidence $upgradeExecutable
    if ($initialEvidence.sha256 -eq $upgradeEvidence.sha256) {
        throw "升级后主程序 SHA-256 未变化，无法证明确实安装了新版本。"
    }
    Start-And-StopInstalledApp $upgradeExecutable "升级安装"
    $report.upgrade = $upgradeEvidence
    $report.assertions = @(
        "旧安装器静默安装成功",
        "首次安装主程序可启动并保持运行",
        "升级安装器覆盖到同一安装目录且主程序内容发生变化",
        "升级后主程序可启动并保持运行",
        "卸载程序静默执行且不残留可执行文件"
    )

    Invoke-Uninstaller $InstallDirectory
    $report.status = "passed"
    Write-Output ($report | ConvertTo-Json -Depth 8)
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    foreach ($process in $runningProcesses) {
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {
            # 进程已经退出时无需重复处理，保留原始 smoke 错误。
        }
    }
    if (Test-Path -LiteralPath $InstallDirectory) {
        Remove-Item -LiteralPath $InstallDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-InstallSmokeReport
}
