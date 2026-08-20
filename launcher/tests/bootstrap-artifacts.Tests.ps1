$ErrorActionPreference = "Stop"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$Bootstrap = Join-Path $RepositoryRoot "launcher\bootstrap.ps1"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-FixtureProject {
    param([string]$Path)

    foreach ($directory in @("_internal\installers", "_internal\multi", "launcher", "webui")) {
        New-Item -ItemType Directory -Path (Join-Path $Path $directory) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $Path "_internal\multi\sentinel.txt"), "preserve-me", (New-Object Text.UTF8Encoding($false)))
}

function New-FixtureZip {
    param(
        [string]$Path,
        [hashtable]$Entries
    )

    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entryName in $Entries.Keys) {
            $entry = $zip.CreateEntry($entryName)
            $writer = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
            try { $writer.Write([string]$Entries[$entryName]) } finally { $writer.Dispose() }
        }
    } finally {
        $zip.Dispose()
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-FixtureArtifact {
    param(
        [string]$Id,
        [string]$Name,
        [string]$Sha256,
        [string]$ArchiveRoot,
        [object[]]$Files,
        [object[]]$Notices = @()
    )

    return [ordered]@{
        id = $Id
        name = $Name
        format = "zip"
        sha256 = $Sha256
        urls = [ordered]@{ china = @(); official = @("https://example.invalid/$Name") }
        archiveRoot = $ArchiveRoot
        files = $Files
        notices = $Notices
    }
}

function Write-FixtureManifest {
    param(
        [string]$Path,
        [object[]]$Artifacts,
        [object[]]$ValidationFiles,
        [object]$ValidationCommand = $null
    )

    $validation = [ordered]@{ files = $ValidationFiles }
    if ($null -ne $ValidationCommand) { $validation.command = $ValidationCommand }
    $manifest = [ordered]@{
        schemaVersion = 2
        manifestVersion = "fixture"
        components = @([ordered]@{
            id = "multi"
            displayName = "Multi fixture"
            required = $true
            available = $true
            version = "1"
            license = [ordered]@{ name = "fixture"; reviewStatus = "official-upstream-download"; notice = "test only" }
            artifacts = $Artifacts
            install = [ordered]@{ relativePath = "_internal/multi"; layout = "merge-files"; requiredFreeBytes = 1048576 }
            validation = $validation
        })
    }
    [IO.File]::WriteAllText($Path, ($manifest | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
}

function Invoke-ArtifactBootstrapProcess {
    param(
        [string]$Project,
        [string]$Manifest
    )

    $output = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Bootstrap `
        -ProjectRoot $Project -ManifestPath $Manifest -Mirror official -NoNetwork 2>&1)
    $exitCode = $LASTEXITCODE
    $events = @()
    foreach ($line in $output) {
        if (-not [string]::IsNullOrWhiteSpace([string]$line)) {
            $events += ([string]$line | ConvertFrom-Json)
        }
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Events = $events; Raw = $output }
}

Describe "multi-artifact runtime installation" {
    It "merges only selected files and notices, then atomically replaces the old target" {
        $project = Join-Path $TestDrive "merge"
        New-FixtureProject -Path $project
        $aPath = Join-Path $project "_internal\installers\a.zip"
        $bPath = Join-Path $project "_internal\installers\b.zip"
        $aSha = New-FixtureZip -Path $aPath -Entries @{ "a-root/bin/a.dll" = "A"; "a-root/LICENSE" = "license-a"; "a-root/bin/not-selected.dll" = "no" }
        $bSha = New-FixtureZip -Path $bPath -Entries @{ "b-root/bin/b.dll" = "B"; "b-root/LICENSE" = "license-b" }
        $artifacts = @(
            (New-FixtureArtifact -Id "a" -Name "a.zip" -Sha256 $aSha -ArchiveRoot "a-root" `
                -Files @([ordered]@{ source = "bin/a.dll"; target = "a.dll" }) `
                -Notices @([ordered]@{ source = "LICENSE"; target = "_licenses/a-LICENSE.txt" })),
            (New-FixtureArtifact -Id "b" -Name "b.zip" -Sha256 $bSha -ArchiveRoot "b-root" `
                -Files @([ordered]@{ source = "bin/b.dll"; target = "b.dll" }) `
                -Notices @([ordered]@{ source = "LICENSE"; target = "_licenses/b-LICENSE.txt" }))
        )
        $manifest = Join-Path $project "manifest.json"
        Write-FixtureManifest -Path $manifest -Artifacts $artifacts -ValidationFiles @(
            [ordered]@{ path = "a.dll"; minBytes = 1 },
            [ordered]@{ path = "b.dll"; minBytes = 1 }
        )

        $result = Invoke-ArtifactBootstrapProcess -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 0
        (Join-Path $project "_internal\multi\a.dll") | Should Exist
        (Join-Path $project "_internal\multi\b.dll") | Should Exist
        (Join-Path $project "_internal\multi\_licenses\a-LICENSE.txt") | Should Exist
        (Join-Path $project "_internal\multi\bin\not-selected.dll") | Should Not Exist
        (Join-Path $project "_internal\multi\sentinel.txt") | Should Not Exist
        @(Get-ChildItem -LiteralPath (Join-Path $project "_internal") -Filter "multi.installing-*" -Force).Count | Should Be 0
        @(Get-ChildItem -LiteralPath (Join-Path $project "_internal") -Filter "multi.backup-*" -Force).Count | Should Be 0
    }

    It "skips an unselected entry whose extracted path exceeds legacy Windows limits" {
        $project = Join-Path $TestDrive "long-unselected"
        New-FixtureProject -Path $project
        $archive = Join-Path $project "_internal\installers\long.zip"
        $longDoc = "root/doc/" + (("CounterDataImage_CalculateScratchBufferSize_Params_" * 7)) + ".html"
        $entries = @{}
        $entries["root/bin/required.dll"] = "required"
        $entries[$longDoc] = "documentation that must not be extracted"
        $sha = New-FixtureZip -Path $archive -Entries $entries
        $artifact = New-FixtureArtifact -Id "long" -Name "long.zip" -Sha256 $sha -ArchiveRoot "root" `
            -Files @([ordered]@{ source = "bin/required.dll"; target = "required.dll" })
        $manifest = Join-Path $project "manifest.json"
        Write-FixtureManifest -Path $manifest -Artifacts @($artifact) -ValidationFiles @([ordered]@{ path = "required.dll"; minBytes = 1 })

        $result = Invoke-ArtifactBootstrapProcess -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 0
        (Join-Path $project "_internal\multi\required.dll") | Should Exist
        (Join-Path $project "_internal\multi\doc") | Should Not Exist
    }

    It "rejects duplicate destination mappings before download or replacement" {
        $project = Join-Path $TestDrive "collision"
        New-FixtureProject -Path $project
        $dummySha = "0" * 64
        $artifacts = @(
            (New-FixtureArtifact -Id "a" -Name "a.zip" -Sha256 $dummySha -ArchiveRoot "a" -Files @([ordered]@{ source = "bin/a.dll"; target = "same.dll" })),
            (New-FixtureArtifact -Id "b" -Name "b.zip" -Sha256 $dummySha -ArchiveRoot "b" -Files @([ordered]@{ source = "bin/b.dll"; target = "same.dll" }))
        )
        $manifest = Join-Path $project "manifest.json"
        Write-FixtureManifest -Path $manifest -Artifacts $artifacts -ValidationFiles @([ordered]@{ path = "same.dll"; minBytes = 1 })

        $result = Invoke-ArtifactBootstrapProcess -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        [IO.File]::ReadAllText((Join-Path $project "_internal\multi\sentinel.txt")) | Should Be "preserve-me"
        (@($result.Events | Where-Object { $_.id -eq "fatal" })[0].message) | Should Match "maps more than one file"
    }

    It "rejects a missing selected source without touching the old target" {
        $project = Join-Path $TestDrive "missing"
        New-FixtureProject -Path $project
        $archive = Join-Path $project "_internal\installers\missing.zip"
        $sha = New-FixtureZip -Path $archive -Entries @{ "root/bin/other.dll" = "other" }
        $artifact = New-FixtureArtifact -Id "missing" -Name "missing.zip" -Sha256 $sha -ArchiveRoot "root" `
            -Files @([ordered]@{ source = "bin/required.dll"; target = "required.dll" })
        $manifest = Join-Path $project "manifest.json"
        Write-FixtureManifest -Path $manifest -Artifacts @($artifact) -ValidationFiles @([ordered]@{ path = "required.dll"; minBytes = 1 })

        $result = Invoke-ArtifactBootstrapProcess -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        [IO.File]::ReadAllText((Join-Path $project "_internal\multi\sentinel.txt")) | Should Be "preserve-me"
        (Join-Path $project "_internal\multi\required.dll") | Should Not Exist
    }

    It "rolls back after a post-publish validation failure" {
        $project = Join-Path $TestDrive "rollback"
        New-FixtureProject -Path $project
        $archive = Join-Path $project "_internal\installers\rollback.zip"
        $checker = "@echo off`r`necho %~dp0| findstr /i .installing- >nul`r`nif errorlevel 1 (echo invalid) else (echo ok)`r`n"
        $sha = New-FixtureZip -Path $archive -Entries @{ "root/bin/check.cmd" = $checker }
        $artifact = New-FixtureArtifact -Id "rollback" -Name "rollback.zip" -Sha256 $sha -ArchiveRoot "root" `
            -Files @([ordered]@{ source = "bin/check.cmd"; target = "check.cmd" })
        $manifest = Join-Path $project "manifest.json"
        Write-FixtureManifest -Path $manifest -Artifacts @($artifact) `
            -ValidationFiles @([ordered]@{ path = "check.cmd"; minBytes = 1 }) `
            -ValidationCommand ([ordered]@{ path = "check.cmd"; arguments = @(); outputRegex = "^ok$" })

        $result = Invoke-ArtifactBootstrapProcess -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        [IO.File]::ReadAllText((Join-Path $project "_internal\multi\sentinel.txt")) | Should Be "preserve-me"
        (Join-Path $project "_internal\multi\check.cmd") | Should Not Exist
        @($result.Events | Where-Object { $_.id -eq "multi" -and $_.status -eq "rolled-back" }).Count | Should Be 1
    }
}
