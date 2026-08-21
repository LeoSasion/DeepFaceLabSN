using System;
using System.Collections.Generic;
using System.IO;

namespace DeepFaceLabSN.Launcher
{
    internal static class PortableNodeEnvironment
    {
        public static IDictionary<string, string> Ensure(
            IDictionary<string, string> source,
            string nodeExecutable)
        {
            if (String.IsNullOrWhiteSpace(nodeExecutable))
            {
                throw new ArgumentException("Node.js executable path is required.", "nodeExecutable");
            }

            string nodeDirectory = Path.GetDirectoryName(Path.GetFullPath(nodeExecutable));
            if (String.IsNullOrWhiteSpace(nodeDirectory))
            {
                throw new ArgumentException("Node.js executable has no parent directory.", "nodeExecutable");
            }

            Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (source != null)
            {
                foreach (KeyValuePair<string, string> item in source)
                {
                    environment[item.Key] = item.Value;
                }
            }

            string inheritedPath;
            if (!environment.TryGetValue("PATH", out inheritedPath))
            {
                inheritedPath = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            }
            environment["PATH"] = PrependDirectory(inheritedPath, nodeDirectory);
            return environment;
        }

        private static string PrependDirectory(string pathValue, string directory)
        {
            List<string> entries = new List<string>();
            entries.Add(directory);
            string[] candidates = (pathValue ?? String.Empty).Split(Path.PathSeparator);
            for (int index = 0; index < candidates.Length; index++)
            {
                string candidate = candidates[index].Trim();
                if (candidate.Length == 0)
                {
                    continue;
                }
                string comparable = candidate.Trim('"').TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar);
                if (String.Equals(comparable, directory.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                entries.Add(candidate);
            }
            return String.Join(Path.PathSeparator.ToString(), entries.ToArray());
        }
    }
}
