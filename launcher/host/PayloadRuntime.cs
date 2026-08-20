using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class PayloadRuntime
    {
        private const string ManifestResourceName = "DeepFaceLabSN.Launcher.Payload.Manifest";
        private const string ManifestHeader = "DFLSN_PAYLOAD_V1";
        private const string CompleteMarkerName = ".complete";
        private readonly object assemblyGate = new object();
        private readonly Dictionary<string, Assembly> loadedAssemblies = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);
        private readonly string payloadRoot;
        private IntPtr nativeLoader;

        private PayloadRuntime(string payloadRoot)
        {
            this.payloadRoot = payloadRoot;
        }

        public string Root
        {
            get { return payloadRoot; }
        }

        public static PayloadRuntime Prepare()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            PayloadManifest manifest = ReadManifest(assembly);
            string parent = LauncherConstants.SettingsDirectory;
            Directory.CreateDirectory(parent);
            string finalRoot = Path.Combine(parent, "payload-" + manifest.BuildId);
            string mutexName = "Local\\DeepFaceLabSN.Launcher.Payload." + manifest.BuildId;

            bool acquired = false;
            using (Mutex mutex = new Mutex(false, mutexName))
            {
                try
                {
                    try
                    {
                        acquired = mutex.WaitOne(TimeSpan.FromMinutes(2));
                    }
                    catch (AbandonedMutexException)
                    {
                        acquired = true;
                    }
                    if (!acquired)
                    {
                        throw new TimeoutException("等待启动器资源解包超时。");
                    }

                    if (!VerifyPayload(finalRoot, manifest))
                    {
                        ExtractPayloadAtomically(assembly, finalRoot, manifest);
                    }
                }
                finally
                {
                    if (acquired)
                    {
                        mutex.ReleaseMutex();
                    }
                }
            }

            PayloadRuntime runtime = new PayloadRuntime(finalRoot);
            runtime.RegisterAssemblyResolver();
            runtime.ActivateNativeLoader();
            LauncherPayload.Initialize(finalRoot);
            return runtime;
        }

        private void RegisterAssemblyResolver()
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolvePayloadAssembly;
        }

        private Assembly ResolvePayloadAssembly(object sender, ResolveEventArgs args)
        {
            string name;
            try
            {
                name = new AssemblyName(args.Name).Name;
            }
            catch
            {
                return null;
            }

            string fileName;
            if (String.Equals(name, "Microsoft.Web.WebView2.Core", StringComparison.OrdinalIgnoreCase))
            {
                fileName = "Microsoft.Web.WebView2.Core.dll";
            }
            else if (String.Equals(name, "Microsoft.Web.WebView2.Wpf", StringComparison.OrdinalIgnoreCase))
            {
                fileName = "Microsoft.Web.WebView2.Wpf.dll";
            }
            else
            {
                return null;
            }

            lock (assemblyGate)
            {
                Assembly loaded;
                if (loadedAssemblies.TryGetValue(name, out loaded))
                {
                    return loaded;
                }
                string path = Path.Combine(payloadRoot, fileName);
                if (!File.Exists(path))
                {
                    return null;
                }
                loaded = Assembly.LoadFrom(path);
                loadedAssemblies[name] = loaded;
                return loaded;
            }
        }

        private void ActivateNativeLoader()
        {
            if (!SetDllDirectory(payloadRoot))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法设置启动器原生 DLL 搜索目录。");
            }
            string loaderPath = Path.Combine(payloadRoot, "WebView2Loader.dll");
            nativeLoader = LoadLibrary(loaderPath);
            if (nativeLoader == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法加载 WebView2Loader.dll。");
            }
        }

        private static PayloadManifest ReadManifest(Assembly assembly)
        {
            using (Stream stream = assembly.GetManifestResourceStream(ManifestResourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("启动器内嵌资源清单缺失。");
                }
                using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false), true))
                {
                    string header = reader.ReadLine();
                    string[] headerParts = String.IsNullOrWhiteSpace(header) ? new string[0] : header.Split('\t');
                    if (headerParts.Length != 2 || !String.Equals(headerParts[0], ManifestHeader, StringComparison.Ordinal))
                    {
                        throw new InvalidDataException("启动器内嵌资源清单格式无效。");
                    }
                    string buildId = headerParts[1].Trim();
                    if (!IsSafeBuildId(buildId))
                    {
                        throw new InvalidDataException("启动器内嵌资源 build-id 无效。");
                    }

                    List<PayloadEntry> entries = new List<PayloadEntry>();
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (String.IsNullOrWhiteSpace(line))
                        {
                            continue;
                        }
                        string[] parts = line.Split('\t');
                        long length;
                        if (parts.Length != 5
                            || !String.Equals(parts[0], "F", StringComparison.Ordinal)
                            || !Int64.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out length)
                            || length < 0
                            || !IsSha256(parts[3]))
                        {
                            throw new InvalidDataException("启动器内嵌资源条目无效。");
                        }
                        ValidateRelativePath(parts[1]);
                        entries.Add(new PayloadEntry(parts[1], length, parts[3], parts[4]));
                    }
                    if (entries.Count == 0)
                    {
                        throw new InvalidDataException("启动器内嵌资源清单为空。");
                    }
                    return new PayloadManifest(buildId, entries);
                }
            }
        }

        private static bool VerifyPayload(string root, PayloadManifest manifest)
        {
            try
            {
                string marker = Path.Combine(root, CompleteMarkerName);
                if (!File.Exists(marker)
                    || !String.Equals(File.ReadAllText(marker, Encoding.UTF8).Trim(), manifest.BuildId, StringComparison.Ordinal))
                {
                    return false;
                }
                for (int index = 0; index < manifest.Entries.Count; index++)
                {
                    PayloadEntry entry = manifest.Entries[index];
                    string path = ResolvePayloadPath(root, entry.RelativePath);
                    FileInfo file = new FileInfo(path);
                    if (!file.Exists || file.Length != entry.Length
                        || !String.Equals(ComputeFileHash(path), entry.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        return false;
                    }
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void ExtractPayloadAtomically(Assembly assembly, string finalRoot, PayloadManifest manifest)
        {
            string parent = Path.GetDirectoryName(finalRoot);
            string stagingRoot = finalRoot + ".staging-" + ProcessId() + "-" + Guid.NewGuid().ToString("N");
            string invalidRoot = null;
            try
            {
                Directory.CreateDirectory(stagingRoot);
                for (int index = 0; index < manifest.Entries.Count; index++)
                {
                    PayloadEntry entry = manifest.Entries[index];
                    string target = ResolvePayloadPath(stagingRoot, entry.RelativePath);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream resource = assembly.GetManifestResourceStream(entry.ResourceName))
                    {
                        if (resource == null)
                        {
                            throw new InvalidDataException("启动器内嵌资源缺失：" + entry.RelativePath);
                        }
                        using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            resource.CopyTo(output);
                            output.Flush(true);
                        }
                    }
                    FileInfo written = new FileInfo(target);
                    if (written.Length != entry.Length
                        || !String.Equals(ComputeFileHash(target), entry.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("启动器内嵌资源校验失败：" + entry.RelativePath);
                    }
                }

                string markerPath = Path.Combine(stagingRoot, CompleteMarkerName);
                using (FileStream markerStream = new FileStream(markerPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (StreamWriter markerWriter = new StreamWriter(markerStream, new UTF8Encoding(false)))
                {
                    markerWriter.Write(manifest.BuildId);
                    markerWriter.Flush();
                    markerStream.Flush(true);
                }

                if (Directory.Exists(finalRoot))
                {
                    invalidRoot = finalRoot + ".invalid-" + Guid.NewGuid().ToString("N");
                    Directory.Move(finalRoot, invalidRoot);
                }
                Directory.Move(stagingRoot, finalRoot);
                stagingRoot = null;
                if (!VerifyPayload(finalRoot, manifest))
                {
                    throw new InvalidDataException("启动器资源解包后的完整性校验失败。");
                }
                if (!String.IsNullOrWhiteSpace(invalidRoot))
                {
                    TryDeleteDirectory(invalidRoot, parent);
                    invalidRoot = null;
                }
            }
            catch
            {
                if (!String.IsNullOrWhiteSpace(invalidRoot)
                    && Directory.Exists(invalidRoot)
                    && !Directory.Exists(finalRoot))
                {
                    Directory.Move(invalidRoot, finalRoot);
                    invalidRoot = null;
                }
                throw;
            }
            finally
            {
                if (!String.IsNullOrWhiteSpace(stagingRoot))
                {
                    TryDeleteDirectory(stagingRoot, parent);
                }
            }
        }

        private static string ResolvePayloadPath(string root, string relativePath)
        {
            ValidateRelativePath(relativePath);
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(Path.Combine(fullRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            string prefix = fullRoot + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("启动器资源路径越界。");
            }
            return fullPath;
        }

        private static void ValidateRelativePath(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
            {
                throw new InvalidDataException("启动器资源相对路径无效。");
            }
            string[] parts = value.Replace('\\', '/').Split('/');
            for (int index = 0; index < parts.Length; index++)
            {
                if (String.IsNullOrWhiteSpace(parts[index])
                    || String.Equals(parts[index], ".", StringComparison.Ordinal)
                    || String.Equals(parts[index], "..", StringComparison.Ordinal))
                {
                    throw new InvalidDataException("启动器资源相对路径无效。");
                }
            }
        }

        private static string ComputeFileHash(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                return ToHex(sha.ComputeHash(stream));
            }
        }

        private static string ToHex(byte[] bytes)
        {
            StringBuilder value = new StringBuilder(bytes.Length * 2);
            for (int index = 0; index < bytes.Length; index++)
            {
                value.Append(bytes[index].ToString("x2", CultureInfo.InvariantCulture));
            }
            return value.ToString();
        }

        private static bool IsSafeBuildId(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length < 16 || value.Length > 64)
            {
                return false;
            }
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsSha256(string value)
        {
            return value != null && value.Length == 64 && IsSafeBuildId(value);
        }

        private static string ProcessId()
        {
            return System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
        }

        private static void TryDeleteDirectory(string path, string expectedParent)
        {
            try
            {
                string parent = Path.GetFullPath(expectedParent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string target = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (!target.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
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

        [DllImport("kernel32.dll", EntryPoint = "SetDllDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string path);

        [DllImport("kernel32.dll", EntryPoint = "LoadLibraryW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibrary(string path);

        private sealed class PayloadManifest
        {
            public string BuildId { get; private set; }
            public IList<PayloadEntry> Entries { get; private set; }

            public PayloadManifest(string buildId, IList<PayloadEntry> entries)
            {
                BuildId = buildId;
                Entries = entries;
            }
        }

        private sealed class PayloadEntry
        {
            public string RelativePath { get; private set; }
            public long Length { get; private set; }
            public string Sha256 { get; private set; }
            public string ResourceName { get; private set; }

            public PayloadEntry(string relativePath, long length, string sha256, string resourceName)
            {
                RelativePath = relativePath;
                Length = length;
                Sha256 = sha256;
                ResourceName = resourceName;
            }
        }
    }

    internal static class LauncherPayload
    {
        private static string root;

        public static string Root
        {
            get
            {
                if (String.IsNullOrWhiteSpace(root))
                {
                    throw new InvalidOperationException("启动器资源尚未初始化。");
                }
                return root;
            }
        }

        public static void Initialize(string value)
        {
            if (String.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentNullException("value");
            }
            root = Path.GetFullPath(value);
        }

        public static string GetPath(string relativePath)
        {
            string fullRoot = Root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(Path.Combine(fullRoot, relativePath));
            if (!fullPath.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("启动器资源路径越界。");
            }
            return fullPath;
        }
    }
}