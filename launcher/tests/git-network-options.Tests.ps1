$sourcePath = Join-Path $PSScriptRoot "..\host\GitNetworkOptions.cs"

Describe "Git network options" {
    BeforeAll {
        $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
        $source = $source.Replace("internal sealed class GitTransportPlan", "public sealed class GitTransportPlan")
        $source = $source.Replace("internal static class GitNetworkOptions", "public static class GitNetworkOptions")
        $source += @'

namespace DeepFaceLabSN.Launcher
{
    public sealed class LauncherSettings
    {
        public string GitProxyMode { get; set; }
        public string GitProxy { get; set; }
        public string GitMirror { get; set; }
        public LauncherSettings() { GitProxyMode = "auto"; }
    }
    internal static class LauncherConstants
    {
        public const string GitRemote = "https://github.com/LeoSasion/DeepFaceLabSN.git";
        public const string GitFallbackMirror = "https://gitee.com/LeoSasion/DeepFaceLabSN.git";
    }
}
'@
        Add-Type -TypeDefinition $source
    }

    It "accepts explicit local proxies but rejects embedded credentials" {
        [DeepFaceLabSN.Launcher.GitNetworkOptions]::NormalizeProxy("http://127.0.0.1:7890") | Should Be "http://127.0.0.1:7890"
        { [DeepFaceLabSN.Launcher.GitNetworkOptions]::NormalizeProxy("https://user:secret@proxy.example") } | Should Throw
    }

    It "requires an HTTPS trusted mirror without credentials" {
        [DeepFaceLabSN.Launcher.GitNetworkOptions]::NormalizeMirror("https://gitee.com/example/DeepFaceLabSN.git/") | Should Be "https://gitee.com/example/DeepFaceLabSN.git"
        { [DeepFaceLabSN.Launcher.GitNetworkOptions]::NormalizeMirror("http://gitee.com/example/repo.git") } | Should Throw
    }

    It "interleaves GitHub and the built-in Gitee fallback" {
        $settings = New-Object DeepFaceLabSN.Launcher.LauncherSettings
        $settings.GitProxyMode = "direct"
        $first = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreatePlan($settings, 1)
        $second = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreatePlan($settings, 2)
        $third = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreatePlan($settings, 3)
        $fourth = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreatePlan($settings, 4)

        $first.UsesMirror | Should Be $false
        $first.DirectConnection | Should Be $true
        $first.ForceHttp11 | Should Be $false
        $second.UsesMirror | Should Be $true
        $second.SourceUrl | Should Be "https://gitee.com/LeoSasion/DeepFaceLabSN.git"
        $second.ForceHttp11 | Should Be $false
        $third.UsesMirror | Should Be $false
        $third.ForceHttp11 | Should Be $true
        $fourth.UsesMirror | Should Be $true
        $fourth.ForceHttp11 | Should Be $true
    }

    It "clears inherited proxy variables when direct mode is selected" {
        $settings = New-Object DeepFaceLabSN.Launcher.LauncherSettings
        $settings.GitProxyMode = "direct"
        $plan = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreatePlan($settings, 1)
        $environment = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreateEnvironment($plan)

        $environment["HTTPS_PROXY"] | Should Be ""
        $environment["HTTP_PROXY"] | Should Be ""
        $environment["ALL_PROXY"] | Should Be ""
    }

    It "lets an explicit trusted mirror override the built-in fallback" {
        $settings = New-Object DeepFaceLabSN.Launcher.LauncherSettings
        $settings.GitProxyMode = "direct"
        $settings.GitMirror = "https://gitee.com/example/DeepFaceLabSN.git"
        $second = [DeepFaceLabSN.Launcher.GitNetworkOptions]::CreatePlan($settings, 2)
        $second.UsesMirror | Should Be $true
        $second.SourceUrl | Should Be "https://gitee.com/example/DeepFaceLabSN.git"
    }
}
