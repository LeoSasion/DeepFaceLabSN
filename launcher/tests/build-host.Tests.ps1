$ErrorActionPreference = "Stop"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$Builder = Join-Path $RepositoryRoot "launcher\build-host.ps1"

Describe "launcher host build output safety" {
    It "preserves unrelated files and directories in a custom non-empty output directory" {
        $output = Join-Path $TestDrive "custom-output"
        $ui = Join-Path $output "ui\assets"
        $bootstrap = Join-Path $output "bootstrap"
        New-Item -ItemType Directory -Path $ui -Force | Out-Null
        New-Item -ItemType Directory -Path $bootstrap -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $output "sentinel.txt"), "keep-root")
        [IO.File]::WriteAllText((Join-Path $ui "sentinel.txt"), "keep-ui")
        [IO.File]::WriteAllText((Join-Path $bootstrap "sentinel.txt"), "keep-bootstrap")
        [IO.File]::WriteAllText((Join-Path $output "DeepFaceLabSN.Launcher.exe"), "old-launcher")

        $raw = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Builder `
            -OutputDirectory $output -SkipUiBuild -NoDownload 2>&1)
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            Write-Output ($raw -join [Environment]::NewLine)
        }

        $exitCode | Should Be 0
        [IO.File]::ReadAllText((Join-Path $output "sentinel.txt")) | Should Be "keep-root"
        [IO.File]::ReadAllText((Join-Path $ui "sentinel.txt")) | Should Be "keep-ui"
        [IO.File]::ReadAllText((Join-Path $bootstrap "sentinel.txt")) | Should Be "keep-bootstrap"
        (Get-Item -LiteralPath (Join-Path $output "DeepFaceLabSN.Launcher.exe")).Length | Should BeGreaterThan 1024
        @(Get-ChildItem -LiteralPath $output -Filter "*.publishing-*.tmp" -Force).Count | Should Be 0
        @(Get-ChildItem -LiteralPath $output -Filter "*.backup-*.tmp" -Force).Count | Should Be 0
    }
}
