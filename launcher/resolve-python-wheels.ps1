[CmdletBinding()]
param(
    [string]$RequirementsPath,
    [string]$OutputPath,
    [string]$ChinaIndex = "https://pypi.tuna.tsinghua.edu.cn/simple",
    [string]$OfficialIndex = "https://pypi.org/simple"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if ([String]::IsNullOrWhiteSpace($RequirementsPath)) {
    $RequirementsPath = Join-Path $PSScriptRoot "python-runtime\requirements-win-cp37.in"
}
if ([String]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $PSScriptRoot "python-runtime\runtime-wheel-lock.json"
}

function Normalize-PackageName {
    param([Parameter(Mandatory = $true)][string]$Name)
    return ([Regex]::Replace($Name.Trim().ToLowerInvariant(), "[-_.]+", "-"))
}

function Read-PinnedRequirements {
    param([Parameter(Mandatory = $true)][string]$Path)

    $items = New-Object 'System.Collections.Generic.List[object]'
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        if ($line -notmatch '^([A-Za-z0-9._-]+)==([^\s;]+)$') {
            throw "Requirement must be an exact name==version pin: $line"
        }
        $items.Add([PSCustomObject]@{
            Name = $matches[1]
            NormalizedName = Normalize-PackageName -Name $matches[1]
            Version = $matches[2]
        })
    }
    if ($items.Count -eq 0) {
        throw "No pinned requirements were found: $Path"
    }
    return $items.ToArray()
}

function Get-WheelPriority {
    param([Parameter(Mandatory = $true)][string]$FileName)

    if (-not $FileName.EndsWith(".whl", [StringComparison]::OrdinalIgnoreCase)) {
        return [Int32]::MaxValue
    }
    $stem = $FileName.Substring(0, $FileName.Length - 4)
    $parts = @($stem.Split('-'))
    if ($parts.Count -lt 5) {
        return [Int32]::MaxValue
    }
    $pythonTags = @($parts[$parts.Count - 3].Split('.'))
    $abiTags = @($parts[$parts.Count - 2].Split('.'))
    $platformTags = @($parts[$parts.Count - 1].Split('.'))

    $isWinAmd64 = $platformTags -contains "win_amd64"
    $isAny = $platformTags -contains "any"
    if (-not $isWinAmd64 -and -not $isAny) {
        return [Int32]::MaxValue
    }

    if ($pythonTags -contains "cp37" -and $abiTags -contains "cp37m" -and $isWinAmd64) {
        return 0
    }
    if ($pythonTags -contains "cp37" -and $abiTags -contains "abi3" -and $isWinAmd64) {
        return 2
    }
    foreach ($older in @("cp36", "cp35", "cp34", "cp33", "cp32")) {
        if ($pythonTags -contains $older -and $abiTags -contains "abi3" -and $isWinAmd64) {
            return 10
        }
    }
    $supportsPy3 = ($pythonTags -contains "py3") -or ($pythonTags -contains "py2.py3")
    if ($supportsPy3 -and $abiTags -contains "none" -and $isWinAmd64) {
        return 20
    }
    if ($supportsPy3 -and $abiTags -contains "none" -and $isAny) {
        return 30
    }
    return [Int32]::MaxValue
}

function Resolve-WheelFromIndex {
    param(
        [Parameter(Mandatory = $true)][string]$Index,
        [Parameter(Mandatory = $true)]$Requirement
    )

    $pageUri = [Uri]($Index.TrimEnd('/') + "/" + $Requirement.NormalizedName + "/")
    $response = Invoke-WebRequest -UseBasicParsing -Uri $pageUri.AbsoluteUri -TimeoutSec 45
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    foreach ($link in @($response.Links)) {
        $href = [string]$link.href
        if ([String]::IsNullOrWhiteSpace($href) -or $href -notmatch '(?i)\.whl(?:#|$)') {
            continue
        }
        $artifactUri = New-Object Uri($pageUri, $href)
        $fileName = [Uri]::UnescapeDataString([IO.Path]::GetFileName($artifactUri.AbsolutePath))
        $stem = $fileName.Substring(0, $fileName.Length - 4)
        $parts = @($stem.Split('-'))
        if ($parts.Count -lt 5 -or
            -not [String]::Equals($parts[1], $Requirement.Version, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $priority = Get-WheelPriority -FileName $fileName
        if ($priority -eq [Int32]::MaxValue) {
            continue
        }
        if ($artifactUri.Fragment -notmatch '^#sha256=([0-9a-fA-F]{64})$') {
            continue
        }
        $builder = New-Object UriBuilder($artifactUri)
        $builder.Fragment = ""
        $candidates.Add([PSCustomObject]@{
            FileName = $fileName
            Sha256 = $matches[1].ToLowerInvariant()
            Url = $builder.Uri.AbsoluteUri
            Priority = $priority
            Kind = "wheel"
        })
    }
    if ($candidates.Count -eq 0) {
        $escapedVersion = [Regex]::Escape($Requirement.Version)
        foreach ($link in @($response.Links)) {
            $href = [string]$link.href
            if ([String]::IsNullOrWhiteSpace($href) -or
                $href -notmatch ("(?i)[-_]" + $escapedVersion + "(?:\.tar\.gz|\.zip)(?:#|$)")) {
                continue
            }
            $artifactUri = New-Object Uri($pageUri, $href)
            if ($artifactUri.Fragment -notmatch '^#sha256=([0-9a-fA-F]{64})$') {
                continue
            }
            $builder = New-Object UriBuilder($artifactUri)
            $builder.Fragment = ""
            $candidates.Add([PSCustomObject]@{
                FileName = [Uri]::UnescapeDataString([IO.Path]::GetFileName($artifactUri.AbsolutePath))
                Sha256 = $matches[1].ToLowerInvariant()
                Url = $builder.Uri.AbsoluteUri
                Priority = 1000
                Kind = "sdist"
            })
        }
    }
    $selected = @($candidates | Sort-Object Priority, FileName | Select-Object -First 1)
    if ($selected.Count -ne 1) {
        throw "No compatible cp37 artifact found for $($Requirement.Name)==$($Requirement.Version) at $pageUri"
    }
    return $selected[0]
}

$requirementsFull = [IO.Path]::GetFullPath($RequirementsPath)
$outputFull = [IO.Path]::GetFullPath($OutputPath)
$requirements = @(Read-PinnedRequirements -Path $requirementsFull)
$artifacts = New-Object 'System.Collections.Generic.List[object]'

foreach ($requirement in $requirements) {
    Write-Host "[python-lock] Resolving $($requirement.Name)==$($requirement.Version)..."
    $china = $null
    try {
        $china = Resolve-WheelFromIndex -Index $ChinaIndex -Requirement $requirement
    } catch {
        Write-Warning "China mirror resolution failed for $($requirement.Name): $($_.Exception.Message)"
    }

    $official = $null
    if ($null -ne $china -and $china.Url -match '^https://pypi\.tuna\.tsinghua\.edu\.cn/packages/') {
        $officialUrl = $china.Url -replace '^https://pypi\.tuna\.tsinghua\.edu\.cn', 'https://files.pythonhosted.org'
        $official = [PSCustomObject]@{
            FileName = $china.FileName
            Sha256 = $china.Sha256
            Url = $officialUrl
            Priority = $china.Priority
            Kind = $china.Kind
        }
    } else {
        $official = Resolve-WheelFromIndex -Index $OfficialIndex -Requirement $requirement
    }

    if ($null -ne $china -and
        (-not [String]::Equals($china.FileName, $official.FileName, [StringComparison]::Ordinal) -or
         -not [String]::Equals($china.Sha256, $official.Sha256, [StringComparison]::OrdinalIgnoreCase))) {
        throw "China and official wheel identities differ for $($requirement.Name)."
    }

    $artifacts.Add([ordered]@{
        name = $requirement.Name
        version = $requirement.Version
        fileName = $official.FileName
        sha256 = $official.Sha256
        kind = $official.Kind
        urls = [ordered]@{
            china = @($(if ($null -eq $china) { @() } else { @($china.Url) }))
            official = @($official.Url)
        }
    })
}

$lock = [ordered]@{
    schemaVersion = 1
    runtimeVersion = "3.7.1-tf-gpu-2.10.1-wheelhouse-v1"
    platform = "win-amd64"
    python = [ordered]@{
        version = "3.7.1"
        fileName = "python-3.7.1-embed-amd64.zip"
        sha256 = "c9e6ff79b0b9baa948e3819334d70fdc9ce2b195dc4948c9d668334ab4ff244e"
        urls = [ordered]@{
            china = @()
            official = @("https://www.python.org/ftp/python/3.7.1/python-3.7.1-embed-amd64.zip")
        }
    }
    requirements = [IO.Path]::GetFileName($requirementsFull)
    artifacts = $artifacts.ToArray()
}

$outputDirectory = Split-Path -Parent $outputFull
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$json = $lock | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($outputFull, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
Write-Host "[python-lock] Wrote $($artifacts.Count) pinned wheels to $outputFull"
