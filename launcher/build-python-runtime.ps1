[CmdletBinding()]
param(
    [string]$SourceRuntime = '',
    [string]$OutputDirectory = '',
    [switch]$ValidateOnly,
    [switch]$KeepDebugSymbols
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceRuntime)) {
    $SourceRuntime = Join-Path $PSScriptRoot "..\_internal\python_common"
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot "..\artifacts"
}

function Resolve-ExistingDirectory {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Label)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        throw "$Label directory does not exist: $full"
    }
    return $full
}

function Test-IsChildPath {
    param([string]$Candidate, [string]$Parent)
    $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    return $candidateFull.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePathSafe {
    param([string]$Base, [string]$Path)
    $baseUri = New-Object Uri(($Base.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar))
    $itemUri = New-Object Uri($Path)
    $relative = [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($itemUri).ToString()).Replace('/', '\')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('..\')) {
        throw "Path escaped runtime root: $Path"
    }
    return $relative
}

function Test-ExcludedRuntimeFile {
    param([string]$RelativePath, [switch]$KeepSymbols)
    $normalized = $RelativePath.Replace('/', '\')
    if ($normalized -match '(^|\\)(__pycache__|\.pytest_cache|pip-cache)(\\|$)') { return $true }
    if ($normalized -match '\.(pyc|pyo)$') { return $true }
    if ($normalized -match '(^|\\)tensorflow_gpu-2\.10\.1-cp37-cp37m-win_amd64\.whl$') { return $true }
    if (-not $KeepSymbols -and $normalized -match '\.pdb$') { return $true }
    return $false
}

function Invoke-RuntimeValidation {
    param([string]$Runtime)
    $python = Join-Path $Runtime 'python.exe'
    foreach ($required in @($python, (Join-Path $Runtime 'python37.dll'), (Join-Path $Runtime 'Lib\site-packages'))) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Missing runtime prerequisite: $required" }
    }

    $validationScript = @'
import json
import sys
import tensorflow as tf
import cv2, numpy, scipy, PyQt5, onnx, tf2onnx
if sys.version_info[:2] != (3, 7):
    raise RuntimeError("Expected CPython 3.7, got %r" % (sys.version,))
if tf.__version__ != "2.10.1":
    raise RuntimeError("Expected TensorFlow 2.10.1, got %s" % tf.__version__)
if not tf.test.is_built_with_cuda():
    raise RuntimeError("TensorFlow is not CUDA-enabled")
print(json.dumps({"python": sys.version.split()[0], "tensorflow": tf.__version__, "cudaBuild": tf.test.is_built_with_cuda()}, sort_keys=True))
'@
    $validationPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($validationScript))
    $validationCommand = "import base64;exec(base64.b64decode('$validationPayload').decode('utf-8'))"
    $previousErrorActionPreference = $ErrorActionPreference
    $validationExitCode = 1
    try {
        # Windows PowerShell 5.1 wraps native stderr as ErrorRecord objects. TensorFlow
        # emits harmless startup diagnostics there, so capture them without converting
        # a successful native process into a terminating NativeCommandError.
        $ErrorActionPreference = 'Continue'
        $output = @(& $python -c $validationCommand 2>&1)
        $validationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($validationExitCode -ne 0) { throw "Runtime import validation failed:`n$($output -join [Environment]::NewLine)" }
    $jsonLine = @($output | Where-Object { ([string]$_).Trim().StartsWith('{') } | Select-Object -Last 1)
    if ($jsonLine.Count -ne 1) { throw 'Runtime validation did not emit its expected JSON summary.' }
    return ($jsonLine[0] | ConvertFrom-Json)
}

function Write-DeterministicZip {
    param([string]$Source, [string]$Destination, [switch]$KeepSymbols)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destinationFull = [IO.Path]::GetFullPath($Destination)
    if (Test-Path -LiteralPath $destinationFull) { Remove-Item -LiteralPath $destinationFull -Force }
    $files = @(
        Get-ChildItem -LiteralPath $Source -Recurse -Force -File |
            Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
            ForEach-Object {
                $relative = Get-RelativePathSafe -Base $Source -Path $_.FullName
                [pscustomobject]@{ Item = $_; Relative = $relative }
            } |
            Where-Object { -not (Test-ExcludedRuntimeFile -RelativePath $_.Relative -KeepSymbols:$KeepSymbols) } |
            Sort-Object Relative
    )
    if ($files.Count -eq 0) { throw 'No runtime files remained after publication filters.' }
    $stream = [IO.File]::Open($destinationFull, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            foreach ($file in $files) {
                $entry = $archive.CreateEntry(($file.Relative.Replace('\', '/')), [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = New-Object DateTimeOffset (New-Object DateTime(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
                $input = [IO.File]::OpenRead($file.Item.FullName)
                try {
                    $entryStream = $entry.Open()
                    try { $input.CopyTo($entryStream) } finally { $entryStream.Dispose() }
                } finally { $input.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
    return $files
}

$source = Resolve-ExistingDirectory -Path $SourceRuntime -Label 'Source runtime'
$runtimeSummary = Invoke-RuntimeValidation -Runtime $source
if ($ValidateOnly) {
    Write-Output ('VALID ' + ($runtimeSummary | ConvertTo-Json -Compress))
    exit 0
}

$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
if (Test-IsChildPath -Candidate $output -Parent $source) {
    throw "OutputDirectory must not be inside SourceRuntime, otherwise the ZIP can include itself: $output"
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
$artifact = Join-Path $output 'dflsn-python-common-cp37-gpu-win-amd64.zip'
$inventory = Join-Path $output 'dflsn-python-common-cp37-gpu-win-amd64.inventory.json'
$files = Write-DeterministicZip -Source $source -Destination $artifact -KeepSymbols:$KeepDebugSymbols
$sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
$inventoryPayload = [ordered]@{
    schemaVersion = 1
    artifact = [IO.Path]::GetFileName($artifact)
    sha256 = $sha256
    bytes = (Get-Item -LiteralPath $artifact).Length
    archiveRoot = '.'
    sourceRuntime = $source
    builtUtc = [DateTime]::UtcNow.ToString('o')
    validation = $runtimeSummary
    excluded = @('__pycache__', '*.pyc', '*.pyo', '*.pdb (unless -KeepDebugSymbols)', 'cached tensorflow_gpu wheel')
    files = @($files | ForEach-Object { [ordered]@{ path = $_.Relative; bytes = $_.Item.Length } })
}
[IO.File]::WriteAllText($inventory, ($inventoryPayload | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
Write-Output "ARTIFACT=$artifact"
Write-Output "SHA256=$sha256"
Write-Output "INVENTORY=$inventory"
Write-Output 'NEXT=Upload the ZIP to an immutable project-controlled HTTPS object URL, then insert that URL and SHA256 into the python manifest component.'
