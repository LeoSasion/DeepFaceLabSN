[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [switch]$SkipWebuiTests,
    [switch]$SkipLauncherTests,
    [switch]$SkipBuild,
    [switch]$SkipSmoke
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$webuiRoot = Join-Path $repositoryRoot "webui"
$versionSource = Get-Content -LiteralPath (Join-Path $repositoryRoot "release\version.json") -Raw -Encoding UTF8 | ConvertFrom-Json

function Write-Step {
    param([string]$Text)
    Write-Host "[verify-release] $Text" -ForegroundColor Cyan
}

function Assert-ExitCode {
    param([string]$Label)
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Find-Node {
    $candidates = @((Join-Path $repositoryRoot "_internal\node\bin\node.exe"))
    $fromPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $fromPath) { $candidates += $fromPath.Source }
    foreach ($candidate in $candidates) {
        if (-not [String]::IsNullOrWhiteSpace($candidate) -and
            (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $actual = (& $candidate -p "process.versions.node" | Select-Object -First 1)
            if ([String]::Equals($actual, [string]$versionSource.nodeVersion, [StringComparison]::Ordinal)) {
                return [IO.Path]::GetFullPath($candidate)
            }
        }
    }
    throw "Exact Node.js $($versionSource.nodeVersion) is required."
}

function Find-Corepack {
    param([string]$Node)
    $alongside = Join-Path (Split-Path -Parent $Node) "corepack.cmd"
    if (Test-Path -LiteralPath $alongside -PathType Leaf) { return $alongside }
    $fromPath = Get-Command corepack.cmd -ErrorAction SilentlyContinue
    if ($null -ne $fromPath) { return $fromPath.Source }
    throw "corepack is required to run pnpm $($versionSource.pnpmVersion)."
}

$node = Find-Node
$corepack = Find-Corepack -Node $node

Write-Step "Activating pinned pnpm $($versionSource.pnpmVersion)"
& $corepack prepare "pnpm@$($versionSource.pnpmVersion)" --activate
Assert-ExitCode "pnpm activation"
$actualPnpm = (& $corepack pnpm --version | Select-Object -First 1)
if (-not [String]::Equals($actualPnpm, [string]$versionSource.pnpmVersion, [StringComparison]::Ordinal)) {
    throw "Expected pnpm $($versionSource.pnpmVersion), but corepack selected $actualPnpm."
}

Write-Step "Checking synchronized product/runtime versions"
& $node (Join-Path $PSScriptRoot "verify-version.mjs")
Assert-ExitCode "Version verification"

Write-Step "Checking UI translation keys and placeholder parity"
& $node (Join-Path $PSScriptRoot "check-i18n.mjs")
Assert-ExitCode "i18n verification"

Write-Step "Checking update-channel signature policy and Ed25519 implementation"
& $node (Join-Path $PSScriptRoot "update-channel-signature.mjs") verify-policy
Assert-ExitCode "Update-channel signature policy"
& $node --test (Join-Path $PSScriptRoot "tests\update-channel-signature.test.mjs")
Assert-ExitCode "Ed25519 signature tests"

if ($InstallDependencies) {
    Write-Step "Installing locked WebUI dependencies"
    Push-Location $webuiRoot
    try {
        & $corepack pnpm install --frozen-lockfile
        Assert-ExitCode "WebUI dependency install"
    } finally {
        Pop-Location
    }
}

$requiredWebuiDependencies = @(
    "node_modules\vite\bin\vite.js",
    "node_modules\react\package.json",
    "node_modules\node-pty\package.json"
)
foreach ($relative in $requiredWebuiDependencies) {
    if (-not (Test-Path -LiteralPath (Join-Path $webuiRoot $relative) -PathType Leaf)) {
        throw "WebUI dependencies are incomplete ($relative). Stop the local preview, then run the pinned pnpm install explicitly or rerun with -InstallDependencies."
    }
}

if (-not $SkipWebuiTests) {
    Write-Step "Running isolated WebUI tests with generated DFL fixtures"
    Push-Location $webuiRoot
    try {
        & $corepack pnpm test
        Assert-ExitCode "WebUI tests"
    } finally {
        Pop-Location
    }
}

if (-not $SkipLauncherTests) {
    Write-Step "Running launcher terminal-bridge tests"
    $bridgeTests = @(Get-ChildItem -LiteralPath (Join-Path $repositoryRoot "launcher\server\tests") -Filter *.test.mjs -File | Sort-Object Name | ForEach-Object FullName)
    & $node --test @bridgeTests
    Assert-ExitCode "Launcher terminal-bridge tests"

    Write-Step "Running launcher Pester tests under Windows PowerShell"
    $windowsPowerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
        throw "Windows PowerShell is required for launcher compatibility tests."
    }
    & $windowsPowerShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run-launcher-tests.ps1")
    Assert-ExitCode "Launcher Pester tests"
}

if (-not $SkipBuild) {
    Write-Step "Building WebUI production and Sites artifacts"
    Push-Location $webuiRoot
    try {
        & $corepack pnpm run build
        Assert-ExitCode "WebUI production build"
        & $corepack pnpm run test:sites
        Assert-ExitCode "Sites artifact tests"
    } finally {
        Pop-Location
    }
}

Write-Step "Checking that dist matches the current build inputs"
& $node (Join-Path $PSScriptRoot "dist-provenance.mjs") check
Assert-ExitCode "Dist freshness"

if (-not $SkipSmoke) {
    Write-Step "Smoke-testing the built WebUI over loopback HTTP"
    & $node (Join-Path $PSScriptRoot "smoke-dist.mjs")
    Assert-ExitCode "Built WebUI smoke test"
}

Write-Host "[verify-release] All required release gates passed." -ForegroundColor Green
