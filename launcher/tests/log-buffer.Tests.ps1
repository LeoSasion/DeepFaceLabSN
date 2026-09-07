Describe "durable launcher logs" {
    BeforeAll {
        $source = (Get-Content (Join-Path $PSScriptRoot '..\host\LogBuffer.cs') -Raw -Encoding UTF8).Replace('namespace DeepFaceLabSN.Launcher', 'namespace DurableLogTests').Replace('internal sealed class', 'public sealed class')
        Add-Type -TypeDefinition $source
    }

    It "flushes every entry, keeps errors in both logs, and survives the UI buffer limit" {
        $log = New-Object DurableLogTests.LogBuffer
        $folder = Join-Path $TestDrive 'logs'
        $log.SetDirectory($folder)
        foreach ($index in 1..2010) { $log.Add('test', "line-$index", 'info') }
        $log.Add('test', 'failure detail', 'error')
        $log.Add('test', 'warning detail', 'warning')
        $all = @(Get-ChildItem $folder -Filter '*.log' | Where-Object Name -NotLike '*.errors.log')[0]
        $errors = @(Get-ChildItem $folder -Filter '*.errors.log')[0]
        $text = [IO.File]::ReadAllText($all.FullName)
        $text | Should Match 'line-1\r?\n'
        $text | Should Match 'failure detail'
        $text | Should Match 'warning detail'
        [IO.File]::ReadAllText($errors.FullName) | Should Match 'failure detail'
        [IO.File]::ReadAllText($errors.FullName) | Should Not Match 'line-|warning detail'
        $next = Join-Path $TestDrive 'project logs'
        $log.SetDirectory($next)
        $log.Add('test', 'after move', 'info')
        $moved = [IO.File]::ReadAllText((Join-Path $next $all.Name))
        $moved | Should Match 'line-1\r?\n'
        $moved | Should Match 'after move'
    }
}
