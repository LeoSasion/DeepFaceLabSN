Describe "installed launcher preservation" {
    BeforeAll {
        $source = (Get-Content (Join-Path $PSScriptRoot '..\host\LauncherInstallation.cs') -Raw -Encoding UTF8).Replace('namespace DeepFaceLabSN.Launcher', 'namespace InstallExeTests').Replace('internal static class', 'public static class')
        $source += 'namespace InstallExeTests { public class LogBuffer { public void Add(string channel, string line, string level) {} } }'
        Add-Type -TypeDefinition $source
    }

    It "copies and verifies the renamed executable before removing the original" {
        $original = Join-Path $TestDrive 'download.exe'
        $project = Join-Path $TestDrive 'installed'
        [IO.File]::WriteAllText($original, 'executable-fixture')
        $target = [InstallExeTests.LauncherInstallation]::CopyVerified($original, $project)
        $target | Should Be (Join-Path $project 'DeepFaceLab-WEBUI.exe')
        Test-Path $original | Should Be $true
        $hash = [InstallExeTests.LauncherInstallation]::Hash($original)
        [InstallExeTests.LauncherInstallation]::DeleteVerifiedSource($original, $target, $hash)
        Test-Path $original | Should Be $false
        [IO.File]::ReadAllText($target) | Should Be 'executable-fixture'
        { [InstallExeTests.LauncherInstallation]::DeleteVerifiedSource($target, $target, $hash) } | Should Throw
    }

    It "preserves both files on a name collision or a changed original" {
        $original = Join-Path $TestDrive 'other.exe'
        $project = Join-Path $TestDrive 'conflict'
        [IO.File]::WriteAllText($original, 'version-one')
        $target = [InstallExeTests.LauncherInstallation]::CopyVerified($original, $project)
        $hash = [InstallExeTests.LauncherInstallation]::Hash($original)
        [IO.File]::WriteAllText($original, 'version-two')
        { [InstallExeTests.LauncherInstallation]::CopyVerified($original, $project) } | Should Throw
        { [InstallExeTests.LauncherInstallation]::DeleteVerifiedSource($original, $target, $hash) } | Should Throw
        [IO.File]::ReadAllText($original) | Should Be 'version-two'
        [IO.File]::ReadAllText($target) | Should Be 'version-one'
    }

    It "hands off to the installed process before deleting the original executable" {
        $fixture = Join-Path $TestDrive 'process-fixture'
        New-Item -ItemType Directory -Path $fixture | Out-Null
        $program = @'
using System;
using System.IO;
using System.Threading;
namespace DeepFaceLabSN.Launcher {
    internal static class TestProgram {
        [STAThread] static int Main(string[] args) {
            string original = Environment.GetEnvironmentVariable("DFL_INSTALL_SOURCE");
            LauncherInstallation.Initialize();
            LogBuffer logs = new LogBuffer();
            if (LauncherInstallation.Pending) {
                LauncherInstallation.CompleteStartup(logs);
                for (int index = 0; index < 100; index++) {
                    if (!File.Exists(original)) {
                        File.WriteAllText(Path.Combine(Environment.CurrentDirectory, "handoff-complete.txt"), "ready");
                        return 0;
                    }
                    Thread.Sleep(100);
                }
                return 4;
            }
            return LauncherInstallation.RelocateAsync(args[0], logs).GetAwaiter().GetResult() ? 0 : 5;
        }
    }
}
'@
        $programPath = Join-Path $fixture 'Program.cs'
        [IO.File]::WriteAllText($programPath, $program)
        $exe = Join-Path $fixture 'download.exe'
        $project = Join-Path $fixture 'project with spaces'
        $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        & $compiler /nologo /target:winexe "/out:$exe" $programPath (Join-Path $PSScriptRoot '..\host\LauncherInstallation.cs') (Join-Path $PSScriptRoot '..\host\LogBuffer.cs')
        $LASTEXITCODE | Should Be 0
        $process = Start-Process -FilePath $exe -ArgumentList ('"' + $project + '"') -WindowStyle Hidden -PassThru
        try {
            if (-not $process.WaitForExit(20000)) { throw 'Relocation fixture did not acknowledge startup.' }
            $process.ExitCode | Should Be 0
            $complete = Join-Path $project 'handoff-complete.txt'
            foreach ($attempt in 1..50) {
                if (Test-Path $complete) { break }
                Start-Sleep -Milliseconds 100
            }
            $complete | Should Exist
            $exe | Should Not Exist
            (Join-Path $project 'DeepFaceLab-WEBUI.exe') | Should Exist
        } finally {
            if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
            $process.Dispose()
        }
    }
}
