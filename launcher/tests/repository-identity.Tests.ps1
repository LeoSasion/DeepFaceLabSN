Describe "renamed repository identity" {
    BeforeAll {
        $source = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\host\LauncherConstants.cs') -Raw -Encoding UTF8)
        $source = $source.Replace('namespace DeepFaceLabSN.Launcher', 'namespace RepositoryIdentityTests')
        $source = $source.Replace('internal static class LauncherConstants', 'public static class LauncherConstants')
        Add-Type -TypeDefinition $source
    }

    It "accepts the new canonical source and the old installed origin" {
        [RepositoryIdentityTests.LauncherConstants]::IsOfficialGitRemote('https://github.com/LeoSasion/DeepFaceLab-WEBUI.git') | Should Be $true
        [RepositoryIdentityTests.LauncherConstants]::IsOfficialGitRemote('https://github.com/LeoSasion/DeepFaceLabSN.git') | Should Be $true
        [RepositoryIdentityTests.LauncherConstants]::IsOfficialGitRemote('https://github.com/LeoSasion/DeepFaceLab-WEBUI/') | Should Be $true
    }

    It "rejects different owners, lookalike hosts, credentials, and query suffixes" {
        foreach ($remote in @(
            'https://github.com/other/DeepFaceLab-WEBUI.git',
            'https://github.com.evil.example/LeoSasion/DeepFaceLab-WEBUI.git',
            'https://user@github.com/LeoSasion/DeepFaceLab-WEBUI.git',
            'https://github.com/LeoSasion/DeepFaceLab-WEBUI.git?other',
            ''
        )) {
            [RepositoryIdentityTests.LauncherConstants]::IsOfficialGitRemote($remote) | Should Be $false
        }
    }
}
