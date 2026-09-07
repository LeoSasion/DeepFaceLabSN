using System;
using System.Collections.Generic;
using System.IO;

namespace DeepFaceLabSN.Launcher
{
    internal static class ProjectLocator
    {
        public const string DefaultInstallDirectoryName = "DFL-WEBUI";

        public static string Resolve(LauncherSettings settings)
        {
            if (settings != null && !String.IsNullOrWhiteSpace(settings.ProjectRoot))
            {
                return Path.GetFullPath(Environment.ExpandEnvironmentVariables(settings.ProjectRoot));
            }

            string discovered = FindFrom(AppDomain.CurrentDomain.BaseDirectory);
            if (discovered != null)
            {
                return discovered;
            }

            discovered = FindFrom(Environment.CurrentDirectory);
            if (discovered != null)
            {
                return discovered;
            }

            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(profile, DefaultInstallDirectoryName);
        }

        // Resolve once, when the user selects a folder. Installation uses this
        // exact destination; it must never silently append another directory.
        public static string SelectInstallPath(string selectedPath)
        {
            if (String.IsNullOrWhiteSpace(selectedPath))
                throw new InvalidOperationException("安装目录不能为空。");

            string selected = Path.GetFullPath(Environment.ExpandEnvironmentVariables(selectedPath));
            string trimmed = selected.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            bool isRoot = String.Equals(trimmed,
                Path.GetPathRoot(selected).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
            if (File.Exists(selected))
                throw new InvalidOperationException("所选安装路径是文件，不是目录。");

            string destination = selected;
            if (isRoot || (Directory.Exists(selected) && !IsEmptyDirectory(selected) && !IsProject(selected)))
            {
                if (!isRoot && String.Equals(Path.GetFileName(trimmed), DefaultInstallDirectoryName,
                    StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("DFL-WEBUI 文件夹已有内容，但不是完整项目。请选择其他空文件夹。");
                destination = Path.Combine(selected, DefaultInstallDirectoryName);
            }
            AssertInstallTarget(destination);
            return Path.GetFullPath(destination);
        }

        public static void AssertInstallTarget(string path)
        {
            AssertSafeInstallPath(path);
            if (Directory.Exists(path) && !IsEmptyDirectory(path) && !IsProject(path))
                throw new InvalidOperationException("最终安装目录已有内容，但不是完整项目：" + path + "。请选择其他空文件夹。");
        }

        public static bool IsProject(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
            {
                return false;
            }

            bool hasGit = Directory.Exists(Path.Combine(path, ".git")) || File.Exists(Path.Combine(path, ".git"));
            return hasGit
                && Directory.Exists(Path.Combine(path, "webui"))
                && Directory.Exists(Path.Combine(path, "_internal"));
        }

        public static void AssertSafeInstallPath(string path)
        {
            if (String.IsNullOrWhiteSpace(path))
            {
                throw new InvalidOperationException("安装目录不能为空。");
            }

            string fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path)).TrimEnd(Path.DirectorySeparatorChar);
            string root = Path.GetPathRoot(fullPath).TrimEnd(Path.DirectorySeparatorChar);
            if (String.Equals(fullPath, root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("不能把磁盘根目录用作项目安装目录。");
            }

            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd(Path.DirectorySeparatorChar);
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd(Path.DirectorySeparatorChar);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles).TrimEnd(Path.DirectorySeparatorChar);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86).TrimEnd(Path.DirectorySeparatorChar);
            string[] protectedPaths = { windows, profile, programFiles, programFilesX86 };
            for (int index = 0; index < protectedPaths.Length; index++)
            {
                if (!String.IsNullOrWhiteSpace(protectedPaths[index])
                    && String.Equals(fullPath, protectedPaths[index], StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("请选择受保护系统目录以外的独立子目录。");
                }
            }

            if (File.Exists(fullPath))
            {
                throw new InvalidOperationException("所选安装路径是文件，不是目录。");
            }
        }

        public static bool IsEmptyDirectory(string path)
        {
            return Directory.Exists(path) && Directory.GetFileSystemEntries(path).Length == 0;
        }

        private static string FindFrom(string startingPath)
        {
            if (String.IsNullOrWhiteSpace(startingPath))
            {
                return null;
            }

            DirectoryInfo directory;
            try
            {
                directory = new DirectoryInfo(Path.GetFullPath(startingPath));
            }
            catch
            {
                return null;
            }

            for (int depth = 0; directory != null && depth < 8; depth++, directory = directory.Parent)
            {
                if (IsProject(directory.FullName))
                {
                    return directory.FullName;
                }
            }
            return null;
        }
    }
}
