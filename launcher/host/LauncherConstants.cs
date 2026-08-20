using System;

namespace DeepFaceLabSN.Launcher
{
    internal static class LauncherConstants
    {
        public const string ProductName = "DeepFaceLabSN Launcher";
        public const string GitRemote = "https://github.com/LeoSasion/DeepFaceLabSN.git";
        public const string GitFallbackMirror = "https://gitee.com/LeoSasion/DeepFaceLabSN.git";
        public const string GitBranch = "main";
        public const string VirtualHost = "launcher.local";
        public const string WebUiUrl = "http://127.0.0.1:4173/";
        public const string WebUiRuntimeHealthUrl = "http://127.0.0.1:4174/api/health";
        public const string RuntimeHealthUrl = "http://127.0.0.1:4174/api/health";
        public const string DefaultTerminalUrl = "ws://127.0.0.1:4185/terminal";
        public const string RequiredNodeVersion = "24.19.0";

        public static readonly string SettingsDirectory = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeepFaceLabSN",
            "Launcher");
    }
}
