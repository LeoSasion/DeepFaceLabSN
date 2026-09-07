Describe "WebUI dependency validation with pnpm isolation" {
    BeforeAll {
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
        $source = (Get-Content (Join-Path $repo 'launcher\host\WebUiDependencies.cs') -Raw -Encoding UTF8).Replace('namespace DeepFaceLabSN.Launcher', 'namespace DependencyProbeTests').Replace('internal static class', 'public static class')
        Add-Type -TypeDefinition $source
        $script:probeNode = Join-Path $repo '_internal\node\bin\node.exe'
        if (-not (Test-Path $script:probeNode)) { $script:probeNode = (Get-Command node.exe -ErrorAction Stop).Source }
        $script:actualWebui = Join-Path $repo 'webui'
    }

    function Invoke-Probe([string]$Directory) {
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $script:probeNode
        $start.Arguments = '-e "' + [DependencyProbeTests.WebUiDependencies]::ProbeScript + '"'
        $start.WorkingDirectory = $Directory
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($start)
        try {
            $output = $process.StandardOutput.ReadToEnd()
            $errorText = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            return @{ Code = $process.ExitCode; Output = $output; Error = $errorText }
        } finally { $process.Dispose() }
    }

    function New-IsolatedDependencies([string]$Root) {
        $modules = Join-Path $Root 'webui\node_modules'
        foreach ($part in @('vite\bin', 'vite\node_modules\esbuild', 'node-pty')) {
            New-Item -ItemType Directory -Path (Join-Path $modules $part) -Force | Out-Null
        }
        [IO.File]::WriteAllText((Join-Path $modules 'vite\package.json'), '{"name":"vite","main":"index.js"}')
        [IO.File]::WriteAllText((Join-Path $modules 'vite\bin\vite.js'), '')
        [IO.File]::WriteAllText((Join-Path $modules 'node-pty\package.json'), '{"main":"index.js"}')
        [IO.File]::WriteAllText((Join-Path $modules 'node-pty\index.js'), 'module.exports={};')
        [IO.File]::WriteAllText((Join-Path $modules 'vite\node_modules\esbuild\index.js'), 'exports.transformSync=()=>({code:"ready"});')
        return $modules
    }

    It "accepts Vite-owned esbuild without a top-level esbuild or prebuild path" {
        $root = Join-Path $TestDrive 'isolated'
        $modules = New-IsolatedDependencies $root
        Test-Path (Join-Path $modules 'esbuild') | Should Be $false
        Test-Path (Join-Path $modules '@esbuild\win32-x64\esbuild.exe') | Should Be $false
        [DependencyProbeTests.WebUiDependencies]::EntryPointsPresent($root) | Should Be $true
        $result = Invoke-Probe (Join-Path $root 'webui')
        $result.Code | Should Be 0
        $result.Output | Should Match 'node-pty: OK'
        $result.Output | Should Match 'vite/esbuild: OK'
    }

    It "reports both module failures with their actual errors" {
        $root = Join-Path $TestDrive 'broken'
        $modules = New-IsolatedDependencies $root
        [IO.File]::WriteAllText((Join-Path $modules 'node-pty\index.js'), 'throw new Error("native ABI mismatch");')
        [IO.File]::WriteAllText((Join-Path $modules 'vite\node_modules\esbuild\index.js'), 'exports.transformSync=()=>{throw new Error("binary missing")};')
        $result = Invoke-Probe (Join-Path $root 'webui')
        $result.Code | Should Be 1
        $result.Error | Should Match 'node-pty: Error: native ABI mismatch'
        $result.Error | Should Match 'vite/esbuild: Error: binary missing'
    }

    It "loads the actual installed node-pty and runs Vite's esbuild" {
        $result = Invoke-Probe $script:actualWebui
        $result.Code | Should Be 0
        $result.Output | Should Match 'node-pty: OK'
        $result.Output | Should Match 'vite/esbuild: OK'
    }
}
