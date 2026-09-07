[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$moduleRoot = Join-Path $repositoryRoot "launcher\vendor\PowerShellModules"
$manifest = Join-Path $moduleRoot "Pester\4.10.1\Pester.psd1"

if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    New-Item -ItemType Directory -Path $moduleRoot -Force | Out-Null
    # Save outside PSModulePath: preinstalled Pester versions and certificate
    # chains cannot interfere. Do not change PSGallery trust or skip signatures.
    Save-Module -Name Pester -RequiredVersion 4.10.1 -Repository PSGallery -Path $moduleRoot -Force
}
$module = Test-ModuleManifest -Path $manifest
if ($module.Version -ne [Version]"4.10.1") {
    throw "Expected project-local Pester 4.10.1."
}
Write-Host "Project-local Pester 4.10.1 is ready: $manifest"
