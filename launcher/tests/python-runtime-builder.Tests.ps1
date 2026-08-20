$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$Builder = Join-Path $RepositoryRoot 'launcher\build-python-runtime.ps1'
$Lock = Join-Path $RepositoryRoot 'launcher\python-runtime\runtime-lock.json'

Describe 'Python runtime publication kit' {
    It 'pins the exact official TensorFlow GPU wheel found in the working runtime' {
        $lockData = Get-Content -LiteralPath $Lock -Raw -Encoding UTF8 | ConvertFrom-Json
        $artifact = @($lockData.officialArtifacts | Where-Object { $_.name -eq 'tensorflow_gpu-2.10.1-cp37-cp37m-win_amd64.whl' })
        $artifact.Count | Should Be 1
        $artifact[0].url | Should Be 'https://files.pythonhosted.org/packages/31/25/2426f5ca0d056c5f291228b795df32660180a65437513605b1b3c887ff4e/tensorflow_gpu-2.10.1-cp37-cp37m-win_amd64.whl'
        $artifact[0].sha256 | Should Be '15a18dead62702ef80806a3c9d01a554433aa1e609f8d556fb5b03c99d316043'
        $artifact[0].size | Should Be 455895244
    }

    It 'keeps the builder bounded to a source prefix and does not use a mutable download URL' {
        $source = Get-Content -LiteralPath $Builder -Raw -Encoding UTF8
        $source | Should Match 'OutputDirectory must not be inside SourceRuntime'
        $source | Should Match 'tensorflow_gpu-2\\.10\\.1-cp37-cp37m-win_amd64\\.whl'
        $source | Should Match 'tf\.test\.is_built_with_cuda\(\)'
        $source | Should Not Match 'git reset'
        $source | Should Not Match 'git clean'
    }

    It 'validates the checked-out working prefix without packaging it' {
        $runtime = Join-Path $RepositoryRoot '_internal\python_common'
        if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
            Set-ItResult -Skipped -Because 'The local runtime is intentionally not tracked.'
            return
        }
        $output = @(& $Builder -SourceRuntime $runtime -ValidateOnly 2>&1)
        $LASTEXITCODE | Should Be 0
        ($output -join "`n") | Should Match '^VALID '
    }
}
