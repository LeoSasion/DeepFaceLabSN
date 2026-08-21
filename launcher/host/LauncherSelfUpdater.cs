using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace DeepFaceLabSN.Launcher
{
    internal static class LauncherSelfUpdater
    {
        private const string ApplyUpdateArgument = "--apply-update";
        private const string SkipUpdateArgument = "--skip-update-once";
        private const string CleanupHelperArgument = "--cleanup-update-helper";
        private const string CleanupBackupArgument = "--cleanup-update-backup";
        private const string CleanupRequestArgument = "--cleanup-update-request";
        private const string HelperProcessArgument = "--update-helper-pid";

        public static bool ShouldSkipStartupCheck(string[] args)
        {
            return HasArgument(args, SkipUpdateArgument) ||
                String.Equals(
                    Environment.GetEnvironmentVariable("DFLSN_LAUNCHER_SKIP_UPDATE"),
                    "1",
                    StringComparison.Ordinal);
        }

        public static int? TryRunApplyUpdate(string[] args)
        {
            string requestPath = ReadArgumentValue(args, ApplyUpdateArgument);
            if (requestPath == null)
            {
                return null;
            }
            try
            {
                ApplyUpdate(requestPath);
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "启动器更新替换失败。旧版本已尽可能保留。\r\n\r\n" + error.Message,
                    LauncherConstants.ProductName,
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
                TryRestartValidatedTarget(requestPath);
                return 3;
            }
        }

        public static void ScheduleCleanup(string[] args)
        {
            string helperPath = ReadArgumentValue(args, CleanupHelperArgument);
            string backupPath = ReadArgumentValue(args, CleanupBackupArgument);
            string requestPath = ReadArgumentValue(args, CleanupRequestArgument);
            string helperPidText = ReadArgumentValue(args, HelperProcessArgument);
            int helperPid;
            if (helperPath == null || backupPath == null || requestPath == null ||
                !Int32.TryParse(helperPidText, NumberStyles.None, CultureInfo.InvariantCulture, out helperPid))
            {
                return;
            }

            string currentExecutable = GetCurrentExecutablePath();
            if (!IsStrictChildPath(helperPath, UpdatesDirectory) ||
                !IsStrictChildPath(requestPath, UpdatesDirectory) ||
                !IsExpectedBackupPath(backupPath, currentExecutable))
            {
                return;
            }

            Task.Run(delegate
            {
                WaitForProcessExit(helperPid, 120000);
                TryDeleteFile(helperPath);
                TryDeleteFile(requestPath);
                TryDeleteFile(backupPath);
            });
        }

        public static bool CheckAtStartup()
        {
            LauncherUpdateBootstrapWindow window = new LauncherUpdateBootstrapWindow();
            window.ShowDialog();
            return window.ShouldRestart;
        }

        internal static async Task<LauncherUpdateCheckResult> FindUpdateAsync(
            Version currentVersion,
            IProgress<LauncherUpdateProgress> progress)
        {
            Report(progress, "checking", "正在检查启动器更新…", -1, 0, 0, "GitHub / Gitee 双源");
            Task<LauncherUpdateManifest> github = TryFetchManifestAsync(
                new Uri(LauncherConstants.LauncherUpdateManifestGitHub));
            Task<LauncherUpdateManifest> gitee = TryFetchManifestAsync(
                new Uri(LauncherConstants.LauncherUpdateManifestGitee));
            LauncherUpdateManifest[] candidates = await Task.WhenAll(github, gitee);

            bool reachedSource = false;
            LauncherUpdateManifest selected = null;
            for (int index = 0; index < candidates.Length; index++)
            {
                LauncherUpdateManifest candidate = candidates[index];
                if (candidate == null)
                {
                    continue;
                }
                reachedSource = true;
                if (!LauncherUpdatePolicy.IsNewer(candidate.Version, currentVersion))
                {
                    continue;
                }
                if (selected == null || candidate.Version.CompareTo(selected.Version) > 0)
                {
                    selected = candidate;
                    continue;
                }
                if (candidate.Version.Equals(selected.Version) &&
                    (!String.Equals(candidate.Sha256, selected.Sha256, StringComparison.OrdinalIgnoreCase) ||
                     candidate.Size != selected.Size))
                {
                    throw new InvalidOperationException("GitHub 与 Gitee 的启动器更新清单不一致，已停止更新。");
                }
            }
            return new LauncherUpdateCheckResult(selected, reachedSource);
        }

        internal static async Task<string> DownloadUpdateAsync(
            LauncherUpdateManifest manifest,
            IProgress<LauncherUpdateProgress> progress)
        {
            string versionDirectory = Path.Combine(UpdatesDirectory, manifest.VersionText);
            Directory.CreateDirectory(versionDirectory);
            List<Task<LauncherDownloadAttempt>> attempts = new List<Task<LauncherDownloadAttempt>>();
            for (int index = 0; index < manifest.Sources.Count; index++)
            {
                LauncherUpdateSource source = manifest.Sources[index];
                attempts.Add(DownloadFromSourceAsync(manifest, source, versionDirectory, progress));
            }

            List<string> errors = new List<string>();
            while (attempts.Count > 0)
            {
                Task<LauncherDownloadAttempt> completed = await Task.WhenAny(attempts);
                attempts.Remove(completed);
                LauncherDownloadAttempt result = await completed;
                if (result.Succeeded)
                {
                    for (int index = 0; index < attempts.Count; index++)
                    {
                        CleanupUnusedAttempt(attempts[index]);
                    }
                    Report(progress, "verified", "启动器更新已通过 SHA-256 校验", 100,
                        manifest.Size, manifest.Size, result.Provider + " 下载完成");
                    return result.Path;
                }
                errors.Add(result.Provider + "：" + result.Error);
            }
            throw new InvalidOperationException(
                "GitHub 与 Gitee 均未能下载启动器更新。\r\n" + String.Join("\r\n", errors.ToArray()));
        }

        internal static void LaunchReplacement(string downloadedExecutable, LauncherUpdateManifest manifest)
        {
            string target = GetCurrentExecutablePath();
            string requestId = Guid.NewGuid().ToString("N");
            string requestPath = Path.Combine(UpdatesDirectory, "apply-" + requestId + ".json");
            Directory.CreateDirectory(UpdatesDirectory);

            LauncherApplyUpdateRequest request = new LauncherApplyUpdateRequest();
            request.SchemaVersion = 1;
            request.TargetPath = target;
            request.HelperPath = Path.GetFullPath(downloadedExecutable);
            request.OldProcessId = Process.GetCurrentProcess().Id;
            request.ExpectedCurrentSha256 = ComputeFileSha256(target);
            request.ExpectedNewSha256 = manifest.Sha256;
            request.ExpectedNewSize = manifest.Size;

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            File.WriteAllText(requestPath, serializer.Serialize(request), new UTF8Encoding(false));

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = request.HelperPath;
            startInfo.Arguments = ApplyUpdateArgument + " " + QuoteArgument(requestPath);
            startInfo.WorkingDirectory = Path.GetDirectoryName(request.HelperPath);
            startInfo.UseShellExecute = false;
            if (Process.Start(startInfo) == null)
            {
                throw new InvalidOperationException("无法启动新版启动器替换程序。");
            }
        }

        private static string UpdatesDirectory
        {
            get { return Path.Combine(LauncherConstants.SettingsDirectory, "updates"); }
        }

        private static async Task<LauncherUpdateManifest> TryFetchManifestAsync(Uri uri)
        {
            try
            {
                HttpWebRequest request = CreateRequest(uri, 6000, 6000);
                using (HttpWebResponse response = await GetResponseWithTimeoutAsync(request, 6000))
                {
                    if (response.StatusCode != HttpStatusCode.OK ||
                        !LauncherUpdatePolicy.IsTrustedDownloadUri(response.ResponseUri))
                    {
                        return null;
                    }
                    if (response.ContentLength > LauncherUpdateManifest.MaximumManifestBytes)
                    {
                        return null;
                    }
                    using (Stream stream = response.GetResponseStream())
                    using (MemoryStream memory = new MemoryStream())
                    {
                        byte[] buffer = new byte[8192];
                        while (true)
                        {
                            int read = await ReadWithTimeoutAsync(stream, buffer, request, 6000);
                            if (read <= 0)
                            {
                                break;
                            }
                            memory.Write(buffer, 0, read);
                            if (memory.Length > LauncherUpdateManifest.MaximumManifestBytes)
                            {
                                return null;
                            }
                        }
                        string json = new UTF8Encoding(false, true).GetString(memory.ToArray());
                        return LauncherUpdateManifest.Parse(json);
                    }
                }
            }
            catch
            {
                return null;
            }
        }

        private static Task<LauncherDownloadAttempt> DownloadFromSourceAsync(
            LauncherUpdateManifest manifest,
            LauncherUpdateSource source,
            string versionDirectory,
            IProgress<LauncherUpdateProgress> progress)
        {
            return Task.Run(delegate
            {
                string partPath = Path.Combine(
                    versionDirectory,
                    "launcher-" + source.Provider + "-" + Guid.NewGuid().ToString("N") + ".part");
                try
                {
                    Report(progress, "downloading", "正在下载启动器 " + manifest.VersionText + "…",
                        0, 0, manifest.Size, source.Provider.ToUpperInvariant() + " 源");
                    HttpWebRequest request = CreateRequest(source.Uri, 12000, 20000);
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        if (response.StatusCode != HttpStatusCode.OK ||
                            !LauncherUpdatePolicy.IsTrustedDownloadUri(response.ResponseUri))
                        {
                            throw new InvalidOperationException("下载地址发生了不可信跳转。");
                        }
                        if (response.ContentLength > 0 && response.ContentLength != manifest.Size)
                        {
                            throw new InvalidOperationException("服务器返回的文件大小与清单不一致。");
                        }
                        using (Stream input = response.GetResponseStream())
                        using (FileStream output = new FileStream(
                            partPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            byte[] buffer = new byte[64 * 1024];
                            long total = 0;
                            while (true)
                            {
                                int read = input.Read(buffer, 0, buffer.Length);
                                if (read <= 0)
                                {
                                    break;
                                }
                                total += read;
                                if (total > manifest.Size || total > LauncherUpdateManifest.MaximumExecutableBytes)
                                {
                                    throw new InvalidOperationException("下载文件超过清单声明的大小。");
                                }
                                output.Write(buffer, 0, read);
                                int percent = manifest.Size > 0
                                    ? (int)Math.Min(99, total * 100L / manifest.Size)
                                    : -1;
                                Report(progress, "downloading", "正在下载启动器 " + manifest.VersionText + "…",
                                    percent, total, manifest.Size, source.Provider.ToUpperInvariant() + " 源");
                            }
                        }
                    }

                    FileInfo file = new FileInfo(partPath);
                    if (file.Length != manifest.Size ||
                        !String.Equals(ComputeFileSha256(partPath), manifest.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("下载文件的大小或 SHA-256 校验失败。");
                    }
                    string executablePath = Path.Combine(
                        versionDirectory,
                        "DeepFaceLabSN-Launcher-" + manifest.VersionText + "-" +
                        Guid.NewGuid().ToString("N") + ".exe");
                    File.Move(partPath, executablePath);
                    return LauncherDownloadAttempt.Success(source.Provider, executablePath);
                }
                catch (Exception error)
                {
                    TryDeleteFile(partPath);
                    return LauncherDownloadAttempt.Failure(source.Provider, error.Message);
                }
            });
        }

        private static void CleanupUnusedAttempt(Task<LauncherDownloadAttempt> attempt)
        {
            attempt.ContinueWith(delegate(Task<LauncherDownloadAttempt> completed)
            {
                if (completed.Status == TaskStatus.RanToCompletion && completed.Result.Succeeded)
                {
                    TryDeleteFile(completed.Result.Path);
                }
            }, TaskScheduler.Default);
        }

        private static void ApplyUpdate(string requestPath)
        {
            string requestFullPath = Path.GetFullPath(requestPath);
            if (!IsStrictChildPath(requestFullPath, UpdatesDirectory) || !File.Exists(requestFullPath))
            {
                throw new InvalidOperationException("启动器更新请求路径不安全。");
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            LauncherApplyUpdateRequest request = serializer.Deserialize<LauncherApplyUpdateRequest>(
                File.ReadAllText(requestFullPath, Encoding.UTF8));
            ValidateApplyRequest(request, requestFullPath);
            WaitForProcessExit(request.OldProcessId, 120000);

            if (!File.Exists(request.TargetPath) ||
                !String.Equals(
                    ComputeFileSha256(request.TargetPath),
                    request.ExpectedCurrentSha256,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("旧启动器在更新期间发生变化，已取消覆盖。");
            }

            string targetDirectory = Path.GetDirectoryName(request.TargetPath);
            string targetName = Path.GetFileName(request.TargetPath);
            string token = Guid.NewGuid().ToString("N");
            string stagingPath = Path.Combine(targetDirectory, targetName + ".updating-" + token + ".tmp");
            string backupPath = Path.Combine(targetDirectory, targetName + ".previous-" + token + ".exe");
            bool replaced = false;
            try
            {
                File.Copy(request.HelperPath, stagingPath, false);
                if (new FileInfo(stagingPath).Length != request.ExpectedNewSize ||
                    !String.Equals(
                        ComputeFileSha256(stagingPath),
                        request.ExpectedNewSha256,
                        StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("新版启动器在复制过程中校验失败。");
                }
                LauncherUpdateFileSystem.ReplaceWithBackup(
                    stagingPath,
                    request.TargetPath,
                    backupPath,
                    request.ExpectedCurrentSha256);
                replaced = true;
                if (!String.Equals(
                    ComputeFileSha256(request.TargetPath),
                    request.ExpectedNewSha256,
                    StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("新版启动器替换后的校验失败。");
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = request.TargetPath;
                startInfo.Arguments = BuildCleanupArguments(
                    request.HelperPath,
                    backupPath,
                    requestFullPath,
                    Process.GetCurrentProcess().Id);
                startInfo.WorkingDirectory = targetDirectory;
                startInfo.UseShellExecute = false;
                if (Process.Start(startInfo) == null)
                {
                    throw new InvalidOperationException("新版启动器替换成功，但无法自动重启。");
                }
            }
            catch
            {
                if (replaced && File.Exists(backupPath))
                {
                    LauncherUpdateFileSystem.RestoreBackup(request.TargetPath, backupPath);
                }
                throw;
            }
            finally
            {
                TryDeleteFile(stagingPath);
            }
        }

        private static void ValidateApplyRequest(LauncherApplyUpdateRequest request, string requestPath)
        {
            if (request == null || request.SchemaVersion != 1 || request.OldProcessId <= 0 ||
                request.ExpectedNewSize < LauncherUpdateManifest.MinimumExecutableBytes ||
                request.ExpectedNewSize > LauncherUpdateManifest.MaximumExecutableBytes ||
                !IsSha256(request.ExpectedCurrentSha256) || !IsSha256(request.ExpectedNewSha256))
            {
                throw new InvalidOperationException("启动器更新请求内容无效。");
            }

            request.TargetPath = Path.GetFullPath(request.TargetPath);
            request.HelperPath = Path.GetFullPath(request.HelperPath);
            string currentExecutable = GetCurrentExecutablePath();
            if (!String.Equals(request.HelperPath, currentExecutable, StringComparison.OrdinalIgnoreCase) ||
                !IsStrictChildPath(request.HelperPath, UpdatesDirectory) ||
                !IsStrictChildPath(requestPath, UpdatesDirectory) ||
                !String.Equals(Path.GetExtension(request.TargetPath), ".exe", StringComparison.OrdinalIgnoreCase) ||
                !File.Exists(request.HelperPath) || !File.Exists(request.TargetPath) ||
                IsReparsePoint(request.HelperPath) || IsReparsePoint(request.TargetPath))
            {
                throw new InvalidOperationException("启动器更新目标或替换程序不安全。");
            }
            FileInfo helper = new FileInfo(request.HelperPath);
            if (helper.Length != request.ExpectedNewSize ||
                !String.Equals(
                    ComputeFileSha256(request.HelperPath),
                    request.ExpectedNewSha256,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("新版启动器未通过更新前校验。");
            }
        }

        private static void TryRestartValidatedTarget(string requestPath)
        {
            try
            {
                string requestFullPath = Path.GetFullPath(requestPath);
                if (!IsStrictChildPath(requestFullPath, UpdatesDirectory) || !File.Exists(requestFullPath))
                {
                    return;
                }
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                LauncherApplyUpdateRequest request = serializer.Deserialize<LauncherApplyUpdateRequest>(
                    File.ReadAllText(requestFullPath, Encoding.UTF8));
                if (request == null || !IsSha256(request.ExpectedCurrentSha256) ||
                    !IsSha256(request.ExpectedNewSha256) || String.IsNullOrWhiteSpace(request.TargetPath))
                {
                    return;
                }
                string targetPath = Path.GetFullPath(request.TargetPath);
                if (!File.Exists(targetPath) || IsReparsePoint(targetPath) ||
                    !String.Equals(Path.GetExtension(targetPath), ".exe", StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                string actual = ComputeFileSha256(targetPath);
                if (!String.Equals(actual, request.ExpectedCurrentSha256, StringComparison.OrdinalIgnoreCase) &&
                    !String.Equals(actual, request.ExpectedNewSha256, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = targetPath;
                startInfo.Arguments = SkipUpdateArgument;
                startInfo.WorkingDirectory = Path.GetDirectoryName(targetPath);
                startInfo.UseShellExecute = false;
                Process.Start(startInfo);
            }
            catch
            {
            }
        }

        private static string BuildCleanupArguments(
            string helperPath,
            string backupPath,
            string requestPath,
            int helperPid)
        {
            return SkipUpdateArgument + " " +
                CleanupHelperArgument + " " + QuoteArgument(helperPath) + " " +
                CleanupBackupArgument + " " + QuoteArgument(backupPath) + " " +
                CleanupRequestArgument + " " + QuoteArgument(requestPath) + " " +
                HelperProcessArgument + " " + helperPid.ToString(CultureInfo.InvariantCulture);
        }

        private static HttpWebRequest CreateRequest(Uri uri, int timeout, int readWriteTimeout)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(uri);
            request.AllowAutoRedirect = true;
            request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            request.Timeout = timeout;
            request.ReadWriteTimeout = readWriteTimeout;
            request.UserAgent = "DeepFaceLabSN-Launcher/" +
                Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            request.Headers[HttpRequestHeader.CacheControl] = "no-cache";
            return request;
        }

        private static async Task<HttpWebResponse> GetResponseWithTimeoutAsync(
            HttpWebRequest request,
            int timeout)
        {
            Task<WebResponse> responseTask = request.GetResponseAsync();
            Task completed = await Task.WhenAny(responseTask, Task.Delay(timeout));
            if (!Object.ReferenceEquals(completed, responseTask))
            {
                request.Abort();
                throw new TimeoutException("检查启动器更新超时。");
            }
            return (HttpWebResponse)await responseTask;
        }

        private static async Task<int> ReadWithTimeoutAsync(
            Stream stream,
            byte[] buffer,
            HttpWebRequest request,
            int timeout)
        {
            Task<int> readTask = stream.ReadAsync(buffer, 0, buffer.Length);
            Task completed = await Task.WhenAny(readTask, Task.Delay(timeout));
            if (!Object.ReferenceEquals(completed, readTask))
            {
                request.Abort();
                throw new TimeoutException("读取启动器更新清单超时。");
            }
            return await readTask;
        }

        private static void WaitForProcessExit(int processId, int timeout)
        {
            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    if (!process.WaitForExit(timeout))
                    {
                        throw new TimeoutException("等待旧启动器退出超时。");
                    }
                }
            }
            catch (ArgumentException)
            {
            }
        }

        private static string ComputeFileSha256(string path)
        {
            return LauncherUpdateFileSystem.ComputeFileSha256(path);
        }

        private static bool IsSha256(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length != 64)
            {
                return false;
            }
            for (int index = 0; index < value.Length; index++)
            {
                char character = Char.ToLowerInvariant(value[index]);
                if (!((character >= '0' && character <= '9') ||
                      (character >= 'a' && character <= 'f')))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsStrictChildPath(string candidate, string parent)
        {
            try
            {
                string candidateFull = Path.GetFullPath(candidate)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string parentFull = Path.GetFullPath(parent)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                return !String.Equals(candidateFull, parentFull, StringComparison.OrdinalIgnoreCase) &&
                    candidateFull.StartsWith(
                        parentFull + Path.DirectorySeparatorChar,
                        StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static bool IsExpectedBackupPath(string backupPath, string currentExecutable)
        {
            try
            {
                string backupFull = Path.GetFullPath(backupPath);
                string currentFull = Path.GetFullPath(currentExecutable);
                string prefix = currentFull + ".previous-";
                return backupFull.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
                    backupFull.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
                    String.Equals(
                        Path.GetDirectoryName(backupFull),
                        Path.GetDirectoryName(currentFull),
                        StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static bool IsReparsePoint(string path)
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }

        private static string GetCurrentExecutablePath()
        {
            return Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        }

        private static string ReadArgumentValue(string[] args, string name)
        {
            if (args == null)
            {
                return null;
            }
            for (int index = 0; index < args.Length; index++)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                {
                    return index + 1 < args.Length ? args[index + 1] : String.Empty;
                }
            }
            return null;
        }

        private static bool HasArgument(string[] args, string name)
        {
            if (args == null)
            {
                return false;
            }
            for (int index = 0; index < args.Length; index++)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static string QuoteArgument(string value)
        {
            if (value.IndexOf('\"') >= 0)
            {
                throw new InvalidOperationException("启动器更新路径包含无效字符。");
            }
            return "\"" + value + "\"";
        }

        private static void TryDeleteFile(string path)
        {
            try
            {
                if (!String.IsNullOrWhiteSpace(path) && File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
            }
        }

        private static void Report(
            IProgress<LauncherUpdateProgress> progress,
            string stage,
            string message,
            int percent,
            long downloaded,
            long total,
            string detail)
        {
            if (progress != null)
            {
                progress.Report(new LauncherUpdateProgress(
                    stage, message, percent, downloaded, total, detail));
            }
        }
    }

    internal sealed class LauncherApplyUpdateRequest
    {
        public int SchemaVersion { get; set; }
        public string TargetPath { get; set; }
        public string HelperPath { get; set; }
        public int OldProcessId { get; set; }
        public string ExpectedCurrentSha256 { get; set; }
        public string ExpectedNewSha256 { get; set; }
        public long ExpectedNewSize { get; set; }
    }

    internal sealed class LauncherDownloadAttempt
    {
        public bool Succeeded { get; private set; }
        public string Provider { get; private set; }
        public string Path { get; private set; }
        public string Error { get; private set; }

        public static LauncherDownloadAttempt Success(string provider, string path)
        {
            return new LauncherDownloadAttempt
            {
                Succeeded = true,
                Provider = provider,
                Path = path,
                Error = String.Empty
            };
        }

        public static LauncherDownloadAttempt Failure(string provider, string error)
        {
            return new LauncherDownloadAttempt
            {
                Succeeded = false,
                Provider = provider,
                Error = error,
                Path = String.Empty
            };
        }
    }

    internal sealed class LauncherUpdateCheckResult
    {
        public LauncherUpdateManifest Manifest { get; private set; }
        public bool ReachedSource { get; private set; }

        public LauncherUpdateCheckResult(LauncherUpdateManifest manifest, bool reachedSource)
        {
            Manifest = manifest;
            ReachedSource = reachedSource;
        }
    }

    internal sealed class LauncherUpdateProgress
    {
        public string Stage { get; private set; }
        public string Message { get; private set; }
        public int Percent { get; private set; }
        public long Downloaded { get; private set; }
        public long Total { get; private set; }
        public string Detail { get; private set; }

        public LauncherUpdateProgress(
            string stage,
            string message,
            int percent,
            long downloaded,
            long total,
            string detail)
        {
            Stage = stage;
            Message = message;
            Percent = percent;
            Downloaded = downloaded;
            Total = total;
            Detail = detail;
        }
    }

    internal sealed class LauncherUpdateBootstrapWindow : Window
    {
        private readonly TextBlock status;
        private readonly TextBlock detail;
        private readonly ProgressBar progress;
        private readonly Button retry;
        private readonly Button continueButton;
        private bool busy;
        private bool started;

        public bool ShouldRestart { get; private set; }

        public LauncherUpdateBootstrapWindow()
        {
            Title = LauncherConstants.ProductName;
            Width = 620;
            Height = 360;
            MinWidth = 620;
            MinHeight = 360;
            MaxWidth = 620;
            MaxHeight = 360;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            Background = new SolidColorBrush(Color.FromRgb(8, 12, 18));
            ShowInTaskbar = true;

            Grid root = new Grid();
            root.Margin = new Thickness(34);
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Content = root;

            StackPanel heading = new StackPanel();
            TextBlock eyebrow = new TextBlock();
            eyebrow.Text = "DEEPFACELABSN · LAUNCHER UPDATE";
            eyebrow.FontSize = 11;
            eyebrow.FontWeight = FontWeights.SemiBold;
            eyebrow.Foreground = new SolidColorBrush(Color.FromRgb(71, 205, 171));
            heading.Children.Add(eyebrow);

            TextBlock title = new TextBlock();
            title.Text = "正在检查启动器更新";
            title.FontSize = 25;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = Brushes.White;
            title.Margin = new Thickness(0, 12, 0, 8);
            heading.Children.Add(title);

            TextBlock intro = new TextBlock();
            intro.Text = "启动器更新独立于项目源码。下载完成后会校验 SHA-256，安全替换并自动重新打开。";
            intro.FontSize = 13;
            intro.LineHeight = 20;
            intro.TextWrapping = TextWrapping.Wrap;
            intro.Foreground = new SolidColorBrush(Color.FromRgb(155, 173, 194));
            heading.Children.Add(intro);
            root.Children.Add(heading);

            Border card = new Border();
            card.Margin = new Thickness(0, 24, 0, 20);
            card.Padding = new Thickness(20);
            card.CornerRadius = new CornerRadius(12);
            card.Background = new SolidColorBrush(Color.FromRgb(14, 21, 31));
            card.BorderBrush = new SolidColorBrush(Color.FromRgb(31, 45, 61));
            card.BorderThickness = new Thickness(1);
            Grid.SetRow(card, 1);
            root.Children.Add(card);

            StackPanel cardContent = new StackPanel();
            card.Child = cardContent;
            status = new TextBlock();
            status.Text = "正在连接 GitHub 与 Gitee…";
            status.FontSize = 15;
            status.FontWeight = FontWeights.SemiBold;
            status.Foreground = Brushes.White;
            status.TextWrapping = TextWrapping.Wrap;
            cardContent.Children.Add(status);

            progress = new ProgressBar();
            progress.Height = 7;
            progress.Margin = new Thickness(0, 18, 0, 14);
            progress.Minimum = 0;
            progress.Maximum = 100;
            progress.IsIndeterminate = true;
            progress.Foreground = new SolidColorBrush(Color.FromRgb(71, 205, 171));
            progress.Background = new SolidColorBrush(Color.FromRgb(25, 37, 51));
            cardContent.Children.Add(progress);

            detail = new TextBlock();
            detail.Text = "双源并行检查，不会影响项目源码和用户配置";
            detail.FontSize = 12;
            detail.Foreground = new SolidColorBrush(Color.FromRgb(122, 143, 165));
            detail.TextWrapping = TextWrapping.Wrap;
            cardContent.Children.Add(detail);

            Grid actions = new Grid();
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetRow(actions, 2);
            root.Children.Add(actions);

            TextBlock assurance = new TextBlock();
            assurance.Text = "HTTPS · SHA-256 · 安全回滚";
            assurance.FontSize = 11;
            assurance.VerticalAlignment = VerticalAlignment.Center;
            assurance.Foreground = new SolidColorBrush(Color.FromRgb(92, 112, 134));
            actions.Children.Add(assurance);

            retry = CreateButton("重试", true);
            retry.Visibility = Visibility.Collapsed;
            retry.Margin = new Thickness(8, 0, 0, 0);
            retry.Click += delegate { BeginAttempt(); };
            Grid.SetColumn(retry, 1);
            actions.Children.Add(retry);

            continueButton = CreateButton("继续使用当前版本", false);
            continueButton.Visibility = Visibility.Collapsed;
            continueButton.Margin = new Thickness(8, 0, 0, 0);
            continueButton.Click += delegate
            {
                if (!busy)
                {
                    DialogResult = true;
                }
            };
            Grid.SetColumn(continueButton, 2);
            actions.Children.Add(continueButton);

            MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs args)
            {
                if (args.ButtonState == MouseButtonState.Pressed)
                {
                    try { DragMove(); } catch { }
                }
            };
            Closing += OnClosing;
            Loaded += delegate
            {
                if (!started)
                {
                    started = true;
                    BeginAttempt();
                }
            };
        }

        private async void BeginAttempt()
        {
            if (busy)
            {
                return;
            }
            busy = true;
            retry.Visibility = Visibility.Collapsed;
            continueButton.Visibility = Visibility.Collapsed;
            status.Foreground = Brushes.White;
            progress.IsIndeterminate = true;
            Progress<LauncherUpdateProgress> reporter =
                new Progress<LauncherUpdateProgress>(OnProgress);
            try
            {
                Version current = Assembly.GetExecutingAssembly().GetName().Version;
                LauncherUpdateCheckResult check = await LauncherSelfUpdater.FindUpdateAsync(current, reporter);
                LauncherUpdateManifest manifest = check.Manifest;
                if (manifest == null)
                {
                    status.Text = check.ReachedSource
                        ? "启动器已是最新版本"
                        : "暂时未连接到更新源";
                    detail.Text = check.ReachedSource
                        ? "正在进入启动器…"
                        : "不影响本次使用，正在继续启动…";
                    progress.IsIndeterminate = false;
                    progress.Value = 100;
                    await Task.Delay(180);
                    busy = false;
                    DialogResult = true;
                    return;
                }

                status.Text = "发现启动器 " + manifest.VersionText;
                detail.Text = "GitHub / Gitee 并行下载，任一可信源成功即可";
                string downloaded = await LauncherSelfUpdater.DownloadUpdateAsync(manifest, reporter);
                status.Text = "正在切换到新版启动器…";
                detail.Text = "当前窗口将关闭，新版会自动继续启动";
                LauncherSelfUpdater.LaunchReplacement(downloaded, manifest);
                ShouldRestart = true;
                busy = false;
                DialogResult = true;
            }
            catch (Exception error)
            {
                busy = false;
                status.Text = "暂时无法更新启动器";
                status.Foreground = new SolidColorBrush(Color.FromRgb(255, 118, 118));
                detail.Text = error.Message;
                progress.IsIndeterminate = false;
                progress.Value = 0;
                retry.Visibility = Visibility.Visible;
                continueButton.Visibility = Visibility.Visible;
            }
        }

        private void OnProgress(LauncherUpdateProgress value)
        {
            status.Text = value.Message;
            detail.Text = value.Detail;
            if (value.Percent >= 0)
            {
                progress.IsIndeterminate = false;
                progress.Value = Math.Max(0, Math.Min(100, value.Percent));
            }
            else
            {
                progress.IsIndeterminate = true;
            }
            if (value.Downloaded > 0)
            {
                detail.Text = value.Detail + " · " + FormatBytes(value.Downloaded) +
                    (value.Total > 0 ? " / " + FormatBytes(value.Total) : String.Empty);
            }
        }

        private void OnClosing(object sender, CancelEventArgs args)
        {
            if (busy)
            {
                args.Cancel = true;
            }
        }

        private static Button CreateButton(string text, bool primary)
        {
            Button button = new Button();
            button.Content = text;
            button.MinWidth = 88;
            button.Height = 36;
            button.Padding = new Thickness(16, 0, 16, 0);
            button.FontSize = 13;
            button.FontWeight = FontWeights.SemiBold;
            button.BorderThickness = new Thickness(1);
            button.Foreground = primary
                ? new SolidColorBrush(Color.FromRgb(7, 24, 22))
                : new SolidColorBrush(Color.FromRgb(196, 209, 223));
            button.Background = primary
                ? new SolidColorBrush(Color.FromRgb(71, 205, 171))
                : new SolidColorBrush(Color.FromRgb(19, 29, 42));
            button.BorderBrush = primary
                ? new SolidColorBrush(Color.FromRgb(71, 205, 171))
                : new SolidColorBrush(Color.FromRgb(46, 64, 83));
            return button;
        }

        private static string FormatBytes(long value)
        {
            if (value >= 1024L * 1024L)
            {
                return (value / (1024d * 1024d)).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
            }
            return (value / 1024d).ToString("0.0", CultureInfo.InvariantCulture) + " KB";
        }
    }
}
