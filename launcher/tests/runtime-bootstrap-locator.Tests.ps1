$sourcePath = Join-Path $PSScriptRoot "..\host\RuntimeBootstrapLocator.cs"

Describe "runtime bootstrap resource selection" {
    BeforeAll {
        Add-Type -Path $sourcePath
        $script:locatorType = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
            $_.GetType("DeepFaceLabSN.Launcher.RuntimeBootstrapLocator", $false)
        } | Where-Object { $null -ne $_ })[0]
        if ($null -eq $script:locatorType) { throw "RuntimeBootstrapLocator type was not loaded." }
        $script:resolveMethod = $script:locatorType.GetMethod("Resolve", [Reflection.BindingFlags]"Public,Static")
    }

    function New-CompleteBootstrapRoot {
        param(
            [string]$Path,
            [string]$ManifestVersion = "2026.08.20.4"
        )
        foreach ($relative in @(
            "bootstrap.ps1",
            "runtime-manifest.json",
            "runtime-artifacts.ps1",
            "python-wheelhouse.ps1",
            "python-runtime\runtime-wheel-lock.json",
            "python-runtime\requirements-win-cp37.in"
        )) {
            $file = Join-Path $Path $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
            [IO.File]::WriteAllText($file, $relative)
        }
        [IO.File]::WriteAllText(
            (Join-Path $Path "runtime-manifest.json"),
            ('{"manifestVersion":"' + $ManifestVersion + '"}'))
        return $Path    }

    function Resolve-BootstrapFixture {
        param([string]$ProjectRoot, [string]$EmbeddedRoot)
        return $script:resolveMethod.Invoke($null, @($ProjectRoot, $EmbeddedRoot))
    }

    It "uses embedded resources when a legacy checkout has no launcher directory" {
        $project = Join-Path $TestDrive "legacy-project"
        $embedded = New-CompleteBootstrapRoot (Join-Path $TestDrive "embedded")
        New-Item -ItemType Directory -Path $project | Out-Null

        $result = Resolve-BootstrapFixture -ProjectRoot $project -EmbeddedRoot $embedded
        $result.Embedded | Should Be $true
        $result.ScriptPath | Should Be (Join-Path $embedded "bootstrap.ps1")
        $result.ManifestPath | Should Be (Join-Path $embedded "runtime-manifest.json")
    }

    It "does not select a partially copied project bootstrap" {
        $project = Join-Path $TestDrive "partial-project"
        $projectLauncher = Join-Path $project "launcher"
        $embedded = New-CompleteBootstrapRoot (Join-Path $TestDrive "embedded-complete")
        New-Item -ItemType Directory -Path $projectLauncher -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $projectLauncher "bootstrap.ps1"), "partial")

        $result = Resolve-BootstrapFixture -ProjectRoot $project -EmbeddedRoot $embedded
        $result.Embedded | Should Be $true
    }

    It "prefers a complete project bootstrap for future source updates" {
        $project = Join-Path $TestDrive "current-project"
        $projectLauncher = New-CompleteBootstrapRoot (Join-Path $project "launcher") "2026.08.20.5"
        $embedded = New-CompleteBootstrapRoot (Join-Path $TestDrive "embedded-fallback") "2026.08.20.4"

        $result = Resolve-BootstrapFixture -ProjectRoot $project -EmbeddedRoot $embedded
        $result.Embedded | Should Be $false
        $result.RootPath | Should Be $projectLauncher
    }

    It "uses newer embedded resources when the checkout still has an older manifest" {
        $project = Join-Path $TestDrive "old-project"
        New-CompleteBootstrapRoot (Join-Path $project "launcher") "2026.08.20.3" | Out-Null
        $embedded = New-CompleteBootstrapRoot (Join-Path $TestDrive "new-embedded") "2026.08.20.4"

        $result = Resolve-BootstrapFixture -ProjectRoot $project -EmbeddedRoot $embedded
        $result.Embedded | Should Be $true
        $result.RootPath | Should Be $embedded
    }
}
