using System;
using System.Collections.Generic;
using System.Net;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class GitTransportPlan
    {
        public string SourceUrl { get; set; }
        public string ProxyUrl { get; set; }
        public bool DirectConnection { get; set; }
        public bool ForceHttp11 { get; set; }
        public bool UsesMirror { get; set; }
        public string Label { get; set; }
    }

    internal static class GitNetworkOptions
    {
        private static readonly string[] ProxyEnvironmentNames =
        {
            "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"
        };

        public static string NormalizeProxyMode(string value)
        {
            if (String.Equals(value, "direct", StringComparison.OrdinalIgnoreCase)) return "direct";
            if (String.Equals(value, "manual", StringComparison.OrdinalIgnoreCase)) return "manual";
            return "auto";
        }

        public static string NormalizeProxy(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return null;
            string normalized = value.Trim();
            Uri uri;
            if (!Uri.TryCreate(normalized, UriKind.Absolute, out uri)
                || String.IsNullOrWhiteSpace(uri.Host)
                || !String.IsNullOrWhiteSpace(uri.UserInfo)
                || (uri.Scheme != Uri.UriSchemeHttp
                    && uri.Scheme != Uri.UriSchemeHttps
                    && !String.Equals(uri.Scheme, "socks4", StringComparison.OrdinalIgnoreCase)
                    && !String.Equals(uri.Scheme, "socks5", StringComparison.OrdinalIgnoreCase)
                    && !String.Equals(uri.Scheme, "socks5h", StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException("Git 代理地址无效；请使用不含账号密码的 HTTP、HTTPS 或 SOCKS 地址。");
            }
            return normalized;
        }

        public static string NormalizeMirror(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return null;
            string normalized = value.Trim().TrimEnd('/');
            Uri uri;
            if (!Uri.TryCreate(normalized, UriKind.Absolute, out uri)
                || uri.Scheme != Uri.UriSchemeHttps
                || String.IsNullOrWhiteSpace(uri.Host)
                || !String.IsNullOrWhiteSpace(uri.UserInfo)
                || !uri.IsDefaultPort)
            {
                throw new InvalidOperationException("Git 后备镜像必须是不含账号密码、使用默认端口的 HTTPS 仓库地址。");
            }
            return normalized;
        }

        public static GitTransportPlan CreatePlan(LauncherSettings settings, int attempt)
        {
            LauncherSettings value = settings ?? new LauncherSettings();
            string configuredMirror = NormalizeMirror(value.GitMirror);
            string mirror = String.IsNullOrWhiteSpace(configuredMirror)
                ? LauncherConstants.GitFallbackMirror
                : configuredMirror;
            int cycle = Math.Max(0, attempt - 1) % 4;
            bool useMirror = cycle == 1 || cycle == 3;
            bool http11 = cycle >= 2;
            bool direct = String.Equals(
                NormalizeProxyMode(value.GitProxyMode),
                "direct",
                StringComparison.Ordinal);
            string proxy = ResolveProxy(value);
            string label = useMirror
                ? (String.IsNullOrWhiteSpace(configuredMirror) ? "Gitee 国内后备" : "自定义可信后备镜像")
                : (http11 ? "GitHub · HTTP/1.1" : "GitHub · 默认 HTTPS");
            if (useMirror && http11) label += " · HTTP/1.1";
            if (!String.IsNullOrWhiteSpace(proxy)) label += " · 代理";
            return new GitTransportPlan
            {
                SourceUrl = useMirror ? mirror : LauncherConstants.GitRemote,
                ProxyUrl = proxy,
                DirectConnection = direct,
                ForceHttp11 = http11,
                UsesMirror = useMirror,
                Label = label
            };
        }

        public static IDictionary<string, string> CreateEnvironment(GitTransportPlan plan)
        {
            Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            // ProcessStartInfo inherits the launcher's environment. Explicitly
            // blank every conventional proxy variable so "direct" really is
            // direct instead of silently retaining a parent-process proxy.
            for (int index = 0; index < ProxyEnvironmentNames.Length; index++)
            {
                environment[ProxyEnvironmentNames[index]] = String.Empty;
            }
            if (plan != null && !String.IsNullOrWhiteSpace(plan.ProxyUrl))
            {
                environment["HTTPS_PROXY"] = plan.ProxyUrl;
                environment["HTTP_PROXY"] = plan.ProxyUrl;
                environment["ALL_PROXY"] = plan.ProxyUrl;
            }
            return environment;
        }

        public static string Describe(LauncherSettings settings)
        {
            LauncherSettings value = settings ?? new LauncherSettings();
            string mode = NormalizeProxyMode(value.GitProxyMode);
            string proxy = ResolveProxy(value);
            string description = mode == "direct"
                ? "直连"
                : (String.IsNullOrWhiteSpace(proxy) ? "自动检测（未发现代理）" : "自动/手动代理：" + DescribeUrl(proxy));
            description += String.IsNullOrWhiteSpace(value.GitMirror)
                ? " · Gitee 后备已启用"
                : " · 自定义后备镜像";
            return description;
        }

        private static string ResolveProxy(LauncherSettings settings)
        {
            string mode = NormalizeProxyMode(settings.GitProxyMode);
            if (mode == "direct") return null;
            if (mode == "manual") return NormalizeProxy(settings.GitProxy);

            for (int index = 0; index < ProxyEnvironmentNames.Length; index++)
            {
                string candidate = Environment.GetEnvironmentVariable(ProxyEnvironmentNames[index]);
                try
                {
                    candidate = NormalizeProxy(candidate);
                    if (!String.IsNullOrWhiteSpace(candidate)) return candidate;
                }
                catch
                {
                }
            }

            try
            {
                Uri github = new Uri(LauncherConstants.GitRemote);
                IWebProxy systemProxy = WebRequest.DefaultWebProxy;
                if (systemProxy != null && !systemProxy.IsBypassed(github))
                {
                    Uri proxy = systemProxy.GetProxy(github);
                    if (proxy != null && proxy != github) return NormalizeProxy(proxy.AbsoluteUri);
                }
            }
            catch
            {
            }
            return null;
        }

        private static string DescribeUrl(string value)
        {
            try
            {
                Uri uri = new Uri(value);
                return uri.Scheme + "://" + uri.Host + (uri.IsDefaultPort ? String.Empty : ":" + uri.Port);
            }
            catch
            {
                return "已配置";
            }
        }
    }
}
