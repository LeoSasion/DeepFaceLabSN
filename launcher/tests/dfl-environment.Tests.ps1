$sourcePath = Join-Path $PSScriptRoot "..\host\DflEnvironment.cs"

Describe "DFL environment output parsing" {
    BeforeAll {
        $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
        $source = $source.Replace("internal static class DflEnvironment", "public static class DflEnvironment")
        $source = $source.Replace("internal static IDictionary<string, string> ParseOutput", "public static IDictionary<string, string> ParseOutput")
        $stubs = @'
namespace DeepFaceLabSN.Launcher
{
    public sealed class LogBuffer
    {
        public void Add(string channel, string line, string level) { }
    }

    internal static class ProcessRunner
    {
        public static string Quote(string value) { return "\"" + value + "\""; }
    }
}
'@
        Add-Type -TypeDefinition ($source + [Environment]::NewLine + $stubs)
    }

    It "keeps the PATH produced by setenv when Windows exposes a duplicate Path variable" {
        $project = Join-Path $TestDrive "DeepFaceLabSN"
        $configuredPath = (Join-Path $project "_internal\node\bin") + ";C:\Windows\System32"
        $inheritedPath = "C:\Windows\System32;C:\SystemNode"
        $output = "PATH=$configuredPath`r`nPath=$inheritedPath`r`nDFL_ROOT=fixture"

        $result = [DeepFaceLabSN.Launcher.DflEnvironment]::ParseOutput($output, $project)

        $result["PATH"] | Should Be $configuredPath
        $result["DFL_ROOT"] | Should Be "fixture"
    }

    It "accepts the normal single mixed-case Path variable" {
        $project = Join-Path $TestDrive "single-path"
        $pathValue = "C:\Tools;C:\Windows\System32"

        $result = [DeepFaceLabSN.Launcher.DflEnvironment]::ParseOutput("Path=$pathValue", $project)

        $result["PATH"] | Should Be $pathValue
    }
}
