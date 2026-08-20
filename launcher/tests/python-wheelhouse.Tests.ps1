$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$ManifestPath = Join-Path $RepositoryRoot "launcher\runtime-manifest.json"
$InstallerPath = Join-Path $RepositoryRoot "launcher\python-wheelhouse.ps1"
$RequirementsPath = Join-Path $RepositoryRoot "launcher\python-runtime\requirements-win-cp37.in"

Describe "Python wheelhouse runtime" {
    BeforeAll {
        $script:manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:component = @($script:manifest.components | Where-Object { $_.id -eq "python" })[0]
        $script:lockPath = Join-Path (Split-Path -Parent $ManifestPath) $script:component.wheelLock
        $script:lock = Get-Content -LiteralPath $script:lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    It "matches all 98 direct pins to immutable artifacts" {
        $requirements = @(Get-Content -LiteralPath $RequirementsPath | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_) -and -not $_.Trim().StartsWith("#")
        } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Sort-Object)
        $locked = @($script:lock.artifacts | ForEach-Object {
            (([string]$_.name) + "==" + ([string]$_.version)).ToLowerInvariant()
        } | Sort-Object)

        $requirements.Count | Should Be 98
        ($requirements -join "|") | Should Be ($locked -join "|")
        @($script:lock.artifacts | Group-Object name | Where-Object { $_.Count -ne 1 }).Count | Should Be 0
        foreach ($artifact in @($script:lock.artifacts)) {
            $artifact.sha256 | Should Match "^[a-f0-9]{64}$"
            @($artifact.urls.official).Count | Should BeGreaterThan 0
        }
    }

    It "pins the official CPython base and TensorFlow GPU wheel" {
        $script:lock.python.version | Should Be "3.7.1"
        $script:lock.python.fileName | Should Be "python-3.7.1-embed-amd64.zip"
        $script:lock.python.sha256 | Should Be "c9e6ff79b0b9baa948e3819334d70fdc9ce2b195dc4948c9d668334ab4ff244e"
        ([Uri]$script:lock.python.urls.official[0]).Host | Should Be "www.python.org"

        $tensorflow = @($script:lock.artifacts | Where-Object { $_.name -eq "tensorflow-gpu" })[0]
        $tensorflow.version | Should Be "2.10.1"
        $tensorflow.fileName | Should Be "tensorflow_gpu-2.10.1-cp37-cp37m-win_amd64.whl"
        $tensorflow.sha256 | Should Be "15a18dead62702ef80806a3c9d01a554433aa1e609f8d556fb5b03c99d316043"
    }

    It "keeps download, extraction, offline install, and rollback safety gates" {
        $source = Get-Content -LiteralPath $InstallerPath -Raw -Encoding UTF8
        $source | Should Match "Test-PythonArtifactUrl"
        $source | Should Match "unsafe archive path"
        $source | Should Match "Project path is too long"
        $source | Should Match "PIP_NO_INDEX"
        $source | Should Match "--no-index"
        $source | Should Match "Test-FileSha256"
        $source | Should Match "rolled-back"
        $source | Should Not Match "git reset"
        $source | Should Not Match "git clean"
    }
}
