using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class WebUiDependencyHealth
    {
        public bool Ready { get; set; }
        public string Detail { get; set; }
    }

    internal static class WebUiDependencies
    {
        // esbuild belongs to Vite, so resolve it from Vite's dependency scope.
        // pnpm does not expose transitive dependencies at the project root.
        public const string ProbeScript =
            "let failed=false;"
            + "for(const name of ['node-pty','vite/esbuild']){try{"
            + "if(name==='node-pty'){require('node-pty')}else{"
            + "const r=require('node:module').createRequire(require.resolve('vite/package.json'));"
            + "r('esbuild').transformSync('let ready=true')}"
            + "console.log(name+': OK')"
            + "}catch(error){failed=true;console.error(name+': '+(error.stack||error))}}"
            + "if(failed)process.exitCode=1;";

        public static bool EntryPointsPresent(string projectRoot)
        {
            string modules = Path.Combine(projectRoot, "webui", "node_modules");
            return File.Exists(Path.Combine(modules, "vite", "bin", "vite.js"))
                && File.Exists(Path.Combine(modules, "node-pty", "package.json"));
        }

        // A file existing does not prove its native module can load. Keep this
        // read-only probe bounded so a broken installation cannot hang startup.
        public static WebUiDependencyHealth Inspect(string projectRoot,
            IDictionary<string, string> environment, int timeoutMilliseconds = 10000)
        {
            string node = Path.Combine(projectRoot, "_internal", "node", "bin", "node.exe");
            if (!File.Exists(node)) return Failed("缺少项目内的 Node.js，请修复依赖。");
            if (!EntryPointsPresent(projectRoot)) return Failed("WebUI 依赖入口缺失，请修复依赖。");
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(node, "-e \"" + ProbeScript + "\"");
                start.WorkingDirectory = Path.Combine(projectRoot, "webui");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;
                if (environment != null)
                    foreach (KeyValuePair<string, string> item in environment)
                        start.EnvironmentVariables[item.Key] = item.Value ?? String.Empty;
                using (Process process = Process.Start(start))
                {
                    Task<string> output = process.StandardOutput.ReadToEndAsync();
                    Task<string> error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(Math.Max(1, timeoutMilliseconds)))
                    {
                        try { process.Kill(); } catch { }
                        process.WaitForExit(2000);
                        return Failed("WebUI 依赖加载检查超时，请查看日志并修复依赖。");
                    }
                    if (!Task.WaitAll(new Task[] { output, error }, 2000))
                        return Failed("WebUI 依赖检查输出未结束，请修复依赖。");
                    if (process.ExitCode != 0)
                        return Failed((error.Result + Environment.NewLine + output.Result).Trim());
                    return new WebUiDependencyHealth { Ready = true, Detail = "node-pty 与 Vite/esbuild 加载通过。" };
                }
            }
            catch (Exception error) { return Failed("WebUI 依赖检查失败：" + error.Message); }
        }

        private static WebUiDependencyHealth Failed(string detail)
        {
            return new WebUiDependencyHealth { Ready = false,
                Detail = detail.Length > 8000 ? detail.Substring(0, 8000) : detail };
        }
    }
}
