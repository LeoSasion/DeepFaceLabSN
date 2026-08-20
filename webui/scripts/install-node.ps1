[CmdletBinding()]
param(
    [string]$ArchivePath,
    [switch]$NoDownload,
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Keep this version pinned so release packages are reproducible and a downloaded
# archive can be verified against a checksum recorded in source control.
$NodeVersion = "24.19.0"
$ArchiveName = "node-v$NodeVersion-win-x64.zip"
$ArchiveSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$DownloadUrl = "https://nodejs.org/dist/v$NodeVersion/$ArchiveName"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$InternalRoot = Join-Path $RepositoryRoot "_internal"
$InstallRoot = Join-Path $InternalRoot "node"
$InstalledNode = Join-Path $InstallRoot "bin\node.exe"
$BundledArchive = Join-Path $InternalRoot "installers\$ArchiveName"
$TemporaryRoot = $null
$StagingRoot = $null
$BackupRoot = $null
$archiveToUse = $null
$archiveWasDownloaded = $false
$archiveVerified = $false

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Write-Step {
    param(
        [string]$Chinese,
        [string]$English,
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )

    Write-Host "[WebUI] $Chinese" -ForegroundColor $Color
    Write-Host "        $English" -ForegroundColor DarkGray
}

function Get-NodeVersion {
    param([string]$NodePath)

    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        return $null
    }

    try {
        $versionText = (& $NodePath -p "process.versions.node" 2>$null | Select-Object -First 1)
        # Windows PowerShell 5.1 can report LASTEXITCODE=-1 for a successful
        # Node.js 24 process even though stdout is valid. Treat a parseable
        # semantic version as the source of truth instead.
        if ([string]::IsNullOrWhiteSpace($versionText)) {
            return $null
        }

        $parsedVersion = $null
        if (-not [Version]::TryParse($versionText.Trim(), [ref]$parsedVersion)) {
            return $null
        }
        return $parsedVersion
    } catch {
        return $null
    }
}

function Assert-SafeInstallPaths {
    $internalPrefix = [IO.Path]::GetFullPath($InternalRoot).TrimEnd('\') + '\'
    $installPath = [IO.Path]::GetFullPath($InstallRoot)
    if (-not $installPath.StartsWith($internalPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to install Node.js outside the repository _internal directory."
    }
}

function Remove-DirectoryIfPresent {
    param(
        [string]$Path,
        [switch]$IgnoreErrors
    )

    if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path)) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force
        } catch {
            if (-not $IgnoreErrors) {
                throw
            }
        }
    }
}

try {
    Assert-SafeInstallPaths

    $currentVersion = Get-NodeVersion -NodePath $InstalledNode
    if (-not $Force -and $null -ne $currentVersion -and $currentVersion.ToString() -eq $NodeVersion) {
        Write-Step "便携 Node.js 已就绪：v$currentVersion" "Portable Node.js is ready: v$currentVersion" Green
        exit 0
    }

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "DeepFaceLabSN WebUI requires 64-bit Windows."
    }

    New-Item -ItemType Directory -Path $InternalRoot -Force | Out-Null
    $TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("DeepFaceLabSN-node-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null

    $archiveToUse = $ArchivePath
    if ([string]::IsNullOrWhiteSpace($archiveToUse)) {
        if (Test-Path -LiteralPath $BundledArchive -PathType Leaf) {
            $archiveToUse = $BundledArchive
            Write-Step "发现整合包内置的 Node.js 安装包。" "Found the Node.js archive bundled with this package." Cyan
        } elseif ($NoDownload) {
            throw "Bundled archive not found: $BundledArchive"
        } else {
            $archiveToUse = Join-Path $TemporaryRoot $ArchiveName
            $archiveWasDownloaded = $true
            Write-Step "未找到便携 Node.js，正在下载约 37 MB 的官方 LTS 版本…" "Portable Node.js was not found; downloading the official LTS archive (about 37 MB)..." Yellow

            # Windows PowerShell 5.1 may otherwise negotiate an obsolete TLS
            # version on machines upgraded from an older Windows installation.
            [Net.ServicePointManager]::SecurityProtocol =
                [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $archiveToUse -UseBasicParsing
        }
    } else {
        $archiveToUse = [IO.Path]::GetFullPath($archiveToUse)
        if (-not (Test-Path -LiteralPath $archiveToUse -PathType Leaf)) {
            throw "Node.js archive not found: $archiveToUse"
        }
        Write-Step "正在使用指定的 Node.js 安装包。" "Using the specified Node.js archive." Cyan
    }

    Write-Step "正在校验 Node.js 安装包…" "Verifying the Node.js archive..." Cyan
    $actualSha256 = (Get-FileHash -LiteralPath $archiveToUse -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $ArchiveSha256) {
        throw "Node.js archive SHA-256 mismatch. Expected $ArchiveSha256, got $actualSha256."
    }
    $archiveVerified = $true

    $extractRoot = Join-Path $TemporaryRoot "extracted"
    Expand-Archive -LiteralPath $archiveToUse -DestinationPath $extractRoot -Force
    $sourceRoot = Join-Path $extractRoot "node-v$NodeVersion-win-x64"
    $sourceNode = Join-Path $sourceRoot "node.exe"
    if (-not (Test-Path -LiteralPath $sourceNode -PathType Leaf)) {
        throw "The verified archive did not contain node.exe in the expected directory."
    }

    $StagingRoot = Join-Path $InternalRoot ("node.installing-" + $PID + "-" + [Guid]::NewGuid().ToString("N"))
    $stagingBin = Join-Path $StagingRoot "bin"
    New-Item -ItemType Directory -Path $stagingBin -Force | Out-Null
    Get-ChildItem -Force -LiteralPath $sourceRoot | Copy-Item -Destination $stagingBin -Recurse -Force

    # A ZIP downloaded by Windows may carry Mark-of-the-Web to every extracted
    # executable. The archive has already passed its pinned SHA-256 check, so it
    # is safe to remove that marker before validating the project-local copy.
    Get-ChildItem -File -Recurse -LiteralPath $stagingBin | Unblock-File -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $InstallRoot) {
        $BackupRoot = Join-Path $InternalRoot ("node.backup-" + $PID + "-" + [Guid]::NewGuid().ToString("N"))
        Move-Item -LiteralPath $InstallRoot -Destination $BackupRoot
    }

    try {
        Move-Item -LiteralPath $StagingRoot -Destination $InstallRoot
        $StagingRoot = $null

        $installedVersion = Get-NodeVersion -NodePath $InstalledNode
        if ($null -eq $installedVersion -or $installedVersion.ToString() -ne $NodeVersion) {
            throw "Installed Node.js failed its final validation."
        }
    } catch {
        Remove-DirectoryIfPresent -Path $InstallRoot
        if ($null -ne $BackupRoot -and (Test-Path -LiteralPath $BackupRoot)) {
            Move-Item -LiteralPath $BackupRoot -Destination $InstallRoot
            $BackupRoot = $null
        }
        throw
    }

    try {
        Remove-DirectoryIfPresent -Path $BackupRoot
    } catch {
        Write-Step "新运行时已就绪，但旧运行时备份暂时无法删除：$BackupRoot" "The new runtime is ready, but the old runtime backup could not be removed yet: $BackupRoot" Yellow
    }
    $BackupRoot = $null
    Write-Step "Node.js v$NodeVersion 已安装到项目内部，无需管理员权限。" "Node.js v$NodeVersion was installed inside the project; administrator access was not required." Green
    exit 0
} catch {
    if ($archiveWasDownloaded -and $archiveVerified -and (Test-Path -LiteralPath $archiveToUse -PathType Leaf)) {
        try {
            New-Item -ItemType Directory -Path (Split-Path -Parent $BundledArchive) -Force | Out-Null
            Copy-Item -LiteralPath $archiveToUse -Destination $BundledArchive -Force
            Write-Step "已保留校验通过的安装包，重试时无需重新下载。" "The verified archive was preserved, so a retry will not download it again." Yellow
        } catch {
            # Preserve the original installation error if optional caching fails.
        }
    }
    Write-Host
    Write-Step "Node.js 自动安装失败。" "Automatic Node.js installation failed." Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($_.InvocationInfo.PositionMessage)) {
        Write-Host "  $($_.InvocationInfo.PositionMessage.Trim())" -ForegroundColor DarkGray
    }
    Write-Host
    Write-Host "  离线使用：将 $ArchiveName 放到：" -ForegroundColor DarkGray
    Write-Host "  Offline setup: place $ArchiveName at:" -ForegroundColor DarkGray
    Write-Host "  $BundledArchive" -ForegroundColor Gray
    exit 1
} finally {
    Remove-DirectoryIfPresent -Path $StagingRoot -IgnoreErrors
    Remove-DirectoryIfPresent -Path $TemporaryRoot -IgnoreErrors
}
