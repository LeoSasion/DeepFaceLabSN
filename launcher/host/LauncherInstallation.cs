using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace DeepFaceLabSN.Launcher
{
    internal static class LauncherInstallation
    {
        public const string FileName = "DeepFaceLab-WEBUI.exe";
        private const string Prefix = "DFL_INSTALL_";
        private static string source;
        private static string signal;
        private static string digest;
        private static int parentPid;
        public static bool Pending { get { return source != null; } }

        public static void Initialize()
        {
            source = Environment.GetEnvironmentVariable(Prefix + "SOURCE");
            signal = Environment.GetEnvironmentVariable(Prefix + "SIGNAL");
            digest = Environment.GetEnvironmentVariable(Prefix + "HASH");
            Int32.TryParse(Environment.GetEnvironmentVariable(Prefix + "PID"), out parentPid);
            foreach (string key in new[] { "SOURCE", "SIGNAL", "HASH", "PID" })
                Environment.SetEnvironmentVariable(Prefix + key, null);
        }

        public static string Hash(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
        }

        public static string CopyVerified(string original, string projectRoot)
        {
            string target = Path.Combine(Path.GetFullPath(projectRoot), FileName);
            if (String.Equals(Path.GetFullPath(original), target, StringComparison.OrdinalIgnoreCase)) return target;
            string hash = Hash(original);
            if (File.Exists(target))
            {
                if (Hash(target) != hash)
                    throw new IOException("安装目录已有其他版本启动器，已保留两份文件，请先移走旧版后重试：" + target);
                return target;
            }
            // Never publish an incomplete executable, including across volumes.
            string temporary = Path.Combine(projectRoot, ".launcher-install", "launcher-" + Guid.NewGuid().ToString("N") + ".tmp");
            Directory.CreateDirectory(Path.GetDirectoryName(temporary));
            try
            {
                File.Copy(original, temporary, false);
                if (Hash(temporary) != hash) throw new IOException("启动器复制校验失败，原文件已保留。");
                File.Move(temporary, target);
                return target;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        public static Task<bool> RelocateAsync(string projectRoot, LogBuffer logs)
        {
            return Task.Run(delegate
            {
                string original = Assembly.GetExecutingAssembly().Location;
                string target = CopyVerified(original, projectRoot);
                if (String.Equals(original, target, StringComparison.OrdinalIgnoreCase)) return false;
                string eventName = "Local\\DFL-Install-" + Guid.NewGuid().ToString("N");
                using (EventWaitHandle ready = new EventWaitHandle(false, EventResetMode.ManualReset, eventName))
                {
                    ProcessStartInfo start = new ProcessStartInfo(target, "--skip-update-once");
                    start.UseShellExecute = false;
                    start.WorkingDirectory = projectRoot;
                    start.EnvironmentVariables[Prefix + "SOURCE"] = original;
                    start.EnvironmentVariables[Prefix + "SIGNAL"] = eventName;
                    start.EnvironmentVariables[Prefix + "HASH"] = Hash(original);
                    start.EnvironmentVariables[Prefix + "PID"] = Process.GetCurrentProcess().Id.ToString();
                    using (Process child = Process.Start(start))
                    {
                        if (child == null) throw new IOException("无法启动安装目录中的启动器；原文件已保留。");
                        if (!ready.WaitOne(120000))
                            throw new IOException("新启动器未确认就绪，原启动器已保留：" + original);
                    }
                }
                logs.Add("launcher", "已校验并启动 " + target + "；即将退出并完成原位置清理。", "info");
                return true;
            });
        }

        public static void CompleteStartup(LogBuffer logs)
        {
            if (!Pending) return;
            string original = source;
            source = null;
            try
            {
                string current = Assembly.GetExecutingAssembly().Location;
                if (String.IsNullOrEmpty(signal) || !signal.StartsWith("Local\\DFL-Install-", StringComparison.Ordinal)
                    || parentPid <= 0 || !String.Equals(Path.GetFileName(current), FileName, StringComparison.OrdinalIgnoreCase)
                    || String.Equals(original, current, StringComparison.OrdinalIgnoreCase)
                    || !String.Equals(Path.GetExtension(original), ".exe", StringComparison.OrdinalIgnoreCase)
                    || Hash(current) != digest || Hash(original) != digest)
                    throw new IOException("启动器迁移校验失败，已保留原文件。");
                Process parent = Process.GetProcessById(parentPid);
                if (!String.Equals(parent.MainModule.FileName, original, StringComparison.OrdinalIgnoreCase))
                {
                    parent.Dispose();
                    throw new IOException("启动器迁移来源进程不匹配，已保留原文件。");
                }
                using (EventWaitHandle ready = EventWaitHandle.OpenExisting(signal)) ready.Set();
                Task.Run(delegate
                {
                    using (parent)
                    {
                        try
                        {
                            if (!parent.WaitForExit(120000)) throw new IOException("原启动器尚未退出，原文件已保留。");
                            DeleteVerifiedSource(original, current, digest);
                            logs.Add("launcher", "启动器已迁入项目，原位置文件已清理：" + original, "info");
                        }
                        catch (Exception error) { logs.Add("launcher", error.ToString(), "error"); }
                    }
                });
            }
            catch (Exception error) { logs.Add("launcher", error.ToString(), "error"); }
        }

        public static void DeleteVerifiedSource(string original, string installed, string expectedHash)
        {
            if (String.Equals(Path.GetFullPath(original), Path.GetFullPath(installed), StringComparison.OrdinalIgnoreCase)
                || Hash(installed) != expectedHash || Hash(original) != expectedHash)
                throw new IOException("启动器文件已变化，原文件已保留。");
            File.Delete(original);
        }
    }
}
