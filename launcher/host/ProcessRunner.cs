using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class CommandResult
    {
        public int ExitCode { get; set; }
        public string StandardOutput { get; set; }
        public string StandardError { get; set; }

        public bool Success
        {
            get { return ExitCode == 0; }
        }
    }

    internal sealed class ProcessRunner
    {
        private readonly LogBuffer logs;

        public ProcessRunner(LogBuffer logs)
        {
            this.logs = logs;
        }

        public Task<CommandResult> RunAsync(
            string executable,
            string arguments,
            string workingDirectory,
            IDictionary<string, string> environment,
            string channel)
        {
            return RunAsync(executable, arguments, workingDirectory, environment, channel, null);
        }

        public Task<CommandResult> RunAsync(
            string executable,
            string arguments,
            string workingDirectory,
            IDictionary<string, string> environment,
            string channel,
            Func<string, bool> outputLine)
        {
            return Task.Run(delegate
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = executable;
                startInfo.Arguments = arguments == null ? String.Empty : arguments;
                startInfo.WorkingDirectory = String.IsNullOrWhiteSpace(workingDirectory)
                    ? Environment.CurrentDirectory
                    : workingDirectory;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.StandardOutputEncoding = Encoding.UTF8;
                startInfo.StandardErrorEncoding = Encoding.UTF8;

                if (environment != null)
                {
                    foreach (KeyValuePair<string, string> item in environment)
                    {
                        startInfo.EnvironmentVariables[item.Key] = item.Value ?? String.Empty;
                    }
                }

                StringBuilder stdout = new StringBuilder();
                StringBuilder stderr = new StringBuilder();
                using (Process process = new Process())
                {
                    process.StartInfo = startInfo;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
                    {
                        if (args.Data == null)
                        {
                            return;
                        }
                        lock (stdout)
                        {
                            stdout.AppendLine(args.Data);
                        }
                        bool handled = false;
                        if (outputLine != null)
                        {
                            try
                            {
                                handled = outputLine(args.Data);
                            }
                            catch
                            {
                            }
                        }
                        if (!handled)
                        {
                            logs.Add(channel, args.Data, "info");
                        }
                    };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
                    {
                        if (args.Data == null)
                        {
                            return;
                        }
                        lock (stderr)
                        {
                            stderr.AppendLine(args.Data);
                        }
                        logs.Add(channel, args.Data, "error");
                    };

                    logs.Add(channel, "> " + executable + " " + arguments, "command");
                    if (!process.Start())
                    {
                        throw new InvalidOperationException("无法启动进程：" + executable);
                    }
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();

                    return new CommandResult
                    {
                        ExitCode = process.ExitCode,
                        StandardOutput = stdout.ToString().Trim(),
                        StandardError = stderr.ToString().Trim()
                    };
                }
            });
        }

        public static string Quote(string value)
        {
            if (value == null)
            {
                return "\"\"";
            }
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
