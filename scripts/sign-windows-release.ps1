$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$required = ($env:WINDOWS_SIGNING_REQUIRED -eq "true")
$encodedCertificate = $env:WINDOWS_CODE_SIGNING_CERT_BASE64

if ([string]::IsNullOrWhiteSpace($encodedCertificate)) {
    if ($required) {
        throw "公开 Windows 发布要求 WINDOWS_CODE_SIGNING_CERT_BASE64；拒绝上传未签名产物。"
    }
    Write-Host "::warning::未配置 Windows 代码签名 Secret；非公开构建跳过签名。"
    exit 0
}

function Resolve-SignTool {
    $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($null -ne $fromPath) {
        return $fromPath.Source
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    $kitsRoot = Join-Path $programFilesX86 "Windows Kits\10\bin"
    if (Test-Path $kitsRoot) {
        $candidate = Get-ChildItem -Path $kitsRoot -Filter signtool.exe -Recurse -File |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($null -ne $candidate) {
            return $candidate.FullName
        }
    }
    throw "未找到 signtool.exe；请确认 Windows SDK 已安装。"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseExe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\desktop.exe"
$nsisDir = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\bundle\nsis"
$installers = @(Get-ChildItem -Path $nsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue)
$targets = @($releaseExe) + @($installers | ForEach-Object { $_.FullName })

if (-not (Test-Path $releaseExe)) {
    throw "未找到 Tauri 主程序：$releaseExe"
}
if ($installers.Count -eq 0) {
    throw "未找到 NSIS 安装器：$nsisDir"
}

$signTool = Resolve-SignTool
$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CODE_SIGNING_TIMESTAMP_URL)) {
    "http://timestamp.digicert.com"
} else {
    $env:WINDOWS_CODE_SIGNING_TIMESTAMP_URL
}
$runnerTemp = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [IO.Path]::GetTempPath()
} else {
    $env:RUNNER_TEMP
}
$certificatePath = Join-Path $runnerTemp "aurevoy-code-signing.pfx"

try {
    # Secret 只在 runner 临时目录短暂落盘，脚本结束时无条件清理。
    $certificateBytes = [Convert]::FromBase64String(($encodedCertificate -replace "\s", ""))
    [IO.File]::WriteAllBytes($certificatePath, $certificateBytes)

    foreach ($target in $targets) {
        $signArgs = @(
            "sign",
            "/fd", "SHA256",
            "/tr", $timestampUrl,
            "/td", "SHA256",
            "/f", $certificatePath
        )
        if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_CODE_SIGNING_PASSWORD)) {
            $signArgs += @("/p", $env:WINDOWS_CODE_SIGNING_PASSWORD)
        }
        $signArgs += $target
        & $signTool @signArgs
        if ($LASTEXITCODE -ne 0) {
            throw "signtool sign 失败：$target (exit=$LASTEXITCODE)"
        }

        & $signTool verify /pa /all /tw /v $target
        if ($LASTEXITCODE -ne 0) {
            throw "signtool verify 失败：$target (exit=$LASTEXITCODE)"
        }
        Write-Host "已签名并验证：$target"
    }
}
finally {
    if (Test-Path $certificatePath) {
        Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
    }
}
