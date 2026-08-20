# Reproducible CPython 3.7 wheelhouse installer for bootstrap.ps1.
# This file is ASCII so Windows PowerShell 5.1 can dot-source it safely.

function Test-PythonArtifactUrl {
    param(
        [string]$Url,
        [Parameter(Mandatory = $true)][string[]]$AllowedHosts
    )

    $uri = $null
    if ([string]::IsNullOrWhiteSpace($Url) -or
        -not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        (-not $uri.IsDefaultPort -and $uri.Port -ne 443)) {
        return $false
    }
    foreach ($hostName in $AllowedHosts) {
        if ([string]::Equals($uri.Host, $hostName, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Resolve-PythonWheelLockPath {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    $relativePath = [string](Get-OptionalProperty $Component 'wheelLock' '')
    if (-not (Test-SafeRelativeArtifactPath -Path $relativePath)) {
        throw "Component $($Component.id) has an unsafe wheelLock path."
    }
    $manifestDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($ManifestPath))
    $lockPath = Resolve-SafeChildPath -BasePath $manifestDirectory -RelativePath $relativePath
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "Python wheel lock not found: $lockPath"
    }
    return $lockPath
}

function Read-PythonWheelLock {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    $lockPath = Resolve-PythonWheelLockPath -Component $Component -ManifestPath $ManifestPath
    $expectedLockHash = [string](Get-OptionalProperty $Component 'wheelLockSha256' '')
    if ($expectedLockHash -notmatch '^[a-fA-F0-9]{64}$' -or
        -not (Test-FileSha256 -Path $lockPath -Expected $expectedLockHash)) {
        throw "Python wheel lock SHA-256 does not match the runtime manifest."
    }
    try {
        $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Python wheel lock is not valid JSON: $($_.Exception.Message)"
    }

    if ([int](Get-OptionalProperty $lock 'schemaVersion' 0) -ne 1 -or
        [string](Get-OptionalProperty $lock 'platform' '') -ne 'win-amd64' -or
        [string](Get-OptionalProperty $lock 'runtimeVersion' '') -ne [string]$Component.version) {
        throw "Python wheel lock metadata does not match component $($Component.id)."
    }

    $python = Get-OptionalProperty $lock 'python'
    $pythonFileName = [string](Get-OptionalProperty $python 'fileName' '')
    if ([string](Get-OptionalProperty $python 'version' '') -ne '3.7.1' -or
        -not [string]::Equals([IO.Path]::GetFileName($pythonFileName), $pythonFileName, [StringComparison]::Ordinal) -or
        -not $pythonFileName.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase) -or
        [string](Get-OptionalProperty $python 'sha256' '') -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Python wheel lock contains invalid CPython base metadata.'
    }
    $pythonUrlCount = 0
    foreach ($urlValue in @(Get-OptionalProperty (Get-OptionalProperty $python 'urls') 'china' @())) {
        if (-not (Test-PythonArtifactUrl -Url ([string]$urlValue) -AllowedHosts @('mirrors.huaweicloud.com'))) {
            throw 'Python base archive contains an unapproved China download host.'
        }
        $pythonUrlCount++
    }
    foreach ($urlValue in @(Get-OptionalProperty (Get-OptionalProperty $python 'urls') 'official' @())) {
        if (-not (Test-PythonArtifactUrl -Url ([string]$urlValue) -AllowedHosts @('www.python.org'))) {
            throw 'Python base archive contains an unapproved official download host.'
        }
        $pythonUrlCount++
    }
    if ($pythonUrlCount -eq 0) {
        throw 'Python base archive has no approved HTTPS download URL.'
    }

    $artifacts = @(Get-OptionalProperty $lock 'artifacts' @())
    if ($artifacts.Count -eq 0) {
        throw 'Python wheel lock contains no package artifacts.'
    }
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $fileNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($artifact in $artifacts) {
        $name = [string](Get-OptionalProperty $artifact 'name' '')
        $version = [string](Get-OptionalProperty $artifact 'version' '')
        $fileName = [string](Get-OptionalProperty $artifact 'fileName' '')
        $kind = [string](Get-OptionalProperty $artifact 'kind' '')
        $sha256 = [string](Get-OptionalProperty $artifact 'sha256' '')
        if ($name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' -or
            [string]::IsNullOrWhiteSpace($version) -or
            -not $names.Add($name) -or
            -not [string]::Equals([IO.Path]::GetFileName($fileName), $fileName, [StringComparison]::Ordinal) -or
            -not $fileNames.Add($fileName) -or
            $sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
            $kind -notin @('wheel', 'sdist') -or
            ($kind -eq 'wheel' -and -not $fileName.EndsWith('.whl', [StringComparison]::OrdinalIgnoreCase)) -or
            ($kind -eq 'sdist' -and -not $fileName.EndsWith('.tar.gz', [StringComparison]::OrdinalIgnoreCase))) {
            throw "Python wheel lock contains invalid or duplicate artifact metadata: $name"
        }
        $urlCount = 0
        $urls = Get-OptionalProperty $artifact 'urls'
        foreach ($urlValue in @(Get-OptionalProperty $urls 'china' @())) {
            if (-not (Test-PythonArtifactUrl -Url ([string]$urlValue) -AllowedHosts @('pypi.tuna.tsinghua.edu.cn'))) {
                throw "Python artifact $name contains an unapproved China download host."
            }
            $urlCount++
        }
        foreach ($urlValue in @(Get-OptionalProperty $urls 'official' @())) {
            if (-not (Test-PythonArtifactUrl -Url ([string]$urlValue) -AllowedHosts @('files.pythonhosted.org'))) {
                throw "Python artifact $name contains an unapproved official download host."
            }
            $urlCount++
        }
        if ($urlCount -eq 0) {
            throw "Python artifact $name has no approved HTTPS download URL."
        }
    }

    foreach ($requiredTool in @(
        @{ Name = 'pip'; Version = '24.0' },
        @{ Name = 'setuptools'; Version = '65.6.3' },
        @{ Name = 'wheel'; Version = '0.38.4' },
        @{ Name = 'tensorflow-gpu'; Version = '2.10.1' }
    )) {
        $matches = @($artifacts | Where-Object {
            [string]::Equals([string]$_.name, [string]$requiredTool.Name, [StringComparison]::OrdinalIgnoreCase) -and
            [string]$_.version -eq [string]$requiredTool.Version
        })
        if ($matches.Count -ne 1) {
            throw "Python wheel lock does not contain the required $($requiredTool.Name)==$($requiredTool.Version) artifact."
        }
    }

    return [pscustomobject]@{ Path = $lockPath; Data = $lock }
}

function Assert-PythonWheelhouseMetadata {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    if ([string](Get-OptionalProperty (Get-OptionalProperty $Component 'install') 'layout' '') -ne 'python-wheelhouse') {
        throw "Python wheelhouse component $($Component.id) must use the python-wheelhouse layout."
    }
    [void](Read-PythonWheelLock -Component $Component -ManifestPath $ManifestPath)
}

function New-PythonDownloadAdapter {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][object]$Package,
        [Parameter(Mandatory = $true)][string]$NameProperty
    )

    return [pscustomobject]@{
        id = $Id
        archive = [pscustomobject]@{
            name = [string](Get-OptionalProperty $Package $NameProperty '')
            sha256 = [string](Get-OptionalProperty $Package 'sha256' '')
            urls = Get-OptionalProperty $Package 'urls'
        }
    }
}

function Invoke-PythonProcess {
    param(
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [string]$WorkingDirectory
    )

    $pushed = $false
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            Push-Location -LiteralPath $WorkingDirectory
            $pushed = $true
        }
        $ErrorActionPreference = 'Continue'
        $output = @(& $PythonPath @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($pushed) { Pop-Location }
    }
    $text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ($exitCode -ne 0) {
        $tail = @($output | Select-Object -Last 30) -join "`n"
        throw "${FailureMessage}: exit $exitCode`n$tail"
    }
    return $text
}

function Assert-PythonWheelInstallPaths {
    param(
        [Parameter(Mandatory = $true)][object[]]$Artifacts,
        [Parameter(Mandatory = $true)][hashtable]$ArtifactPaths,
        [Parameter(Mandatory = $true)][string[]]$InstallRoots
    )

    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $maximumLegacyPath = 247
    foreach ($artifact in @($Artifacts | Where-Object { [string]$_.kind -eq 'wheel' })) {
        $name = [string]$artifact.name
        $archivePath = [string]$ArtifactPaths[$name]
        $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            foreach ($entry in $zip.Entries) {
                $entryName = ([string]$entry.FullName).Replace('\', '/')
                if ([string]::IsNullOrWhiteSpace($entryName)) { continue }
                $segments = @($entryName.Split('/') | Where-Object { -not [string]::IsNullOrEmpty($_) -and $_ -ne '.' })
                if ($entryName.StartsWith('/', [StringComparison]::Ordinal) -or
                    $entryName.Contains(':') -or
                    $segments.Count -eq 0 -or
                    @($segments | Where-Object { $_ -eq '..' -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count -gt 0) {
                    throw "Python wheel $name contains an unsafe archive path: $entryName"
                }
                $relativePath = $segments -join '\'
                foreach ($installRoot in $InstallRoots) {
                    $candidateLength = $installRoot.TrimEnd('\', '/').Length + 1 + $relativePath.Length
                    if ($candidateLength -gt $maximumLegacyPath) {
                        throw "Project path is too long for the pinned Python runtime ($candidateLength characters at $entryName). Move DeepFaceLabSN to a shorter path such as D:\DeepFaceLabSN and retry."
                    }
                }
            }
        } finally {
            $zip.Dispose()
        }
    }
}

function Install-PythonWheelhouseComponent {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$WorkRoot,
        [Parameter(Mandatory = $true)][string]$CacheRoot,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    $id = [string]$Component.id
    $lockResult = Read-PythonWheelLock -Component $Component -ManifestPath $ManifestPath
    $lock = $lockResult.Data
    $safeVersion = ([string]$lock.runtimeVersion) -replace '[^a-zA-Z0-9._-]', '-'
    $wheelCache = Resolve-SafeChildPath -BasePath $CacheRoot -RelativePath ("python-wheelhouse-" + $safeVersion)
    New-Item -ItemType Directory -Path $wheelCache -Force | Out-Null

    $pythonAdapter = New-PythonDownloadAdapter -Id 'python-base' -Package $lock.python -NameProperty 'fileName'
    Write-JsonEvent -Stage 'runtime' -Id $id -Status 'preparing' -Progress 1 -Message 'Preparing verified CPython base archive (1 of package set).'
    $pythonArchive = Get-VerifiedArchive -Component $pythonAdapter -CacheRoot $wheelCache

    $artifactPaths = @{}
    $artifacts = @($lock.artifacts)
    for ($index = 0; $index -lt $artifacts.Count; $index++) {
        $artifact = $artifacts[$index]
        $progress = [int][Math]::Min(70, 2 + ((($index + 1) * 68L) / $artifacts.Count))
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'preparing' -Progress $progress -Message "Preparing pinned Python package $($index + 1) / $($artifacts.Count): $($artifact.name)==$($artifact.version)."
        $adapter = New-PythonDownloadAdapter -Id ("python-package-" + ($index + 1)) -Package $artifact -NameProperty 'fileName'
        $artifactPaths[[string]$artifact.name] = Get-VerifiedArchive -Component $adapter -CacheRoot $wheelCache
    }

    # Keep same-volume staging names deliberately short. Windows Python 3.7 and
    # older wheel installers still hit MAX_PATH even when the final project path
    # is valid if a long ".installing-<pid>-<guid>" suffix is added here.
    $token = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $targetParent = Split-Path -Parent $TargetPath
    $stagingPath = Join-Path $targetParent ('.p-' + $token)
    $backupPath = Join-Path $targetParent ('.b-' + $token)
    $pipTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $pipTemp = Resolve-SafeChildPath -BasePath $pipTempRoot -RelativePath ("dflsn-python-pip-" + $token)
    Assert-PythonWheelInstallPaths -Artifacts $artifacts -ArtifactPaths $artifactPaths -InstallRoots @($TargetPath, $stagingPath)
    foreach ($privatePath in @($stagingPath, $backupPath, $pipTemp)) {
        if (Test-Path -LiteralPath $privatePath) {
            throw "Private Python install path already exists; retry the operation: $privatePath"
        }
    }
    $backupCreated = $false
    $newTargetMoved = $false
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    New-Item -ItemType Directory -Path $pipTemp -Force | Out-Null

    $environmentNames = @('PATH', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONNOUSERSITE', 'PIP_CONFIG_FILE', 'PIP_NO_INDEX', 'PIP_DISABLE_PIP_VERSION_CHECK', 'TEMP', 'TMP')
    $previousEnvironment = @{}
    foreach ($environmentName in $environmentNames) {
        $previousEnvironment[$environmentName] = [Environment]::GetEnvironmentVariable($environmentName, 'Process')
    }

    try {
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'extracting' -Progress 72 -Message 'Extracting the verified embeddable CPython archive into staging.'
        Expand-ZipSafely -ArchivePath $pythonArchive -Destination $stagingPath -Id $id
        $pythonPath = Join-Path $stagingPath 'python.exe'
        $pthPath = Join-Path $stagingPath 'python37._pth'
        if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf) -or -not (Test-Path -LiteralPath $pthPath -PathType Leaf)) {
            throw 'The verified CPython archive is missing python.exe or python37._pth.'
        }
        New-Item -ItemType Directory -Path (Join-Path $stagingPath 'Lib\site-packages') -Force | Out-Null
        [IO.File]::WriteAllText($pthPath, "python37.zip`r`n.`r`nLib`r`nLib\site-packages`r`nimport site`r`n", $script:Utf8NoBom)

        $pathParts = New-Object 'System.Collections.Generic.List[string]'
        $pathParts.Add($stagingPath)
        $pathParts.Add((Join-Path $stagingPath 'Scripts'))
        foreach ($runtimeDirectory in @('_internal\CUDA', '_internal\CUDNN')) {
            $candidate = Join-Path $script:ModeRoot $runtimeDirectory
            if (Test-Path -LiteralPath $candidate -PathType Container) { $pathParts.Add($candidate) }
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$previousEnvironment['PATH'])) { $pathParts.Add([string]$previousEnvironment['PATH']) }
        [Environment]::SetEnvironmentVariable('PATH', ($pathParts -join ';'), 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONHOME', $null, 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $null, 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONNOUSERSITE', '1', 'Process')
        [Environment]::SetEnvironmentVariable('PIP_CONFIG_FILE', 'NUL', 'Process')
        [Environment]::SetEnvironmentVariable('PIP_NO_INDEX', '1', 'Process')
        [Environment]::SetEnvironmentVariable('PIP_DISABLE_PIP_VERSION_CHECK', '1', 'Process')
        [Environment]::SetEnvironmentVariable('TEMP', $pipTemp, 'Process')
        [Environment]::SetEnvironmentVariable('TMP', $pipTemp, 'Process')

        $bootstrapHelper = Join-Path $pipTemp 'bootstrap_pip.py'
        $helperSource = @'
import sys
bootstrap_wheel = sys.argv[1]
packages = sys.argv[2:]
sys.path.insert(0, bootstrap_wheel)
from pip._internal.cli.main import main
sys.exit(main(['install', '--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir', '--no-compile'] + packages))
'@
        [IO.File]::WriteAllText($bootstrapHelper, $helperSource, $script:Utf8NoBom)
        $toolNames = @('pip', 'setuptools', 'wheel')
        $toolPaths = @($toolNames | ForEach-Object { [string]$artifactPaths[$_] })
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'installing' -Progress 74 -Message 'Installing pinned pip, setuptools, and wheel without network access.'
        $bootstrapArguments = @($bootstrapHelper, [string]$artifactPaths['pip']) + $toolPaths
        [void](Invoke-PythonProcess -PythonPath $pythonPath -Arguments $bootstrapArguments -FailureMessage 'Python packaging bootstrap failed')

        $sdistArtifacts = @($artifacts | Where-Object { [string]$_.kind -eq 'sdist' })
        $sdistWheelPaths = @()
        if ($sdistArtifacts.Count -gt 0) {
            $sdistBuilder = Join-Path $pipTemp 'build_sdist_wheel.py'
            $sdistBuilderSource = @'
import os
import runpy
import sys
import tarfile

archive, work_root, dist_root = sys.argv[1:4]
work_root = os.path.abspath(work_root)
dist_root = os.path.abspath(dist_root)
os.makedirs(work_root, exist_ok=True)
os.makedirs(dist_root, exist_ok=True)
with tarfile.open(archive, 'r:gz') as package:
    members = package.getmembers()
    for member in members:
        name = member.name.replace('\\', '/')
        if not name or name.startswith('/') or ':' in name:
            raise RuntimeError('unsafe tar path: ' + name)
        parts = [part for part in name.split('/') if part not in ('', '.')]
        if not parts or any(part == '..' or part.endswith('.') or part.endswith(' ') for part in parts):
            raise RuntimeError('unsafe tar segment: ' + name)
        if not (member.isdir() or member.isfile()):
            raise RuntimeError('links and special tar entries are not allowed: ' + name)
        target = os.path.abspath(os.path.join(work_root, *parts))
        if os.path.commonpath([work_root, target]) != work_root:
            raise RuntimeError('tar entry escapes staging: ' + name)
    package.extractall(work_root, members=members)
roots = [
    os.path.join(work_root, name)
    for name in os.listdir(work_root)
    if os.path.isfile(os.path.join(work_root, name, 'setup.py'))
]
if len(roots) != 1:
    raise RuntimeError('sdist must contain exactly one setup.py root')
source_root = roots[0]
os.chdir(source_root)
sys.path.insert(0, source_root)
sys.argv = ['setup.py', 'bdist_wheel', '--dist-dir', dist_root]
runpy.run_path(os.path.join(source_root, 'setup.py'), run_name='__main__')
'@
            [IO.File]::WriteAllText($sdistBuilder, $sdistBuilderSource, $script:Utf8NoBom)
            for ($sdistIndex = 0; $sdistIndex -lt $sdistArtifacts.Count; $sdistIndex++) {
                $sdistArtifact = $sdistArtifacts[$sdistIndex]
                $sdistRoot = Join-Path $pipTemp ("sdist-source-" + $sdistIndex)
                $sdistOutput = Join-Path $pipTemp ("sdist-wheel-" + $sdistIndex)
                New-Item -ItemType Directory -Path $sdistRoot, $sdistOutput -Force | Out-Null
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'building' -Progress 76 -Message "Building a local wheel from verified source: $($sdistArtifact.name)==$($sdistArtifact.version)."
                [void](Invoke-PythonProcess -PythonPath $pythonPath -Arguments @($sdistBuilder, [string]$artifactPaths[[string]$sdistArtifact.name], $sdistRoot, $sdistOutput) -FailureMessage "Verified source wheel build failed for $($sdistArtifact.name)")
                $builtWheels = @(Get-ChildItem -LiteralPath $sdistOutput -Filter '*.whl' -File)
                if ($builtWheels.Count -ne 1) {
                    throw "Verified source build produced $($builtWheels.Count) wheels for $($sdistArtifact.name); expected exactly one."
                }
                $sdistWheelPaths += $builtWheels[0].FullName
            }
            $sdistInstallArguments = @('-m', 'pip', 'install', '--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir', '--no-compile') + $sdistWheelPaths
            [void](Invoke-PythonProcess -PythonPath $pythonPath -Arguments $sdistInstallArguments -FailureMessage 'Locally built Python wheel installation failed')
        }

        $requirementsPath = Join-Path $pipTemp 'wheelhouse-requirements.txt'
        $remaining = @($artifacts | Where-Object { $_.name -notin $toolNames -and [string]$_.kind -eq 'wheel' })
        [IO.File]::WriteAllLines($requirementsPath, @($remaining | ForEach-Object { [string]$_.fileName }), $script:Utf8NoBom)
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'installing' -Progress 78 -Message "Installing $($remaining.Count) verified packages offline. This can take several minutes."
        [void](Invoke-PythonProcess -PythonPath $pythonPath -Arguments @('-m', 'pip', 'install', '--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir', '--no-compile', '-r', $requirementsPath) -FailureMessage 'Offline Python package installation failed' -WorkingDirectory $wheelCache)

        $licenseRoot = Join-Path $stagingPath '_licenses'
        New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
        Copy-Item -LiteralPath $lockResult.Path -Destination (Join-Path $licenseRoot 'runtime-wheel-lock.json')
        $notice = "DeepFaceLabSN Python runtime`r`n`r`nAll package archives were downloaded from the pinned upstream URLs in runtime-wheel-lock.json and verified by SHA-256. Package metadata and license files installed by each wheel remain in Lib\site-packages. Review each package's metadata for its applicable license terms.`r`n"
        [IO.File]::WriteAllText((Join-Path $licenseRoot 'NOTICE.txt'), $notice, $script:Utf8NoBom)

        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'validating' -Progress 92 -Message 'Running Python, TensorFlow GPU-build, scientific stack, Qt, ONNX, and Win32 import checks.'
        $smokeCode = "import sys; import tensorflow as tf; import cv2, numpy, scipy, onnx, tf2onnx, win32api, future; from PyQt5 import QtCore; assert sys.version_info[:3] == (3,7,1); assert tf.__version__ == '2.10.1'; assert tf.test.is_built_with_cuda(); print('DFLSN_PYTHON_RUNTIME_OK')"
        $smokeOutput = Invoke-PythonProcess -PythonPath $pythonPath -Arguments @('-c', $smokeCode) -FailureMessage 'Python runtime import validation failed'
        if ($smokeOutput -notmatch '(?m)^DFLSN_PYTHON_RUNTIME_OK$') {
            throw "Python runtime import validation returned unexpected output: $smokeOutput"
        }

        Get-ChildItem -LiteralPath $stagingPath -File -Recurse -Force | Unblock-File -ErrorAction SilentlyContinue
        $stagingValidation = Get-ValidationResult -Component $Component -TargetPath $stagingPath
        if (-not $stagingValidation.Ready) {
            throw "Staged Python validation failed: $($stagingValidation.Reason)"
        }
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'staged' -Progress 96 -Message 'Python staging validation passed; publishing atomically.'

        if (Test-Path -LiteralPath $TargetPath -PathType Container) {
            Move-Item -LiteralPath $TargetPath -Destination $backupPath
            $backupCreated = $true
        }
        Move-Item -LiteralPath $stagingPath -Destination $TargetPath
        $newTargetMoved = $true
        $finalValidation = Get-ValidationResult -Component $Component -TargetPath $TargetPath
        if (-not $finalValidation.Ready) {
            throw "Published Python runtime failed final validation: $($finalValidation.Reason)"
        }

        if ($backupCreated) {
            try {
                Remove-SafeDirectory -Path $backupPath -AllowedRoot $targetParent
                $backupCreated = $false
            } catch {
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'backup-retained' -Progress 98 -Message "Python is ready, but the old backup was retained at $backupPath."
            }
        }
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'ready' -Progress 100 -Message "$($Component.displayName) $($Component.version) is installed and verified."
    } catch {
        $originalError = $_
        if ($newTargetMoved -and (Test-Path -LiteralPath $TargetPath -PathType Container)) {
            Remove-SafeDirectory -Path $TargetPath -AllowedRoot $targetParent -IgnoreErrors
        }
        if ($backupCreated -and (Test-Path -LiteralPath $backupPath -PathType Container)) {
            try {
                Move-Item -LiteralPath $backupPath -Destination $TargetPath
                $backupCreated = $false
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'rolled-back' -Progress 0 -Message 'Python publish failed; the previous runtime was restored.'
            } catch {
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'rollback-failed' -Progress 0 -Message "Automatic rollback failed; the previous runtime remains at $backupPath."
            }
        }
        throw $originalError
    } finally {
        foreach ($environmentName in $environmentNames) {
            [Environment]::SetEnvironmentVariable($environmentName, $previousEnvironment[$environmentName], 'Process')
        }
        Remove-SafeDirectory -Path $stagingPath -AllowedRoot $targetParent -IgnoreErrors
        Remove-SafeDirectory -Path $pipTemp -AllowedRoot $pipTempRoot -IgnoreErrors
    }
}
