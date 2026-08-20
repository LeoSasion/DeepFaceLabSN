$ErrorActionPreference = "Stop"

$bootstrapPath = Join-Path $PSScriptRoot "..\bootstrap.ps1"

Describe "BITS download fallback" {
    BeforeAll {
        $tokens = $null
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile(
            (Resolve-Path $bootstrapPath),
            [ref]$tokens,
            [ref]$parseErrors
        )
        @($parseErrors).Count | Should Be 0
        $functionAst = @($ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq "Invoke-BitsDownload"
        }, $true))[0]
        if ($null -eq $functionAst) { throw "Invoke-BitsDownload was not found." }
        Invoke-Expression $functionAst.Extent.Text
    }

    It "cancels a zero-byte job after the stall deadline instead of waiting 24 hours" {
        $script:fakeBitsJob = [pscustomobject]@{
            JobId = "fixture-job"
            DisplayName = "fixture"
            JobState = "Connecting"
            BytesTransferred = [UInt64]0
            BytesTotal = [UInt64]::MaxValue
            ErrorDescription = ""
        }
        $script:removedBitsJobs = 0
        $script:startedPriority = $null

        function Test-FileSha256 { return $false }
        function Move-InvalidDownload { param([string]$Path); return $null }
        function Format-ByteCount { param([Int64]$Bytes); return "$Bytes B" }
        function Write-JsonEvent { param($Stage, $Id, $Status, $Progress, $Downloaded, $Total, $Message) }
        function Start-Sleep { param([int]$Milliseconds) }
        function Get-BitsTransfer {
            [CmdletBinding()]
            param([object]$Id)
            if ($PSBoundParameters.ContainsKey("Id")) { return $script:fakeBitsJob }
            return @()
        }
        function Start-BitsTransfer {
            [CmdletBinding()]
            param($Source, $Destination, $DisplayName, $Description, $Priority, [switch]$Asynchronous)
            $script:startedPriority = $Priority
            return $script:fakeBitsJob
        }
        function Remove-BitsTransfer {
            [CmdletBinding()]
            param($BitsJob)
            $script:removedBitsJobs++
        }

        $failure = $null
        try {
            Invoke-BitsDownload `
                -Url "https://download.example.invalid/runtime.zip" `
                -Destination (Join-Path $TestDrive "runtime.zip.part") `
                -Id "node" `
                -Sha256 ("a" * 64) `
                -StallTimeoutSeconds 0
        } catch {
            $failure = $_.Exception.Message
        }

        $failure | Should Match "BITS.*0.*Connecting"
        $script:startedPriority | Should Be "Foreground"
        $script:removedBitsJobs | Should Be 1
    }
}
