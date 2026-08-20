$sourcePath = Join-Path $PSScriptRoot "..\host\WorkspaceTemplate.cs"

Describe "launcher workspace template" {
    BeforeAll {
        $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
        $source = $source.Replace("internal static class WorkspaceTemplate", "public static class WorkspaceTemplate")
        Add-Type -TypeDefinition $source
    }

    It "creates the five empty template directories without touching existing data" {
        $root = Join-Path $TestDrive "project"
        $model = Join-Path $root "workspace\model"
        New-Item -ItemType Directory -Path $model -Force | Out-Null
        $sentinel = Join-Path $model "private-model.dat"
        [IO.File]::WriteAllText($sentinel, "keep")

        $created = [DeepFaceLabSN.Launcher.WorkspaceTemplate]::Ensure($root)

        foreach ($name in @("data_src", "data_dst", "model", "xseg_model", "pretrain_faces")) {
            Test-Path -LiteralPath (Join-Path $root ("workspace\" + $name)) -PathType Container | Should Be $true
        }
        [IO.File]::ReadAllText($sentinel) | Should Be "keep"
        @($created).Count | Should Be 4
        @([DeepFaceLabSN.Launcher.WorkspaceTemplate]::Ensure($root)).Count | Should Be 0
    }

    It "refuses a conflicting file instead of overwriting it" {
        $root = Join-Path $TestDrive "conflict-project"
        $workspace = Join-Path $root "workspace"
        New-Item -ItemType Directory -Path $workspace -Force | Out-Null
        $conflict = Join-Path $workspace "data_dst"
        [IO.File]::WriteAllText($conflict, "private-data")

        { [DeepFaceLabSN.Launcher.WorkspaceTemplate]::Ensure($root) } | Should Throw
        [IO.File]::ReadAllText($conflict) | Should Be "private-data"
    }
}
