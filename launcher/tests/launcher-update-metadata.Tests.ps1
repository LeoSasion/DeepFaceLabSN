$ErrorActionPreference = "Stop"

$sourcePath = Join-Path $PSScriptRoot "..\host\LauncherUpdateMetadata.cs"
$channelPath = Join-Path $PSScriptRoot "..\update-channel.json"
$assemblyInfoPath = Join-Path $PSScriptRoot "..\host\AssemblyInfo.cs"

Describe "launcher self-update metadata" {
    BeforeAll {
        $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
        $source = $source.Replace("internal sealed class LauncherUpdateSource", "public sealed class LauncherUpdateSource")
        $source = $source.Replace("internal sealed class LauncherUpdateManifest", "public sealed class LauncherUpdateManifest")
        $source = $source.Replace("internal static class LauncherUpdatePolicy", "public static class LauncherUpdatePolicy")
        Add-Type -TypeDefinition $source -ReferencedAssemblies @("System.Web.Extensions.dll")
    }

    It "accepts a pinned dual-source HTTPS manifest" {
        $json = @'
{
  "schemaVersion": 1,
  "version": "0.2.0",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "size": 2419712,
  "sources": [
    { "provider": "github", "url": "https://github.com/LeoSasion/DeepFaceLabSN/releases/download/v0.2.0/launcher.exe" },
    { "provider": "gitee", "url": "https://gitee.com/LeoSasion/DeepFaceLabSN/releases/download/v0.2.0/launcher.exe" }
  ]
}
'@
        $manifest = [DeepFaceLabSN.Launcher.LauncherUpdateManifest]::Parse($json)
        $manifest.Version.ToString() | Should Be "0.2.0.0"
        $manifest.Size | Should Be 2419712
        $manifest.Sources.Count | Should Be 2
    }

    It "rejects HTTP, credentials, lookalike hosts, and custom ports" {
        [DeepFaceLabSN.Launcher.LauncherUpdatePolicy]::IsTrustedDownloadUri(
            [Uri]"http://github.com/example/file.exe") | Should Be $false
        [DeepFaceLabSN.Launcher.LauncherUpdatePolicy]::IsTrustedDownloadUri(
            [Uri]"https://user:secret@gitee.com/example/file.exe") | Should Be $false
        [DeepFaceLabSN.Launcher.LauncherUpdatePolicy]::IsTrustedDownloadUri(
            [Uri]"https://github.com.evil.example/file.exe") | Should Be $false
        [DeepFaceLabSN.Launcher.LauncherUpdatePolicy]::IsTrustedDownloadUri(
            [Uri]"https://gitee.com:8443/example/file.exe") | Should Be $false
    }

    It "rejects unpinned or implausibly sized updates" {
        $badHash = '{"schemaVersion":1,"version":"0.2.0","sha256":"abc","size":2419712,"sources":[{"provider":"github","url":"https://github.com/example/file.exe"}]}'
        { [DeepFaceLabSN.Launcher.LauncherUpdateManifest]::Parse($badHash) } | Should Throw

        $tooSmall = '{"schemaVersion":1,"version":"0.2.0","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":100,"sources":[{"provider":"github","url":"https://github.com/example/file.exe"}]}'
        { [DeepFaceLabSN.Launcher.LauncherUpdateManifest]::Parse($tooSmall) } | Should Throw
    }

    It "compares normalized launcher versions" {
        [DeepFaceLabSN.Launcher.LauncherUpdatePolicy]::IsNewer(
            [Version]"0.2.0",
            [Version]"0.1.0.0") | Should Be $true
        [DeepFaceLabSN.Launcher.LauncherUpdatePolicy]::IsNewer(
            [Version]"0.2.0",
            [Version]"0.2.0.0") | Should Be $false
    }

    It "keeps the committed channel aligned with the host version and deterministic release URLs" {
        $channelJson = Get-Content -LiteralPath $channelPath -Raw -Encoding UTF8
        $manifest = [DeepFaceLabSN.Launcher.LauncherUpdateManifest]::Parse($channelJson)
        $assemblyInfo = Get-Content -LiteralPath $assemblyInfoPath -Raw -Encoding UTF8
        $assemblyInfo | Should Match ('AssemblyVersion\("' + [Regex]::Escape($manifest.Version.ToString()) + '"\)')
        $manifest.Sources[0].Uri.AbsoluteUri | Should Be (
            "https://github.com/LeoSasion/DeepFaceLabSN/releases/download/v" +
            $manifest.VersionText + "/DeepFaceLabSN.Launcher.exe")
        $manifest.Sources[1].Uri.AbsoluteUri | Should Be (
            "https://gitee.com/LeoSasion/DeepFaceLabSN/releases/download/v" +
            $manifest.VersionText + "/DeepFaceLabSN.Launcher.exe")
    }
}
