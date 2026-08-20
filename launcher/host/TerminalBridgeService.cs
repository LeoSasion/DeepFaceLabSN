using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class TerminalBridgeService : IDisposable
    {
        private readonly object gate = new object();
        private readonly LogBuffer logs;
        private Process process;
        private string terminalUrl;

        public TerminalBridgeService(LogBuffer logs)
        {
            this.logs = logs;
        }

        public string CurrentUrl
        {
            get
            {
                lock (gate)
                {
                    if (process == null || process.HasExited)
                    {
                        return null;
                    }
                    return terminalUrl;
                }
            }
        }

        public bool IsRunning
        {
            get
            {
                lock (gate)
                {
                    return process != null && !process.HasExited;
                }
            }
        }

        public Task<string> StartAsync(string projectRoot)
        {
            return Task.Run(delegate
            {

                string node = Path.Combine(projectRoot, "_internal", "node", "bin", "node.exe");
                string entry = LauncherPayload.GetPath(Path.Combine("terminal", "index.mjs"));
                if (!File.Exists(node))
                {
                    throw new FileNotFoundException("终端桥接需要项目内的便携 Node.js。", node);
                }
                if (!File.Exists(entry))
                {
                    throw new FileNotFoundException("启动器内嵌的终端桥接入口缺失或校验失败。", entry);
                }

                string token = CreateToken();
                IDictionary<string, string> environment = DflEnvironment.Load(projectRoot, logs);
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = node;
                startInfo.Arguments = ProcessRunner.Quote(entry)
                    + " --project-root " + ProcessRunner.Quote(projectRoot)
                    + " --port 0 --token " + ProcessRunner.Quote(token);
                startInfo.WorkingDirectory = projectRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.StandardOutputEncoding = Encoding.UTF8;
                startInfo.StandardErrorEncoding = Encoding.UTF8;
                foreach (KeyValuePair<string, string> item in environment)
                {
                    startInfo.EnvironmentVariables[item.Key] = item.Value ?? String.Empty;
                }

                Process started = new Process();
                started.StartInfo = startInfo;
                started.EnableRaisingEvents = true;
                if (!started.Start())
                {
                    throw new InvalidOperationException("无法启动终端桥接进程。");
                }
                int startedPid = started.Id;

                object errorGate = new object();
                StringBuilder errorBuffer = new StringBuilder();
                Task errorPump = Task.Factory.StartNew(delegate
                {
                    try
                    {
                        string line;
                        while ((line = started.StandardError.ReadLine()) != null)
                        {
                            lock (errorGate)
                            {
                                if (errorBuffer.Length < 4096)
                                {
                                    errorBuffer.AppendLine(line);
                                }
                            }
                            logs.Add("terminal", line, "error");
                        }
                    }
                    catch (ObjectDisposedException)
                    {
                    }
                    catch (InvalidOperationException)
                    {
                    }
                });

                Task<string> firstLineTask = Task.Factory.StartNew(delegate { return started.StandardOutput.ReadLine(); });
                if (!firstLineTask.Wait(TimeSpan.FromSeconds(15)))
                {
                    TryTerminate(started);
                    throw new TimeoutException("终端桥接启动超时。");
                }

                string firstLine = firstLineTask.Result;
                if (String.IsNullOrWhiteSpace(firstLine) || !firstLine.StartsWith("READY ", StringComparison.Ordinal))
                {
                    TryTerminate(started);
                    try
                    {
                        errorPump.Wait(TimeSpan.FromSeconds(1));
                    }
                    catch
                    {
                    }
                    string error;
                    lock (errorGate)
                    {
                        error = errorBuffer.ToString().Trim();
                    }
                    string detail = !String.IsNullOrWhiteSpace(firstLine) ? firstLine : error;
                    throw new InvalidOperationException("终端桥接握手失败：" + (String.IsNullOrWhiteSpace(detail) ? "未收到 READY 响应。" : detail));
                }

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> ready = serializer.Deserialize<Dictionary<string, object>>(firstLine.Substring(6));
                int port = Convert.ToInt32(ready["port"]);
                string endpointPath = ready.ContainsKey("path") ? Convert.ToString(ready["path"]) : "/terminal";
                string url = "ws://127.0.0.1:" + port + endpointPath + "?token=" + Uri.EscapeDataString(token);

                Process previous;
                lock (gate)
                {
                    previous = process;
                    process = started;
                    terminalUrl = url;
                }
                if (previous != null)
                {
                    TryTerminate(previous);
                }

                started.Exited += delegate
                {
                    logs.Add("terminal", "终端桥接已退出（PID " + startedPid + "）。", "info");
                    lock (gate)
                    {
                        if (Object.ReferenceEquals(process, started))
                        {
                            process = null;
                            terminalUrl = null;
                        }
                    }
                };

                Task.Factory.StartNew(delegate
                {
                    string line;
                    while ((line = started.StandardOutput.ReadLine()) != null)
                    {
                        logs.Add("terminal", line, "info");
                    }
                });

                logs.Add("terminal", "终端桥接已就绪。", "info");
                return url;
            });
        }

        public void Stop()
        {
            Process target = null;
            lock (gate)
            {
                target = process;
                process = null;
                terminalUrl = null;
            }
            if (target != null && !target.HasExited)
            {
                TryTerminate(target);
            }
        }

        public void Dispose()
        {
            Stop();
        }

        private static string CreateToken()
        {
            byte[] bytes = new byte[24];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static void TryTerminate(Process target)
        {
            try
            {
                if (!target.HasExited)
                {
                    target.Kill();
                    target.WaitForExit(3000);
                }
            }
            catch
            {
            }
            try
            {
                target.Dispose();
            }
            catch
            {
            }
        }
    }
}
