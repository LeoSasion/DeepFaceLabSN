[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$testsRoot = Join-Path $repositoryRoot "launcher\tests"
$result = Invoke-Pester -Script $testsRoot -PassThru -Quiet
if ($null -eq $result -or $result.FailedCount -ne 0) {
    throw "Launcher Pester tests failed."
}
Write-Host "Launcher Pester tests passed: $($result.PassedCount)/$($result.TotalCount)"
