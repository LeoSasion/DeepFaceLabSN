$sourcePath = Join-Path $PSScriptRoot "..\host\PreparedRuntimeStore.cs"

Describe "prepared runtime staging" {
    BeforeAll {
        Add-Type -Path $sourcePath
        $script:storeType = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
            $_.GetType("DeepFaceLabSN.Launcher.PreparedRuntimeStore", $false)
        } | Where-Object { $null -ne $_ })[0]
        if ($null -eq $script:storeType) { throw "PreparedRuntimeStore type was not loaded." }
        $script:getRoot = $script:storeType.GetMethod("GetRoot", [Reflection.BindingFlags]"Public,Static")
        $script:adopt = $script:storeType.GetMethod("Adopt", [Reflection.BindingFlags]"Public,Static")
    }

    It "keeps the staging area beside the selected project" {
        $project = Join-Path $TestDrive "DeepFaceLabSN"
        $root = $script:getRoot.Invoke($null, [object[]]@([string]$project))
        $root | Should Be (Join-Path $TestDrive ".DeepFaceLabSN.launcher-runtime")
    }

    It "moves only launcher-managed entries and never overwrites project files" {
        $project = Join-Path $TestDrive "project"
        $prepared = $script:getRoot.Invoke($null, [object[]]@([string]$project))
        New-Item -ItemType Directory -Path `
            (Join-Path $prepared "_internal\node"), `
            (Join-Path $prepared "_internal\CUDA"), `
            (Join-Path $prepared "_internal\personal"), `
            (Join-Path $project "_internal\CUDA") -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $prepared "_internal\node\node.exe"), "prepared-node")
        [IO.File]::WriteAllText((Join-Path $prepared "_internal\CUDA\prepared.dll"), "prepared-cuda")
        [IO.File]::WriteAllText((Join-Path $prepared "_internal\personal\private.dat"), "private")
        [IO.File]::WriteAllText((Join-Path $project "_internal\CUDA\existing.dll"), "existing")

        $moved = @($script:adopt.Invoke($null, [object[]]@([string]$project)))

        (@($moved) -contains "node") | Should Be $true
        (Join-Path $project "_internal\node\node.exe") | Should Exist
        [IO.File]::ReadAllText((Join-Path $project "_internal\CUDA\existing.dll")) | Should Be "existing"
        (Join-Path $project "_internal\CUDA\prepared.dll") | Should Not Exist
        (Join-Path $prepared "_internal\CUDA\prepared.dll") | Should Exist
        (Join-Path $prepared "_internal\personal\private.dat") | Should Exist
    }

    It "merges prepared installer caches beside the tracked README and removes empty staging" {
        $project = Join-Path $TestDrive "cache-project"
        $prepared = $script:getRoot.Invoke($null, [object[]]@([string]$project))
        $sourceInstallers = Join-Path $prepared "_internal\installers"
        $targetInstallers = Join-Path $project "_internal\installers"
        New-Item -ItemType Directory -Path `
            (Join-Path $sourceInstallers "python"), `
            $targetInstallers -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $sourceInstallers "cuda.zip"), "verified-cache")
        [IO.File]::WriteAllText((Join-Path $sourceInstallers "python\wheel.whl"), "verified-wheel")
        [IO.File]::WriteAllText((Join-Path $targetInstallers "README.md"), "tracked-readme")

        $moved = @($script:adopt.Invoke($null, [object[]]@([string]$project)))

        (@($moved) -contains "installers") | Should Be $true
        [IO.File]::ReadAllText((Join-Path $targetInstallers "README.md")) | Should Be "tracked-readme"
        [IO.File]::ReadAllText((Join-Path $targetInstallers "cuda.zip")) | Should Be "verified-cache"
        [IO.File]::ReadAllText((Join-Path $targetInstallers "python\wheel.whl")) | Should Be "verified-wheel"
        $prepared | Should Not Exist
    }
}
