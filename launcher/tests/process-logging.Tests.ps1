Describe "process error log classification" {
    BeforeAll {
        $log = Get-Content (Join-Path $PSScriptRoot '..\host\LogBuffer.cs') -Raw -Encoding UTF8
        $runner = Get-Content (Join-Path $PSScriptRoot '..\host\ProcessRunner.cs') -Raw -Encoding UTF8
        $runner = [regex]::Replace($runner, '(?m)^using [^;]+;\r?\n', '')
        $source = ('using System.Diagnostics; using System.Threading.Tasks;' + $log + $runner).Replace('namespace DeepFaceLabSN.Launcher', 'namespace ProcessLogTests').Replace('internal sealed class', 'public sealed class')
        Add-Type -TypeDefinition $source
    }

    It "keeps successful stderr progress out of the error log and records failed process output" {
        $log = New-Object ProcessLogTests.LogBuffer
        $folder = Join-Path $TestDrive 'process-logs'
        $log.SetDirectory($folder)
        $runner = New-Object ProcessLogTests.ProcessRunner($log)
        $task = $runner.RunAsync($env:COMSPEC, '/d /c "echo normal-progress 1>&2 & exit /b 0"', $TestDrive, $null, 'test')
        $task.GetAwaiter().GetResult().ExitCode | Should Be 0
        $errors = @(Get-ChildItem $folder -Filter '*.errors.log')[0]
        [IO.File]::ReadAllText($errors.FullName) | Should Be ''
        $task = $runner.RunAsync($env:COMSPEC, '/d /c "echo failure-detail & exit /b 7"', $TestDrive, $null, 'test')
        $task.GetAwaiter().GetResult().ExitCode | Should Be 7
        [IO.File]::ReadAllText($errors.FullName) | Should Match 'failure-detail'
        [IO.File]::ReadAllText($errors.FullName) | Should Not Match 'normal-progress'
    }
}
