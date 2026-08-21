[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$Executable
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([String]::IsNullOrWhiteSpace($Executable)) {
    $Executable = Join-Path $PSScriptRoot "bin\DeepFaceLabSN.Launcher.exe"
}

$executableFullPath = [IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $executableFullPath -PathType Leaf)) {
    throw "Launcher executable is missing: $executableFullPath"
}

$file = Get-Item -LiteralPath $executableFullPath
$minimumBytes = 1MB
$maximumBytes = 64MB
if ($file.Length -lt $minimumBytes -or $file.Length -gt $maximumBytes) {
    throw "Launcher executable size is outside the accepted update range: $($file.Length) bytes"
}

$fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($executableFullPath).FileVersion
if (-not [String]::Equals($fileVersion, "$Version.0", [StringComparison]::Ordinal)) {
    throw "Launcher file version $fileVersion does not match requested update version $Version.0"
}

$assetName = $file.Name
$tagName = "v$Version"
$manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    publishedAt = [DateTimeOffset]::Now.ToString("yyyy-MM-ddTHH:mm:sszzz", [Globalization.CultureInfo]::InvariantCulture)
    sha256 = (Get-FileHash -LiteralPath $executableFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    size = [Int64]$file.Length
    sources = @(
        [ordered]@{
            provider = "github"
            url = "https://github.com/LeoSasion/DeepFaceLabSN/releases/download/$tagName/$assetName"
        },
        [ordered]@{
            provider = "gitee"
            url = "https://gitee.com/LeoSasion/DeepFaceLabSN/releases/download/$tagName/$assetName"
        }
    )
}

$destination = Join-Path $PSScriptRoot "update-channel.json"
$temporary = $destination + ".publishing-" + [Guid]::NewGuid().ToString("N") + ".tmp"
$backup = $destination + ".backup-" + [Guid]::NewGuid().ToString("N") + ".tmp"
try {
    $json = $manifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        [IO.File]::Replace($temporary, $destination, $backup, $true)
    } else {
        [IO.File]::Move($temporary, $destination)
    }
} finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backup -PathType Leaf) {
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Launcher update channel written: $destination" -ForegroundColor Green
Write-Host "Version: $Version"
Write-Host "SHA-256: $($manifest.sha256)"
Write-Host "Size: $($manifest.size) bytes"
