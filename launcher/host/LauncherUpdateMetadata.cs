using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class LauncherUpdateSource
    {
        public string Provider { get; private set; }
        public Uri Uri { get; private set; }

        public LauncherUpdateSource(string provider, Uri uri)
        {
            Provider = provider;
            Uri = uri;
        }
    }

    internal sealed class LauncherUpdateManifest
    {
        public const int MaximumManifestBytes = 64 * 1024;
        public const long MinimumExecutableBytes = 1024 * 1024;
        public const long MaximumExecutableBytes = 64L * 1024L * 1024L;

        public Version Version { get; private set; }
        public string VersionText { get; private set; }
        public string Sha256 { get; private set; }
        public long Size { get; private set; }
        public IList<LauncherUpdateSource> Sources { get; private set; }

        private LauncherUpdateManifest()
        {
        }

        public static LauncherUpdateManifest Parse(string json)
        {
            if (String.IsNullOrWhiteSpace(json) || json.Length > MaximumManifestBytes)
            {
                throw new InvalidOperationException("启动器更新清单为空或过大。");
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumManifestBytes;
            Dictionary<string, object> root = serializer.DeserializeObject(json) as Dictionary<string, object>;
            if (root == null || ReadInt32(root, "schemaVersion") != 1)
            {
                throw new InvalidOperationException("启动器更新清单版本不受支持。");
            }

            string versionText = ReadString(root, "version");
            Version version;
            if (!Version.TryParse(versionText, out version))
            {
                throw new InvalidOperationException("启动器更新版本号无效。");
            }
            version = LauncherUpdatePolicy.NormalizeVersion(version);

            string sha256 = ReadString(root, "sha256").Trim().ToLowerInvariant();
            if (!Regex.IsMatch(sha256, "^[0-9a-f]{64}$", RegexOptions.CultureInvariant))
            {
                throw new InvalidOperationException("启动器更新 SHA-256 无效。");
            }

            long size = ReadInt64(root, "size");
            if (size < MinimumExecutableBytes || size > MaximumExecutableBytes)
            {
                throw new InvalidOperationException("启动器更新文件大小超出安全范围。");
            }

            object rawSources;
            if (!root.TryGetValue("sources", out rawSources))
            {
                throw new InvalidOperationException("启动器更新清单没有下载源。");
            }
            IEnumerable sourceValues = rawSources as IEnumerable;
            if (sourceValues == null || rawSources is string)
            {
                throw new InvalidOperationException("启动器更新下载源格式无效。");
            }

            List<LauncherUpdateSource> sources = new List<LauncherUpdateSource>();
            foreach (object rawSource in sourceValues)
            {
                Dictionary<string, object> source = rawSource as Dictionary<string, object>;
                if (source == null)
                {
                    throw new InvalidOperationException("启动器更新下载源格式无效。");
                }
                string provider = ReadString(source, "provider").Trim().ToLowerInvariant();
                if (!String.Equals(provider, "github", StringComparison.Ordinal) &&
                    !String.Equals(provider, "gitee", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("启动器更新下载源名称无效。");
                }
                Uri uri;
                if (!Uri.TryCreate(ReadString(source, "url"), UriKind.Absolute, out uri) ||
                    !LauncherUpdatePolicy.IsTrustedDownloadUri(uri))
                {
                    throw new InvalidOperationException("启动器更新下载地址不可信。");
                }
                sources.Add(new LauncherUpdateSource(provider, uri));
            }
            if (sources.Count == 0 || sources.Count > 4)
            {
                throw new InvalidOperationException("启动器更新下载源数量无效。");
            }

            LauncherUpdateManifest manifest = new LauncherUpdateManifest();
            manifest.Version = version;
            manifest.VersionText = version.ToString(3);
            manifest.Sha256 = sha256;
            manifest.Size = size;
            manifest.Sources = sources.AsReadOnly();
            return manifest;
        }

        private static string ReadString(Dictionary<string, object> value, string name)
        {
            object raw;
            if (!value.TryGetValue(name, out raw) || raw == null)
            {
                throw new InvalidOperationException("启动器更新清单缺少 " + name + "。");
            }
            string text = Convert.ToString(raw, CultureInfo.InvariantCulture);
            if (String.IsNullOrWhiteSpace(text))
            {
                throw new InvalidOperationException("启动器更新清单中的 " + name + " 为空。");
            }
            return text;
        }

        private static int ReadInt32(Dictionary<string, object> value, string name)
        {
            object raw;
            if (!value.TryGetValue(name, out raw) || raw == null)
            {
                throw new InvalidOperationException("启动器更新清单缺少 " + name + "。");
            }
            return Convert.ToInt32(raw, CultureInfo.InvariantCulture);
        }

        private static long ReadInt64(Dictionary<string, object> value, string name)
        {
            object raw;
            if (!value.TryGetValue(name, out raw) || raw == null)
            {
                throw new InvalidOperationException("启动器更新清单缺少 " + name + "。");
            }
            return Convert.ToInt64(raw, CultureInfo.InvariantCulture);
        }
    }

    internal static class LauncherUpdatePolicy
    {
        public static Version NormalizeVersion(Version value)
        {
            if (value == null || value.Major < 0 || value.Minor < 0)
            {
                throw new InvalidOperationException("启动器版本号无效。");
            }
            return new Version(
                value.Major,
                value.Minor,
                value.Build < 0 ? 0 : value.Build,
                value.Revision < 0 ? 0 : value.Revision);
        }

        public static bool IsNewer(Version candidate, Version current)
        {
            return NormalizeVersion(candidate).CompareTo(NormalizeVersion(current)) > 0;
        }

        public static bool IsTrustedDownloadUri(Uri uri)
        {
            if (uri == null || !uri.IsAbsoluteUri ||
                !String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                !uri.IsDefaultPort || !String.IsNullOrEmpty(uri.UserInfo))
            {
                return false;
            }

            string host = uri.DnsSafeHost.TrimEnd('.').ToLowerInvariant();
            return IsHostOrSubdomain(host, "github.com") ||
                IsHostOrSubdomain(host, "githubusercontent.com") ||
                IsHostOrSubdomain(host, "gitee.com");
        }

        private static bool IsHostOrSubdomain(string host, string suffix)
        {
            return String.Equals(host, suffix, StringComparison.Ordinal) ||
                host.EndsWith("." + suffix, StringComparison.Ordinal);
        }
    }
}
