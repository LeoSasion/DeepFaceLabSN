using System;
using System.Collections.Generic;
using System.IO;

namespace DeepFaceLabSN.Launcher
{
    internal static class PreparedRuntimeStore
    {
        private static readonly string[] ManagedInternalEntries =
        {
            "git", "node", "python_common", "CUDA", "CUDNN",
            "installers", ".launcher", "_e"
        };

        public static string GetRoot(string projectRoot)
        {
            if (String.IsNullOrWhiteSpace(projectRoot))
            {
                throw new InvalidOperationException("项目安装目录不能为空。");
            }
            string fullProject = Path.GetFullPath(Environment.ExpandEnvironmentVariables(projectRoot))
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            DirectoryInfo parent = Directory.GetParent(fullProject);
            string name = Path.GetFileName(fullProject);
            if (parent == null || String.IsNullOrWhiteSpace(name))
            {
                throw new InvalidOperationException("无法为项目安装目录创建依赖暂存区。");
            }
            return Path.Combine(parent.FullName, "." + name + ".launcher-runtime");
        }

        public static IList<string> Adopt(string projectRoot)
        {
            string preparedRoot = GetRoot(projectRoot);
            string preparedInternal = Path.Combine(preparedRoot, "_internal");
            List<string> moved = new List<string>();
            if (!Directory.Exists(preparedInternal)) return moved;

            string projectInternal = Path.Combine(Path.GetFullPath(projectRoot), "_internal");
            Directory.CreateDirectory(projectInternal);
            for (int index = 0; index < ManagedInternalEntries.Length; index++)
            {
                string name = ManagedInternalEntries[index];
                string source = Path.Combine(preparedInternal, name);
                string destination = Path.Combine(projectInternal, name);
                bool sourceDirectory = Directory.Exists(source);
                bool sourceFile = File.Exists(source);
                if (!sourceDirectory && !sourceFile) continue;
                if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) continue;

                if (String.Equals(name, "installers", StringComparison.OrdinalIgnoreCase) && sourceDirectory)
                {
                    int mergedFiles = MergeCacheDirectory(source, destination);
                    if (mergedFiles > 0) moved.Add(name);
                    continue;
                }

                if (Directory.Exists(destination) || File.Exists(destination)) continue;

                if (sourceDirectory) Directory.Move(source, destination);
                else File.Move(source, destination);
                moved.Add(name);
            }
            TryDeleteEmptyDirectory(preparedInternal);
            TryDeleteEmptyDirectory(preparedRoot);
            return moved;
        }

        private static int MergeCacheDirectory(string source, string destination)
        {
            AssertDirectoryTreeHasNoReparsePoints(source);
            if (File.Exists(destination))
            {
                throw new IOException("依赖缓存目录被同名文件占用：" + destination);
            }
            if (Directory.Exists(destination)
                && (File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException("启动器不会向重解析点依赖缓存目录写入：" + destination);
            }
            Directory.CreateDirectory(destination);

            int movedFiles = 0;
            string[] files = Directory.GetFiles(source, "*", SearchOption.TopDirectoryOnly);
            for (int index = 0; index < files.Length; index++)
            {
                string target = Path.Combine(destination, Path.GetFileName(files[index]));
                if (File.Exists(target) || Directory.Exists(target)) continue;
                File.Move(files[index], target);
                movedFiles++;
            }

            string[] directories = Directory.GetDirectories(source, "*", SearchOption.TopDirectoryOnly);
            for (int index = 0; index < directories.Length; index++)
            {
                string target = Path.Combine(destination, Path.GetFileName(directories[index]));
                if (File.Exists(target)) continue;
                if (Directory.Exists(target))
                {
                    movedFiles += MergeCacheDirectory(directories[index], target);
                }
                else
                {
                    movedFiles += Directory.GetFiles(directories[index], "*", SearchOption.AllDirectories).Length;
                    Directory.Move(directories[index], target);
                }
            }
            TryDeleteEmptyDirectory(source);
            return movedFiles;
        }

        private static void AssertDirectoryTreeHasNoReparsePoints(string root)
        {
            DirectoryInfo rootInfo = new DirectoryInfo(root);
            if ((rootInfo.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException("依赖缓存暂存目录不能是重解析点：" + root);
            }
            FileSystemInfo[] entries = rootInfo.GetFileSystemInfos();
            for (int index = 0; index < entries.Length; index++)
            {
                if ((entries[index].Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    throw new IOException("依赖缓存中包含重解析点：" + entries[index].FullName);
                }
                DirectoryInfo directory = entries[index] as DirectoryInfo;
                if (directory != null)
                {
                    AssertDirectoryTreeHasNoReparsePoints(directory.FullName);
                }
            }
        }

        private static void TryDeleteEmptyDirectory(string path)
        {
            if (!Directory.Exists(path)) return;
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return;
            if (Directory.GetFileSystemEntries(path).Length == 0)
            {
                Directory.Delete(path, false);
            }
        }
    }
}
