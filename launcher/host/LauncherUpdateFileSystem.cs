using System;
using System.IO;
using System.Security.Cryptography;

namespace DeepFaceLabSN.Launcher
{
    internal static class LauncherUpdateFileSystem
    {
        public static string ComputeFileSha256(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                return BitConverter.ToString(sha.ComputeHash(stream))
                    .Replace("-", String.Empty)
                    .ToLowerInvariant();
            }
        }

        public static void ReplaceWithBackup(
            string stagingPath,
            string targetPath,
            string backupPath,
            string expectedCurrentSha256)
        {
            if (!File.Exists(stagingPath) || !File.Exists(targetPath) || File.Exists(backupPath) ||
                !String.Equals(
                    ComputeFileSha256(targetPath),
                    expectedCurrentSha256,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("旧启动器在替换前发生变化，已取消覆盖。");
            }

            try
            {
                File.Replace(stagingPath, targetPath, backupPath, true);
                return;
            }
            catch (IOException)
            {
                if (!File.Exists(stagingPath) || !File.Exists(targetPath) || File.Exists(backupPath) ||
                    !String.Equals(
                        ComputeFileSha256(targetPath),
                        expectedCurrentSha256,
                        StringComparison.OrdinalIgnoreCase))
                {
                    throw;
                }
            }

            File.Move(targetPath, backupPath);
            try
            {
                File.Move(stagingPath, targetPath);
            }
            catch
            {
                if (!File.Exists(targetPath) && File.Exists(backupPath))
                {
                    File.Move(backupPath, targetPath);
                }
                throw;
            }
        }

        public static void RestoreBackup(string targetPath, string backupPath)
        {
            string failedPath = targetPath + ".failed-" + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                if (File.Exists(targetPath))
                {
                    File.Replace(backupPath, targetPath, failedPath, true);
                }
                else
                {
                    File.Move(backupPath, targetPath);
                }
            }
            finally
            {
                TryDeleteFile(failedPath);
            }
        }

        private static void TryDeleteFile(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
            }
        }
    }
}
