[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pesterManifest = Join-Path $repositoryRoot "launcher\vendor\PowerShellModules\Pester\4.10.1\Pester.psd1"
if (-not (Test-Path -LiteralPath $pesterManifest -PathType Leaf)) {
    throw "Project-local Pester 4.10.1 is missing. Run tools\prepare-launcher-tests.ps1 first."
}
Import-Module -Name $pesterManifest -Force -ErrorAction Stop
$pesterCommand = Get-Command Invoke-Pester -ErrorAction Stop
if ($pesterCommand.Module.Version -ne [Version]"4.10.1") {
    throw "Launcher tests require Pester 4.10.1."
}
$testsRoot = Join-Path $repositoryRoot "launcher\tests"
$result = Invoke-Pester -Script $testsRoot -PassThru -Show Failed,Summary
if ($null -eq $result -or $result.TotalCount -eq 0 -or $result.FailedCount -ne 0) {
    throw "Launcher Pester tests failed."
}
Write-Host "Launcher Pester tests passed: $($result.PassedCount)/$($result.TotalCount)"
