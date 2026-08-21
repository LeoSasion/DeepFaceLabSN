$sourcePath = Join-Path $PSScriptRoot "..\host\PortableNodeEnvironment.cs"

Describe "portable Node.js child-process environment" {
    BeforeAll {
        $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
        $source = $source.Replace("internal static class PortableNodeEnvironment", "public static class PortableNodeEnvironment")
        Add-Type -TypeDefinition $source
    }

    It "places the portable Node.js directory first and removes a stale duplicate" {
        $node = Join-Path $TestDrive "runtime\node\bin\node.exe"
        $nodeDirectory = Split-Path -Parent $node
        $source = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $source["Path"] = "C:\Windows\System32;$nodeDirectory\;C:\Tools"

        $result = [DeepFaceLabSN.Launcher.PortableNodeEnvironment]::Ensure($source, $node)
        $entries = @($result["PATH"].Split([IO.Path]::PathSeparator))

        $entries[0] | Should Be ([IO.Path]::GetFullPath($nodeDirectory))
        @($entries | Where-Object { $_.TrimEnd('\') -ieq $nodeDirectory.TrimEnd('\') }).Count | Should Be 1
        ($entries -contains "C:\Windows\System32") | Should Be $true
        ($entries -contains "C:\Tools") | Should Be $true
    }

    It "preserves all non-PATH variables" {
        $node = Join-Path $TestDrive "node\node.exe"
        $source = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $source["DFL_MIRROR"] = "china"

        $result = [DeepFaceLabSN.Launcher.PortableNodeEnvironment]::Ensure($source, $node)

        $result["DFL_MIRROR"] | Should Be "china"
        $result["PATH"].Split([IO.Path]::PathSeparator)[0] | Should Be ([IO.Path]::GetFullPath((Split-Path -Parent $node)))
    }
}
