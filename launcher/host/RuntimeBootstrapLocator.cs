using System;
using System.IO;
using System.Text.RegularExpressions;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class RuntimeBootstrapResources
    {
        public string RootPath { get; set; }
        public string ScriptPath { get; set; }
        public string ManifestPath { get; set; }
        public bool Embedded { get; set; }
    }

    internal static class RuntimeBootstrapLocator
    {
        private static readonly string[] RequiredRelativePaths =
        {
            "bootstrap.ps1",
            "runtime-manifest.json",
            "runtime-artifacts.ps1",
            "python-wheelhouse.ps1",
            Path.Combine("python-runtime", "runtime-wheel-lock.json"),
            Path.Combine("python-runtime", "requirements-win-cp37.in")
        };

        public static RuntimeBootstrapResources Resolve(string projectRoot, string embeddedRoot)
        {
            string projectLauncher = String.IsNullOrWhiteSpace(projectRoot)
                ? null
                : Path.Combine(Path.GetFullPath(projectRoot), "launcher");
            bool projectComplete = IsComplete(projectLauncher);
            bool embeddedComplete = IsComplete(embeddedRoot);
            if (projectComplete && embeddedComplete)
            {
                Version projectVersion = ReadManifestVersion(projectLauncher);
                Version embeddedVersion = ReadManifestVersion(embeddedRoot);
                if (embeddedVersion != null
                    && (projectVersion == null || embeddedVersion.CompareTo(projectVersion) > 0))
                {
                    return Create(Path.GetFullPath(embeddedRoot), true);
                }
                return Create(projectLauncher, false);
            }
            if (projectComplete)
            {
                return Create(projectLauncher, false);
            }
            if (embeddedComplete)
            {
                return Create(Path.GetFullPath(embeddedRoot), true);
            }

            throw new FileNotFoundException(
                "启动器内嵌依赖资源不完整；请重新下载完整的 DeepFaceLabSN.Launcher.exe。",
                String.IsNullOrWhiteSpace(embeddedRoot)
                    ? "bootstrap.ps1"
                    : Path.Combine(embeddedRoot, "bootstrap.ps1"));
        }

        public static bool IsComplete(string root)
        {
            if (String.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            {
                return false;
            }

            for (int index = 0; index < RequiredRelativePaths.Length; index++)
            {
                if (!File.Exists(Path.Combine(root, RequiredRelativePaths[index])))
                {
                    return false;
                }
            }
            return true;
        }

        private static Version ReadManifestVersion(string root)
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(root, "runtime-manifest.json"));
                Match match = Regex.Match(
                    text,
                    "\"manifestVersion\"\\s*:\\s*\"(?<value>[0-9]+(?:\\.[0-9]+){1,3})\"",
                    RegexOptions.CultureInvariant);
                Version version;
                return match.Success && Version.TryParse(match.Groups["value"].Value, out version)
                    ? version
                    : null;
            }
            catch
            {
                return null;
            }
        }
        private static RuntimeBootstrapResources Create(string root, bool embedded)
        {
            return new RuntimeBootstrapResources
            {
                RootPath = root,
                ScriptPath = Path.Combine(root, "bootstrap.ps1"),
                ManifestPath = Path.Combine(root, "runtime-manifest.json"),
                Embedded = embedded
            };
        }
    }
}
