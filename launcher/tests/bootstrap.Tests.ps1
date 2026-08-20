$ErrorActionPreference = "Stop"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$Bootstrap = Join-Path $RepositoryRoot "launcher\bootstrap.ps1"
$ManifestPath = Join-Path $RepositoryRoot "launcher\runtime-manifest.json"

function Invoke-BootstrapProcess {
    param([string[]]$Arguments)

    $output = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Bootstrap @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $events = @()
    foreach ($line in $output) {
        if (-not [string]::IsNullOrWhiteSpace([string]$line)) {
            $events += ([string]$line | ConvertFrom-Json)
        }
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Events = $events; Raw = $output }
}

Describe "launcher runtime manifest" {
    It "pins the same Node archive and SHA as the existing installer" {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $node = @($manifest.components | Where-Object { $_.id -eq "node" })[0]
        $installer = Get-Content -LiteralPath (Join-Path $RepositoryRoot "webui\scripts\install-node.ps1") -Raw
        $node.version | Should Be "24.19.0"
        $node.archive.sha256 | Should Be "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
        $installer | Should Match ([regex]::Escape($node.version))
        $installer | Should Match ([regex]::Escape($node.archive.sha256))
    }

    It "pins official CUDA and cuDNN artifacts to the exact runtime DLL set" {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($id in @("cuda", "cudnn")) {
            $component = @($manifest.components | Where-Object { $_.id -eq $id })[0]
            $component.available | Should Be $true
            $expectedArtifactCount = if ($id -eq "cuda") { 9 } else { 1 }
            @($component.artifacts).Count | Should Be $expectedArtifactCount
            foreach ($artifact in @($component.artifacts)) {
                $artifact.sha256 | Should Match '^[a-f0-9]{64}$'
                @($artifact.urls.official).Count | Should BeGreaterThan 0
                foreach ($url in @($artifact.urls.official)) { $url | Should Match '^https://' }
                $officialHost = ([Uri]@($artifact.urls.official)[0]).Host
                if ($officialHost -eq "developer.download.nvidia.com") {
                    @($artifact.urls.china).Count | Should Be 1
                    ([Uri]@($artifact.urls.china)[0]).Host | Should Be "developer.download.nvidia.cn"
                } else {
                    @($artifact.urls.china).Count | Should Be 0
                }
            }
            $targets = @($component.artifacts | ForEach-Object { $_.files } | ForEach-Object { $_.target } | Sort-Object)
            $expected = @($component.validation.files | ForEach-Object { $_.path } | Sort-Object)
            ($targets -join '|') | Should Be ($expected -join '|')
        }
    }

    It "keeps the CUDA disk gate above the measured install peak without requiring six GiB" {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cuda = @($manifest.components | Where-Object { $_.id -eq "cuda" })[0]
        [Int64]$cuda.install.requiredFreeBytes | Should Be 3758096384
        [Int64]$cuda.install.requiredFreeBytes | Should BeGreaterThan 3362646347
    }
    It "pins the reproducible Python 3.7 TensorFlow GPU wheelhouse" {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $python = @($manifest.components | Where-Object { $_.id -eq "python" })[0]
        $python.available | Should Be $true
        $python.install.layout | Should Be "python-wheelhouse"
        $python.wheelLock | Should Be "python-runtime/runtime-wheel-lock.json"
        $python.wheelLockSha256 | Should Match '^[a-f0-9]{64}$'

        $wheelLockPath = Join-Path (Split-Path -Parent $ManifestPath) $python.wheelLock
        (Get-FileHash -LiteralPath $wheelLockPath -Algorithm SHA256).Hash.ToLowerInvariant() | Should Be $python.wheelLockSha256
        $lock = Get-Content -LiteralPath $wheelLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $lock.schemaVersion | Should Be 1
        $lock.platform | Should Be "win-amd64"
        $lock.runtimeVersion | Should Be $python.version
        @($lock.artifacts).Count | Should Be 98
        @($lock.artifacts | Where-Object { $_.kind -eq "wheel" }).Count | Should Be 97
        @($lock.artifacts | Where-Object { $_.name -eq "future" -and $_.version -eq "0.18.3" -and $_.kind -eq "sdist" }).Count | Should Be 1

        $tensorflow = @($lock.artifacts | Where-Object { $_.name -eq "tensorflow-gpu" })[0]
        $tensorflow.version | Should Be "2.10.1"
        $tensorflow.sha256 | Should Be "15a18dead62702ef80806a3c9d01a554433aa1e609f8d556fb5b03c99d316043"
        foreach ($artifact in @($lock.artifacts)) {
            $artifact.sha256 | Should Match '^[a-f0-9]{64}$'
            @($artifact.urls.official).Count | Should BeGreaterThan 0
            foreach ($url in @($artifact.urls.official)) { ([Uri]$url).Host | Should Be "files.pythonhosted.org" }
            foreach ($url in @($artifact.urls.china)) { ([Uri]$url).Host | Should Be "pypi.tuna.tsinghua.edu.cn" }
        }
    }

    It "pins the official MinGit release hash" {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $git = @($manifest.components | Where-Object { $_.id -eq "mingit" })[0]
        $git.version | Should Be "2.55.0.3"
        $git.archive.sha256 | Should Be "f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05"
        @($git.archive.urls.china).Count | Should Be 1
        ([Uri]@($git.archive.urls.china)[0]).Host | Should Be "mirrors.huaweicloud.com"
        $git.archive.urls.official[0] | Should Match '^https://github\.com/git-for-windows/git/releases/download/'
    }
}

Describe "launcher bootstrap dry run" {
    It "emits valid JSONL with the stable required fields in GitOnly mode" {
        $toolRoot = Join-Path $TestDrive "bootstrap-tools"
        New-Item -ItemType Directory -Path $toolRoot | Out-Null
        $result = Invoke-BootstrapProcess -Arguments @(
            "-ProjectRoot", $toolRoot,
            "-ManifestPath", $ManifestPath,
            "-GitOnly", "-DryRun", "-NoNetwork", "-Mirror", "official"
        )
        $result.ExitCode | Should Be 0
        $result.Events.Count | Should BeGreaterThan 3
        foreach ($event in $result.Events) {
            foreach ($field in @("stage", "id", "status", "progress", "downloaded", "total", "message")) {
                (@($event.PSObject.Properties.Name) -contains $field) | Should Be $true
            }
        }
        @($result.Events | Where-Object { $_.id -eq "mingit" -and $_.status -eq "planned" }).Count | Should Be 1
    }

    It "refuses to treat a missing checkout as an install target" {
        $missing = Join-Path $TestDrive "not-a-project"
        New-Item -ItemType Directory -Path $missing | Out-Null
        $result = Invoke-BootstrapProcess -Arguments @(
            "-ProjectRoot", $missing,
            "-ManifestPath", $ManifestPath,
            "-DryRun", "-NoNetwork", "-Mirror", "official"
        )
        $result.ExitCode | Should Be 1
        @($result.Events | Where-Object { $_.id -eq "fatal" -and $_.status -eq "failed" }).Count | Should Be 1
    }

    It "accepts a legacy checkout without a launcher source directory" {
        $project = Join-Path $TestDrive "legacy-project"
        foreach ($directory in @("_internal", "webui")) {
            New-Item -ItemType Directory -Path (Join-Path $project $directory) -Force | Out-Null
        }
        $result = Invoke-BootstrapProcess -Arguments @(
            "-ProjectRoot", $project,
            "-ManifestPath", $ManifestPath,
            "-DryRun", "-NoNetwork", "-Mirror", "official"
        )
        $result.ExitCode | Should Be 0
        @($result.Events | Where-Object { $_.id -in @("mingit", "node", "cuda", "cudnn", "python") -and $_.status -eq "planned" }).Count | Should Be 5
        @($result.Events | Where-Object { $_.id -eq "complete" -and $_.status -eq "complete" }).Count | Should Be 1
    }

    It "plans every published runtime on a clean project" {
        $project = Join-Path $TestDrive "clean-project"
        foreach ($directory in @("_internal", "launcher", "webui")) {
            New-Item -ItemType Directory -Path (Join-Path $project $directory) -Force | Out-Null
        }
        $result = Invoke-BootstrapProcess -Arguments @(
            "-ProjectRoot", $project,
            "-ManifestPath", $ManifestPath,
            "-DryRun", "-NoNetwork", "-Mirror", "official"
        )
        $result.ExitCode | Should Be 0
        @($result.Events | Where-Object { $_.status -eq "unavailable" }).Count | Should Be 0
        @($result.Events | Where-Object { $_.id -in @("mingit", "node", "cuda", "cudnn", "python") -and $_.status -eq "planned" }).Count | Should Be 5
        @($result.Events | Where-Object { $_.id -eq "complete" -and $_.status -eq "complete" }).Count | Should Be 1
    }
}
