using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace DeepFaceLabSN.Launcher
{
    internal static class WebView2RuntimeBootstrapper
    {
        internal const string BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        private const string WebViewClientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        private const long MaximumBootstrapperBytes = 64L * 1024L * 1024L;
        private const long MinimumBootstrapperBytes = 128L * 1024L;
        private const string InstallMutexName = "Local\\DeepFaceLabSN.Launcher.WebView2Runtime";

        private static readonly string[] RegistryPaths =
        {
            "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\" + WebViewClientId,
            "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\" + WebViewClientId
        };

        public static bool EnsureInstalled()
        {
            if (IsRuntimeInstalled())
            {
                return true;
            }

            WebView2RuntimeBootstrapWindow window = new WebView2RuntimeBootstrapWindow();
            bool? result = window.ShowDialog();
            return result == true && IsRuntimeInstalled();
        }

        internal static bool IsRuntimeInstalled()
        {
            return !String.IsNullOrWhiteSpace(GetInstalledVersion());
        }

        internal static string GetInstalledVersion()
        {
            RegistryHive[] hives = { RegistryHive.LocalMachine, RegistryHive.CurrentUser };
            RegistryView[] views = Environment.Is64BitOperatingSystem
                ? new[] { RegistryView.Registry64, RegistryView.Registry32 }
                : new[] { RegistryView.Registry32 };

            for (int hiveIndex = 0; hiveIndex < hives.Length; hiveIndex++)
            {
                for (int viewIndex = 0; viewIndex < views.Length; viewIndex++)
                {
                    for (int pathIndex = 0; pathIndex < RegistryPaths.Length; pathIndex++)
                    {
                        string value = ReadRegistryVersion(hives[hiveIndex], views[viewIndex], RegistryPaths[pathIndex]);
                        if (IsUsableVersion(value))
                        {
                            return value;
                        }
                    }
                }
            }
            return null;
        }

        internal static bool IsUsableVersion(string value)
        {
            Version version;
            return !String.IsNullOrWhiteSpace(value)
                && Version.TryParse(value.Trim(), out version)
                && version > new Version(0, 0, 0, 0);
        }

        internal static bool IsOfficialMicrosoftDownloadUri(Uri uri)
        {
            if (uri == null
                || !String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                || !uri.IsDefaultPort
                || !String.IsNullOrEmpty(uri.UserInfo))
            {
                return false;
            }

            string host = uri.DnsSafeHost;
            return String.Equals(host, "go.microsoft.com", StringComparison.OrdinalIgnoreCase)
                || String.Equals(host, "download.microsoft.com", StringComparison.OrdinalIgnoreCase)
                || host.EndsWith(".microsoft.com", StringComparison.OrdinalIgnoreCase);
        }

        internal static InstallerSignatureInfo VerifyInstallerAuthenticity(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                throw new FileNotFoundException("WebView2 安装程序不存在。", path);
            }

            int trustStatus = VerifyEmbeddedSignature(path);
            if (trustStatus != 0)
            {
                throw new SecurityException(
                    "WebView2 安装程序的 Authenticode 校验失败（0x"
                    + trustStatus.ToString("X8", CultureInfo.InvariantCulture) + "）。");
            }

            X509Certificate2 certificate;
            try
            {
                certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            }
            catch (Exception error)
            {
                throw new SecurityException("无法读取 WebView2 安装程序的签名证书。", error);
            }

            using (certificate)
            {
                string signer = certificate.GetNameInfo(X509NameType.SimpleName, false);
                if (!String.Equals(signer, "Microsoft Corporation", StringComparison.OrdinalIgnoreCase))
                {
                    throw new SecurityException("WebView2 安装程序不是 Microsoft Corporation 签名。");
                }
                if (!HasCodeSigningUsage(certificate))
                {
                    throw new SecurityException("WebView2 安装程序签名证书不允许代码签名。");
                }

                return new InstallerSignatureInfo(
                    signer,
                    certificate.Thumbprint ?? String.Empty,
                    ComputeFileSha256(path));
            }
        }

        internal static async Task InstallAsync(IProgress<WebView2BootstrapProgress> progress)
        {
            if (IsRuntimeInstalled())
            {
                Report(progress, "ready", "Microsoft Edge WebView2 Runtime 已安装。", 100, 1, 1);
                return;
            }

            bool ownsMutex = false;
            using (Mutex mutex = new Mutex(false, InstallMutexName))
            {
                try
                {
                    try
                    {
                        ownsMutex = mutex.WaitOne(0);
                    }
                    catch (AbandonedMutexException)
                    {
                        ownsMutex = true;
                    }

                    if (!ownsMutex)
                    {
                        Report(progress, "waiting", "另一个启动器正在安装 WebView2 Runtime，正在等待…", -1, 0, 0);
                        for (int attempt = 0; attempt < 120; attempt++)
                        {
                            if (IsRuntimeInstalled())
                            {
                                Report(progress, "ready", "Microsoft Edge WebView2 Runtime 已安装。", 100, 1, 1);
                                return;
                            }
                            await Task.Delay(1000);
                        }
                        throw new TimeoutException("等待另一个 WebView2 Runtime 安装进程超时。");
                    }

                    if (IsRuntimeInstalled())
                    {
                        Report(progress, "ready", "Microsoft Edge WebView2 Runtime 已安装。", 100, 1, 1);
                        return;
                    }

                    await DownloadVerifyAndInstallAsync(progress);
                }
                finally
                {
                    if (ownsMutex)
                    {
                        mutex.ReleaseMutex();
                    }
                }
            }
        }

        private static async Task DownloadVerifyAndInstallAsync(IProgress<WebView2BootstrapProgress> progress)
        {
            string temporaryDirectory = CreateSafeTemporaryDirectory();
            string installerPath = Path.Combine(temporaryDirectory, "MicrosoftEdgeWebview2Setup.exe");
            try
            {
                ServicePointManager.SecurityProtocol =
                    ServicePointManager.SecurityProtocol | SecurityProtocolType.Tls12;
                Report(progress, "download", "正在从 Microsoft 下载 WebView2 Runtime 安装程序…", 0, 0, 0);
                await DownloadInstallerAsync(new Uri(BootstrapperUrl), installerPath, progress);

                Report(progress, "verify", "正在验证 Microsoft Authenticode 签名…", -1, 0, 0);
                using (FileStream installerLock = new FileStream(
                    installerPath,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    4096,
                    FileOptions.SequentialScan))
                {
                    InstallerSignatureInfo signature = VerifyInstallerAuthenticity(installerPath);
                    Report(
                        progress,
                        "verify",
                        "签名有效：" + signature.Signer + "；正在启动静默安装…",
                        -1,
                        0,
                        0);

                    int exitCode = await RunInstallerAsync(installerPath, temporaryDirectory);
                    if (exitCode != 0 && exitCode != 3010)
                    {
                        throw new InvalidOperationException(
                            "WebView2 Runtime 安装程序返回退出码 "
                            + exitCode.ToString(CultureInfo.InvariantCulture) + "。");
                    }
                }

                Report(progress, "checking", "安装程序已完成，正在确认 WebView2 Runtime…", -1, 0, 0);
                for (int attempt = 0; attempt < 45; attempt++)
                {
                    string version = GetInstalledVersion();
                    if (!String.IsNullOrWhiteSpace(version))
                    {
                        Report(progress, "ready", "WebView2 Runtime " + version + " 已就绪。", 100, 1, 1);
                        return;
                    }
                    await Task.Delay(1000);
                }
                throw new InvalidOperationException("安装程序已结束，但仍未检测到 WebView2 Runtime。");
            }
            finally
            {
                TryDeleteTemporaryDirectory(temporaryDirectory);
            }
        }

        private static async Task DownloadInstallerAsync(
            Uri initialUri,
            string destinationPath,
            IProgress<WebView2BootstrapProgress> progress)
        {
            if (!IsOfficialMicrosoftDownloadUri(initialUri))
            {
                throw new SecurityException("WebView2 下载地址不是受信任的 Microsoft HTTPS 地址。");
            }

            Uri current = initialUri;
            for (int redirect = 0; redirect < 8; redirect++)
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(current);
                request.Method = "GET";
                request.AllowAutoRedirect = false;
                request.UserAgent = "DeepFaceLabSN-Launcher/0.1 WebView2Bootstrap";
                request.AutomaticDecompression = DecompressionMethods.None;
                request.Timeout = 45000;
                request.ReadWriteTimeout = 30000;
                request.Proxy = WebRequest.GetSystemWebProxy();
                if (request.Proxy != null)
                {
                    request.Proxy.Credentials = CredentialCache.DefaultCredentials;
                }

                HttpWebResponse response = await GetResponseWithTimeoutAsync(request);
                using (response)
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode >= 300 && statusCode <= 399)
                    {
                        string location = response.Headers[HttpResponseHeader.Location];
                        if (String.IsNullOrWhiteSpace(location))
                        {
                            throw new InvalidDataException("Microsoft 下载服务返回了无目标地址的重定向。");
                        }
                        Uri next = new Uri(current, location);
                        if (!IsOfficialMicrosoftDownloadUri(next))
                        {
                            throw new SecurityException("WebView2 下载被重定向到非 Microsoft HTTPS 地址。");
                        }
                        current = next;
                        continue;
                    }
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        throw new WebException(
                            "Microsoft 下载服务返回 HTTP "
                            + statusCode.ToString(CultureInfo.InvariantCulture) + "。");
                    }
                    if (!IsOfficialMicrosoftDownloadUri(response.ResponseUri))
                    {
                        throw new SecurityException("WebView2 安装程序响应来自非 Microsoft HTTPS 地址。");
                    }

                    long total = response.ContentLength;
                    if (total > MaximumBootstrapperBytes)
                    {
                        throw new InvalidDataException("WebView2 安装程序超过允许的最大大小。");
                    }

                    long downloaded = 0;
                    using (Stream source = response.GetResponseStream())
                    using (FileStream output = new FileStream(
                        destinationPath,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        65536,
                        FileOptions.SequentialScan | FileOptions.WriteThrough))
                    {
                        byte[] buffer = new byte[65536];
                        while (true)
                        {
                            int count = await ReadWithTimeoutAsync(source, buffer, request);
                            if (count <= 0)
                            {
                                break;
                            }
                            downloaded += count;
                            if (downloaded > MaximumBootstrapperBytes)
                            {
                                throw new InvalidDataException("WebView2 安装程序超过允许的最大大小。");
                            }
                            await output.WriteAsync(buffer, 0, count);
                            int percent = total > 0
                                ? (int)Math.Min(99, downloaded * 100L / total)
                                : -1;
                            Report(
                                progress,
                                "download",
                                "正在下载 WebView2 Runtime 安装程序…",
                                percent,
                                downloaded,
                                total);
                        }
                        output.Flush(true);
                    }

                    if (downloaded < MinimumBootstrapperBytes)
                    {
                        throw new InvalidDataException("下载的 WebView2 安装程序大小异常。");
                    }
                    if (total > 0 && downloaded != total)
                    {
                        throw new EndOfStreamException("WebView2 安装程序下载不完整。");
                    }
                    Report(progress, "download", "WebView2 安装程序下载完成。", 100, downloaded, total);
                    return;
                }
            }
            throw new WebException("Microsoft 下载服务重定向次数过多。");
        }

        private static async Task<HttpWebResponse> GetResponseWithTimeoutAsync(HttpWebRequest request)
        {
            Task<WebResponse> responseTask = request.GetResponseAsync();
            Task completed = await Task.WhenAny(responseTask, Task.Delay(45000));
            if (!Object.ReferenceEquals(completed, responseTask))
            {
                request.Abort();
                throw new TimeoutException("连接 Microsoft 下载服务超时。");
            }
            return (HttpWebResponse)await responseTask;
        }

        private static async Task<int> ReadWithTimeoutAsync(Stream source, byte[] buffer, HttpWebRequest request)
        {
            Task<int> readTask = source.ReadAsync(buffer, 0, buffer.Length);
            Task completed = await Task.WhenAny(readTask, Task.Delay(30000));
            if (!Object.ReferenceEquals(completed, readTask))
            {
                request.Abort();
                throw new TimeoutException("下载 WebView2 安装程序时连接超时。");
            }
            return await readTask;
        }

        private static Task<int> RunInstallerAsync(string installerPath, string workingDirectory)
        {
            return Task.Run(delegate
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = installerPath;
                startInfo.Arguments = "/silent /install";
                startInfo.WorkingDirectory = workingDirectory;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                using (Process process = new Process())
                {
                    process.StartInfo = startInfo;
                    if (!process.Start())
                    {
                        throw new InvalidOperationException("无法启动 WebView2 Runtime 安装程序。");
                    }
                    if (!process.WaitForExit(10 * 60 * 1000))
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch
                        {
                        }
                        throw new TimeoutException("WebView2 Runtime 安装超过 10 分钟。");
                    }
                    return process.ExitCode;
                }
            });
        }

        private static string ReadRegistryVersion(RegistryHive hive, RegistryView view, string path)
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey key = baseKey.OpenSubKey(path, false))
                {
                    return key == null ? null : Convert.ToString(key.GetValue("pv"));
                }
            }
            catch
            {
                return null;
            }
        }

        private static bool HasCodeSigningUsage(X509Certificate2 certificate)
        {
            for (int index = 0; index < certificate.Extensions.Count; index++)
            {
                X509EnhancedKeyUsageExtension usage =
                    certificate.Extensions[index] as X509EnhancedKeyUsageExtension;
                if (usage == null)
                {
                    continue;
                }
                for (int oidIndex = 0; oidIndex < usage.EnhancedKeyUsages.Count; oidIndex++)
                {
                    if (String.Equals(
                        usage.EnhancedKeyUsages[oidIndex].Value,
                        "1.3.6.1.5.5.7.3.3",
                        StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        private static string ComputeFileSha256(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] hash = sha.ComputeHash(stream);
                return BitConverter.ToString(hash).Replace("-", String.Empty).ToLowerInvariant();
            }
        }

        private static string CreateSafeTemporaryDirectory()
        {
            string parent = Path.GetFullPath(Path.GetTempPath())
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string directory = Path.Combine(
                parent,
                "DeepFaceLabSN-WebView2-" + Guid.NewGuid().ToString("N"));
            string fullPath = Path.GetFullPath(directory);
            if (!fullPath.StartsWith(
                parent + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("无法创建安全的 WebView2 临时目录。");
            }
            Directory.CreateDirectory(fullPath);
            return fullPath;
        }

        private static void TryDeleteTemporaryDirectory(string path)
        {
            try
            {
                string parent = Path.GetFullPath(Path.GetTempPath())
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string target = Path.GetFullPath(path)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string expectedPrefix = parent + Path.DirectorySeparatorChar + "DeepFaceLabSN-WebView2-";
                if (!target.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                if (Directory.Exists(target))
                {
                    Directory.Delete(target, true);
                }
            }
            catch
            {
            }
        }

        private static void Report(
            IProgress<WebView2BootstrapProgress> progress,
            string stage,
            string message,
            int percent,
            long downloaded,
            long total)
        {
            if (progress != null)
            {
                progress.Report(new WebView2BootstrapProgress(
                    stage,
                    message,
                    percent,
                    downloaded,
                    total));
            }
        }

        private static int VerifyEmbeddedSignature(string filePath)
        {
            Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
            WINTRUST_FILE_INFO fileInfo = new WINTRUST_FILE_INFO();
            fileInfo.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
            fileInfo.pcwszFilePath = Marshal.StringToCoTaskMemUni(filePath);

            IntPtr fileInfoPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);

            WINTRUST_DATA trustData = new WINTRUST_DATA();
            trustData.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
            trustData.dwUIChoice = 2;
            trustData.fdwRevocationChecks = 1;
            trustData.dwUnionChoice = 1;
            trustData.pFile = fileInfoPointer;
            trustData.dwStateAction = 1;
            trustData.dwProvFlags = 0x00000080;
            trustData.dwUIContext = 0;

            try
            {
                int result = WinVerifyTrust(IntPtr.Zero, ref action, ref trustData);
                trustData.dwStateAction = 2;
                WinVerifyTrust(IntPtr.Zero, ref action, ref trustData);
                return result;
            }
            finally
            {
                Marshal.DestroyStructure(fileInfoPointer, typeof(WINTRUST_FILE_INFO));
                Marshal.FreeHGlobal(fileInfoPointer);
                Marshal.FreeCoTaskMem(fileInfo.pcwszFilePath);
            }
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(
            IntPtr hwnd,
            ref Guid actionId,
            ref WINTRUST_DATA trustData);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            public IntPtr pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
        }
    }

    internal sealed class InstallerSignatureInfo
    {
        public string Signer { get; private set; }
        public string Thumbprint { get; private set; }
        public string Sha256 { get; private set; }

        public InstallerSignatureInfo(string signer, string thumbprint, string sha256)
        {
            Signer = signer;
            Thumbprint = thumbprint;
            Sha256 = sha256;
        }
    }

    internal sealed class WebView2BootstrapProgress
    {
        public string Stage { get; private set; }
        public string Message { get; private set; }
        public int Percent { get; private set; }
        public long Downloaded { get; private set; }
        public long Total { get; private set; }

        public WebView2BootstrapProgress(
            string stage,
            string message,
            int percent,
            long downloaded,
            long total)
        {
            Stage = stage;
            Message = message;
            Percent = percent;
            Downloaded = downloaded;
            Total = total;
        }
    }

    internal sealed class WebView2RuntimeBootstrapWindow : Window
    {
        private readonly TextBlock status;
        private readonly TextBlock detail;
        private readonly ProgressBar progress;
        private readonly Button retry;
        private readonly Button exit;
        private bool busy;
        private bool started;

        public WebView2RuntimeBootstrapWindow()
        {
            Title = LauncherConstants.ProductName;
            Width = 620;
            Height = 390;
            MinWidth = 620;
            MinHeight = 390;
            MaxWidth = 620;
            MaxHeight = 390;
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
            eyebrow.Text = "DEEPFACELABSN · FIRST START";
            eyebrow.FontSize = 11;
            eyebrow.FontWeight = FontWeights.SemiBold;
            eyebrow.Foreground = new SolidColorBrush(Color.FromRgb(71, 205, 171));
            heading.Children.Add(eyebrow);

            TextBlock title = new TextBlock();
            title.Text = "正在准备 WebView2 Runtime";
            title.FontSize = 25;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = Brushes.White;
            title.Margin = new Thickness(0, 12, 0, 8);
            heading.Children.Add(title);

            TextBlock intro = new TextBlock();
            intro.Text = "首次启动需要 Microsoft Edge WebView2 Runtime。启动器只会从 Microsoft 官方地址下载，并在安装前验证数字签名。";
            intro.FontSize = 13;
            intro.LineHeight = 20;
            intro.TextWrapping = TextWrapping.Wrap;
            intro.Foreground = new SolidColorBrush(Color.FromRgb(155, 173, 194));
            heading.Children.Add(intro);
            root.Children.Add(heading);

            Border card = new Border();
            card.Margin = new Thickness(0, 28, 0, 22);
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
            status.Text = "正在检测运行环境…";
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
            detail.Text = "官方源：go.microsoft.com";
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
            assurance.Text = "Microsoft HTTPS · Authenticode · 静默安装";
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

            exit = CreateButton("退出", false);
            exit.Margin = new Thickness(8, 0, 0, 0);
            exit.Click += delegate
            {
                if (!busy)
                {
                    DialogResult = false;
                }
            };
            Grid.SetColumn(exit, 2);
            actions.Children.Add(exit);

            MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs args)
            {
                if (args.ButtonState == MouseButtonState.Pressed)
                {
                    try
                    {
                        DragMove();
                    }
                    catch
                    {
                    }
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
            exit.IsEnabled = false;
            status.Foreground = Brushes.White;
            progress.IsIndeterminate = true;
            detail.Text = "官方源：go.microsoft.com";

            Progress<WebView2BootstrapProgress> reporter =
                new Progress<WebView2BootstrapProgress>(OnProgress);
            try
            {
                await WebView2RuntimeBootstrapper.InstallAsync(reporter);
                status.Text = "WebView2 Runtime 已就绪";
                detail.Text = "正在进入 DeepFaceLabSN Launcher…";
                progress.IsIndeterminate = false;
                progress.Value = 100;
                await Task.Delay(350);
                busy = false;
                DialogResult = true;
            }
            catch (Exception error)
            {
                busy = false;
                status.Text = "WebView2 Runtime 安装失败";
                status.Foreground = new SolidColorBrush(Color.FromRgb(255, 118, 118));
                detail.Text = error.Message;
                progress.IsIndeterminate = false;
                progress.Value = 0;
                retry.Visibility = Visibility.Visible;
                exit.IsEnabled = true;
            }
        }

        private void OnProgress(WebView2BootstrapProgress value)
        {
            status.Text = value.Message;
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
                string downloaded = FormatBytes(value.Downloaded);
                detail.Text = value.Total > 0
                    ? downloaded + " / " + FormatBytes(value.Total) + " · Microsoft 官方源"
                    : downloaded + " · Microsoft 官方源";
            }
            else
            {
                detail.Text = "官方源：go.microsoft.com · 安装前验证 Microsoft 数字签名";
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
