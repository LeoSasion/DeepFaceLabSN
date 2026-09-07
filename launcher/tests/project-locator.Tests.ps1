$sourcePath = Join-Path $PSScriptRoot "..\host\ProjectLocator.cs"

Describe "first-install destination selection" {
    BeforeAll {
        # Keep fixture types separate from other launcher test assemblies.
        $source = (Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8).Replace(
            "namespace DeepFaceLabSN.Launcher", "namespace InstallPathTests")
        $source = $source.Replace("internal static class ProjectLocator", "public static class ProjectLocator")
        $source += 'namespace InstallPathTests { public class LauncherSettings { public string ProjectRoot { get; set; } } }'
        Add-Type -TypeDefinition $source
    }

    function New-TestProject([string]$Path) {
        foreach ($part in @('.git', 'webui', '_internal')) {
            New-Item -ItemType Directory -Path (Join-Path $Path $part) -Force | Out-Null
        }
    }

    It "resumes an owned install workspace without adding another folder" {
        $project = Join-Path $TestDrive 'resume'
        $state = [InstallPathTests.ProjectLocator]::PrepareInstallWorkspace($project)
        New-Item -ItemType Directory -Path (Join-Path $state 'runtime'), (Join-Path $state 'logs') -Force | Out-Null
        [InstallPathTests.ProjectLocator]::SelectInstallPath($project) | Should Be $project
        [InstallPathTests.ProjectLocator]::AssertInstallTarget($project)
        [IO.File]::WriteAllText((Join-Path $project 'personal.txt'), 'keep')
        { [InstallPathTests.ProjectLocator]::AssertInstallTarget($project) } | Should Throw
    }

    It "publishes a clone alongside runtime and logs, preserving their contents" {
        $project = Join-Path $TestDrive 'publish'
        $state = [InstallPathTests.ProjectLocator]::PrepareInstallWorkspace($project)
        $staging = Join-Path $state 'cloning-fixture'
        New-TestProject $staging
        [IO.File]::WriteAllText((Join-Path $state 'install.log'), 'keep log')
        [IO.File]::WriteAllText((Join-Path $staging 'README.md'), 'source')
        [InstallPathTests.ProjectLocator]::PublishClone($staging, $project)
        [InstallPathTests.ProjectLocator]::IsProject($project) | Should Be $true
        [IO.File]::ReadAllText((Join-Path $state 'install.log')) | Should Be 'keep log'
        [IO.File]::ReadAllText((Join-Path $project 'README.md')) | Should Be 'source'
    }

    It "rejects a cloned tree that collides with installer state before moving files" {
        $project = Join-Path $TestDrive 'publish-conflict'
        $state = [InstallPathTests.ProjectLocator]::PrepareInstallWorkspace($project)
        $staging = Join-Path $state 'cloning-fixture'
        New-TestProject $staging
        New-Item -ItemType Directory -Path (Join-Path $staging '.launcher-install') | Out-Null
        { [InstallPathTests.ProjectLocator]::PublishClone($staging, $project) } | Should Throw
        Test-Path (Join-Path $project '.git') | Should Be $false
        Test-Path (Join-Path $staging '.git') | Should Be $true
    }

    It "uses an empty selected folder directly and does not create anything" {
        $selected = Join-Path $TestDrive 'empty folder'
        New-Item -ItemType Directory -Path $selected | Out-Null
        [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) | Should Be $selected
        @(Get-ChildItem -LiteralPath $selected -Force).Count | Should Be 0
    }

    It "uses a new explicit folder directly" {
        $selected = Join-Path $TestDrive 'new-folder'
        [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) | Should Be $selected
        Test-Path -LiteralPath $selected | Should Be $false
    }

    It "puts drive-root installs in DFL-WEBUI without writing to the drive" {
        $drive = [IO.Path]::GetPathRoot($TestDrive)
        $destination = Join-Path $drive 'DFL-WEBUI'
        # Use a read-only call on the host drive; unrelated content must be refused.
        if ((Test-Path -LiteralPath $destination) -and
            -not [InstallPathTests.ProjectLocator]::IsEmptyDirectory($destination) -and
            -not [InstallPathTests.ProjectLocator]::IsProject($destination)) {
            { [InstallPathTests.ProjectLocator]::SelectInstallPath($drive) } | Should Throw
        } else {
            [InstallPathTests.ProjectLocator]::SelectInstallPath($drive) | Should Be $destination
        }
    }

    It "counts a single hidden file as non-empty and preserves it" {
        $selected = Join-Path $TestDrive 'occupied'
        New-Item -ItemType Directory -Path $selected | Out-Null
        $sentinel = Join-Path $selected 'sentinel.txt'
        [IO.File]::WriteAllText($sentinel, 'keep')
        [IO.File]::SetAttributes($sentinel, [IO.FileAttributes]::Hidden)
        [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) | Should Be (Join-Path $selected 'DFL-WEBUI')
        [IO.File]::ReadAllText($sentinel) | Should Be 'keep'
        Test-Path -LiteralPath (Join-Path $selected 'DFL-WEBUI') | Should Be $false
    }

    It "counts subdirectories and reuses an existing empty target without nesting" {
        $selected = Join-Path $TestDrive 'parent'
        $destination = Join-Path $selected 'DFL-WEBUI'
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) | Should Be $destination
        [InstallPathTests.ProjectLocator]::SelectInstallPath($destination) | Should Be $destination
    }

    It "reuses projects directly and under the selected parent" {
        $selected = Join-Path $TestDrive 'existing'
        $destination = Join-Path $selected 'DFL-WEBUI'
        New-TestProject $destination
        [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) | Should Be $destination
        [InstallPathTests.ProjectLocator]::SelectInstallPath($destination) | Should Be $destination
        $settings = New-Object InstallPathTests.LauncherSettings
        $settings.ProjectRoot = $destination
        [InstallPathTests.ProjectLocator]::Resolve($settings) | Should Be $destination
    }

    It "refuses an occupied target, files, and changes made after selection" {
        $selected = Join-Path $TestDrive 'conflict'
        $destination = Join-Path $selected 'DFL-WEBUI'
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) | Should Be $destination
        $file = Join-Path $destination 'keep.txt'
        [IO.File]::WriteAllText($file, 'keep')
        { [InstallPathTests.ProjectLocator]::SelectInstallPath($selected) } | Should Throw
        { [InstallPathTests.ProjectLocator]::SelectInstallPath($destination) } | Should Throw
        { [InstallPathTests.ProjectLocator]::SelectInstallPath($file) } | Should Throw
        { [InstallPathTests.ProjectLocator]::AssertInstallTarget($destination) } | Should Throw
        [IO.File]::ReadAllText($file) | Should Be 'keep'
    }
}
