$ErrorActionPreference = "Stop"

$sourcePath = Join-Path $PSScriptRoot "..\host\LauncherUpdateFileSystem.cs"

Describe "launcher self-update file replacement" {
    BeforeAll {
        $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
        $source = $source.Replace(
            "internal static class LauncherUpdateFileSystem",
            "public static class LauncherUpdateFileSystem")
        Add-Type -TypeDefinition $source
    }

    It "atomically publishes a verified replacement and can restore the backup" {
        $directory = Join-Path $TestDrive "replace"
        New-Item -ItemType Directory -Path $directory | Out-Null
        $target = Join-Path $directory "launcher.exe"
        $staging = Join-Path $directory "launcher.updating.tmp"
        $backup = Join-Path $directory "launcher.previous.exe"
        [IO.File]::WriteAllText($target, "old-launcher")
        [IO.File]::WriteAllText($staging, "new-launcher")
        $oldHash = [DeepFaceLabSN.Launcher.LauncherUpdateFileSystem]::ComputeFileSha256($target)

        [DeepFaceLabSN.Launcher.LauncherUpdateFileSystem]::ReplaceWithBackup(
            $staging, $target, $backup, $oldHash)

        [IO.File]::ReadAllText($target) | Should Be "new-launcher"
        [IO.File]::ReadAllText($backup) | Should Be "old-launcher"
        Test-Path -LiteralPath $staging | Should Be $false

        [DeepFaceLabSN.Launcher.LauncherUpdateFileSystem]::RestoreBackup($target, $backup)
        [IO.File]::ReadAllText($target) | Should Be "old-launcher"
        Test-Path -LiteralPath $backup | Should Be $false
    }

    It "refuses to replace a target whose hash changed" {
        $directory = Join-Path $TestDrive "changed"
        New-Item -ItemType Directory -Path $directory | Out-Null
        $target = Join-Path $directory "launcher.exe"
        $staging = Join-Path $directory "launcher.updating.tmp"
        $backup = Join-Path $directory "launcher.previous.exe"
        [IO.File]::WriteAllText($target, "changed-launcher")
        [IO.File]::WriteAllText($staging, "new-launcher")

        { [DeepFaceLabSN.Launcher.LauncherUpdateFileSystem]::ReplaceWithBackup(
            $staging, $target, $backup,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") } | Should Throw

        [IO.File]::ReadAllText($target) | Should Be "changed-launcher"
        [IO.File]::ReadAllText($staging) | Should Be "new-launcher"
        Test-Path -LiteralPath $backup | Should Be $false
    }
}
