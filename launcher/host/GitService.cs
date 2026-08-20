using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class GitStatus
    {
        public bool Available { get; set; }
        public bool Repository { get; set; }
        public bool RemoteValid { get; set; }
        public bool BranchValid { get; set; }
        public bool Dirty { get; set; }
        public bool UpdateAvailable { get; set; }
        public string GitPath { get; set; }
        public string Branch { get; set; }
        public string Head { get; set; }
        public string RemoteHead { get; set; }
        public int Behind { get; set; }
        public string Error { get; set; }
    }

    internal sealed class GitService
    {
        private static readonly string[] ProtectedUpdatePaths =
        {
            "workspace",
            "workspaces",
            "_internal/config.txt",
            "_internal/CUDA",
            "_internal/CUDNN",
            "_internal/node",
            "_internal/python_common",
            "_internal/git",
            "webui/.runtime"
        };

        private readonly SettingsStore settings;
        private readonly ProcessRunner runner;
        private readonly LogBuffer logs;

        public GitService(SettingsStore settings, ProcessRunner runner, LogBuffer logs)
        {
            this.settings = settings;
            this.runner = runner;
            this.logs = logs;
        }

        public string LocateGit()
        {
            LauncherSettings snapshot = settings.Current;
            List<string> candidates = new List<string>();
            try
            {
                candidates.Add(Path.Combine(ProjectLocator.Resolve(snapshot), "_internal", "git", "cmd", "git.exe"));
            }
            catch
            {
            }
            candidates.Add(Path.Combine(LauncherConstants.SettingsDirectory, "bootstrap-tools", "git", "cmd", "git.exe"));
            if (!String.IsNullOrWhiteSpace(snapshot.GitPath))
            {
                candidates.Add(snapshot.GitPath);
            }

            string path = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            string[] pathParts = path.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
            for (int index = 0; index < pathParts.Length; index++)
            {
                candidates.Add(Path.Combine(pathParts[index].Trim(' ', '"'), "git.exe"));
            }

            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd", "git.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "bin", "git.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Git", "cmd", "git.exe"));

            HashSet<string> visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < candidates.Count; index++)
            {
                try
                {
                    string candidate = Path.GetFullPath(Environment.ExpandEnvironmentVariables(candidates[index]));
                    if (visited.Add(candidate) && File.Exists(candidate))
                    {
                        if (!String.Equals(snapshot.GitPath, candidate, StringComparison.OrdinalIgnoreCase))
                        {
                            settings.Update(delegate(LauncherSettings value) { value.GitPath = candidate; });
                        }
                        return candidate;
                    }
                }
                catch
                {
                }
            }
            return null;
        }

        public async Task CloneAsync(string destination, int attempt)
        {
            ProjectLocator.AssertSafeInstallPath(destination);
            string fullPath = Path.GetFullPath(destination);
            if (Directory.Exists(fullPath) && !ProjectLocator.IsEmptyDirectory(fullPath))
            {
                throw new InvalidOperationException("安装目录不是空目录；为保护已有文件，已停止克隆。");
            }

            string git = RequireGit();
            string parent = Directory.GetParent(fullPath).FullName;
            Directory.CreateDirectory(parent);
            string stagingPath = fullPath + ".cloning-" + Guid.NewGuid().ToString("N");
            GitTransportPlan plan = GitNetworkOptions.CreatePlan(settings.Current, attempt);
            IDictionary<string, string> networkEnvironment = GitNetworkOptions.CreateEnvironment(plan);
            logs.Add("git", "正在获取 main 分支（" + plan.Label + "，浅克隆）…", plan.UsesMirror ? "warning" : "info");
            try
            {
                CommandResult result = await runner.RunAsync(
                    git,
                    "-c credential.interactive=never -c http.lowSpeedLimit=512 -c http.lowSpeedTime=45"
                        + (plan.DirectConnection ? " -c http.proxy=" : String.Empty)
                        + (plan.ForceHttp11 ? " -c http.version=HTTP/1.1" : String.Empty)
                        + " clone --depth 1 --no-tags --origin origin --branch " + LauncherConstants.GitBranch
                        + " --single-branch " + ProcessRunner.Quote(plan.SourceUrl)
                        + " " + ProcessRunner.Quote(stagingPath),
                    parent,
                    networkEnvironment,
                    "git");
                EnsureSuccess(result, "项目克隆失败");
                if (plan.UsesMirror)
                {
                    CommandResult canonicalRemote = await runner.RunAsync(
                        git,
                        "-C " + ProcessRunner.Quote(stagingPath) + " remote set-url origin " + ProcessRunner.Quote(LauncherConstants.GitRemote),
                        stagingPath,
                        null,
                        "git");
                    EnsureSuccess(canonicalRemote, "无法把克隆后的 origin 恢复为官方 GitHub 地址");
                }
                await AssertRepositoryIdentityAsync(stagingPath);

                if (Directory.Exists(fullPath))
                {
                    if (!ProjectLocator.IsEmptyDirectory(fullPath))
                    {
                        throw new InvalidOperationException("项目获取完成，但安装目录出现了新文件；为保护这些文件，已停止发布项目。");
                    }
                    Directory.Delete(fullPath, false);
                }
                Directory.Move(stagingPath, fullPath);
                settings.Update(delegate(LauncherSettings value) { value.ProjectRoot = fullPath; });
            }
            finally
            {
                try
                {
                    string normalizedStaging = Path.GetFullPath(stagingPath);
                    string requiredPrefix = fullPath + ".cloning-";
                    if (normalizedStaging.StartsWith(requiredPrefix, StringComparison.OrdinalIgnoreCase)
                        && String.Equals(Directory.GetParent(normalizedStaging).FullName, parent, StringComparison.OrdinalIgnoreCase)
                        && Directory.Exists(normalizedStaging)
                        && (File.GetAttributes(normalizedStaging) & FileAttributes.ReparsePoint) == 0)
                    {
                        Directory.Delete(normalizedStaging, true);
                    }
                }
                catch
                {
                    logs.Add("git", "未能清理失败的私有克隆暂存目录：" + stagingPath, "warning");
                }
            }
        }

        public async Task<GitStatus> InspectAsync(string projectRoot, bool fetch)
        {
            GitStatus status = new GitStatus();
            string git = LocateGit();
            status.GitPath = git;
            status.Available = !String.IsNullOrWhiteSpace(git);
            status.Repository = ProjectLocator.IsProject(projectRoot);
            if (!status.Available || !status.Repository)
            {
                return status;
            }

            try
            {
                string remote = await ReadGitAsync(git, projectRoot, "remote get-url origin");
                status.RemoteValid = IsExpectedRemote(remote);
                status.Branch = await ReadGitAsync(git, projectRoot, "branch --show-current");
                status.BranchValid = String.Equals(status.Branch, LauncherConstants.GitBranch, StringComparison.Ordinal);
                if (!status.RemoteValid)
                {
                    status.Error = "origin 不是启动器允许的固定 GitHub 项目源。";
                    return status;
                }
                if (!status.BranchValid)
                {
                    status.Error = "当前分支不是 " + LauncherConstants.GitBranch + "；启动器不会自动切换分支。";
                    return status;
                }

                if (fetch)
                {
                    await FetchAsync(git, projectRoot);
                }

                status.Head = await ReadGitAsync(git, projectRoot, "rev-parse HEAD");
                CommandResult remoteHeadResult = await runner.RunAsync(
                    git,
                    "-C " + ProcessRunner.Quote(projectRoot) + " rev-parse refs/remotes/origin/" + LauncherConstants.GitBranch,
                    projectRoot,
                    null,
                    "git");
                if (remoteHeadResult.Success)
                {
                    status.RemoteHead = remoteHeadResult.StandardOutput.Trim();
                    string count = await ReadGitAsync(
                        git,
                        projectRoot,
                        "rev-list --count HEAD..refs/remotes/origin/" + LauncherConstants.GitBranch);
                    int behind;
                    if (Int32.TryParse(count, out behind))
                    {
                        status.Behind = behind;
                        status.UpdateAvailable = behind > 0;
                    }
                }

                string dirty = await ReadGitAsync(git, projectRoot, "status --porcelain --untracked-files=no");
                status.Dirty = HasUnsafeDirtyChanges(dirty);
            }
            catch (Exception error)
            {
                status.Error = error.Message;
            }
            return status;
        }

        public async Task<GitStatus> CheckUpdatesAsync(string projectRoot)
        {
            await AssertRepositoryIdentityAsync(projectRoot);
            GitStatus status = await InspectAsync(projectRoot, true);
            if (!String.IsNullOrWhiteSpace(status.Error))
            {
                throw new InvalidOperationException(status.Error);
            }
            settings.Update(delegate(LauncherSettings value) { value.LastCheck = DateTime.UtcNow.ToString("o"); });
            return status;
        }

        public async Task<GitStatus> ApplyUpdateAsync(string projectRoot)
        {
            await AssertRepositoryIdentityAsync(projectRoot);
            string git = RequireGit();
            GitStatus before = await InspectAsync(projectRoot, false);
            if (!before.RemoteValid || !before.BranchValid)
            {
                throw new InvalidOperationException(before.Error ?? "Git 项目身份校验失败。");
            }

            string dirty = await ReadGitAsync(git, projectRoot, "status --porcelain --untracked-files=no");
            if (HasUnsafeDirtyChanges(dirty))
            {
                throw new InvalidOperationException("检测到本地源码改动。为避免覆盖，更新已暂停；启动器不会自动 stash、reset 或 clean。");
            }

            await FetchAsync(git, projectRoot);
            await AssertRemoteTreeSafeAsync(git, projectRoot);
            bool configTracked = await IsConfigTrackedAtHeadAsync(git, projectRoot);
            ProtectedFileBackup configBackup = null;
            if (configTracked)
            {
                configBackup = BackupProtectedConfig(projectRoot);
            }

            try
            {
                if (configTracked)
                {
                    logs.Add("git", "正在保护本地配置并准备安全迁移…", "info");
                    await WriteHeadConfigToWorktreeAsync(git, projectRoot);
                }

                logs.Add("git", "正在执行 fast-forward-only 合并…", "info");
                CommandResult merge = await runner.RunAsync(
                    git,
                    "-C " + ProcessRunner.Quote(projectRoot) + " merge --ff-only refs/remotes/origin/" + LauncherConstants.GitBranch,
                    projectRoot,
                    null,
                    "git");
                EnsureSuccess(merge, "无法以 fast-forward 方式更新项目");
                settings.Update(delegate(LauncherSettings value) { value.LastCheck = DateTime.UtcNow.ToString("o"); });
            }
            finally
            {
                if (configBackup != null)
                {
                    RestoreProtectedConfig(configBackup);
                }
            }

            return await InspectAsync(projectRoot, false);
        }

        private async Task AssertRepositoryIdentityAsync(string projectRoot)
        {
            if (!ProjectLocator.IsProject(projectRoot))
            {
                throw new InvalidOperationException("所选目录不是完整的 DeepFaceLabSN Git 项目。");
            }
            string git = RequireGit();
            string remote = await ReadGitAsync(git, projectRoot, "remote get-url origin");
            if (!IsExpectedRemote(remote))
            {
                throw new InvalidOperationException("origin 与启动器内置的固定 GitHub 地址不一致，已拒绝操作。");
            }
            string branch = await ReadGitAsync(git, projectRoot, "branch --show-current");
            if (!String.Equals(branch, LauncherConstants.GitBranch, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("当前分支不是 " + LauncherConstants.GitBranch + "；启动器不会自动切换分支。");
            }
        }

        private async Task FetchAsync(string git, string projectRoot)
        {
            CommandResult lastResult = null;
            for (int attempt = 1; attempt <= 4; attempt++)
            {
                GitTransportPlan plan = GitNetworkOptions.CreatePlan(settings.Current, attempt);
                IDictionary<string, string> environment = GitNetworkOptions.CreateEnvironment(plan);
                string source = plan.UsesMirror ? ProcessRunner.Quote(plan.SourceUrl) : "origin";
                logs.Add("git", "正在检查项目更新（" + plan.Label + "，第 " + attempt + "/4 次）…", plan.UsesMirror ? "warning" : "info");
                lastResult = await runner.RunAsync(
                    git,
                    "-C " + ProcessRunner.Quote(projectRoot)
                        + " -c credential.interactive=never -c http.lowSpeedLimit=512 -c http.lowSpeedTime=45"
                        + (plan.DirectConnection ? " -c http.proxy=" : String.Empty)
                        + (plan.ForceHttp11 ? " -c http.version=HTTP/1.1" : String.Empty)
                        + " fetch --no-tags " + source + " refs/heads/"
                        + LauncherConstants.GitBranch + ":refs/remotes/origin/" + LauncherConstants.GitBranch,
                    projectRoot,
                    environment,
                    "git");
                if (lastResult.Success) return;
                if (attempt < 4) await Task.Delay(TimeSpan.FromSeconds(attempt * 5));
            }
            EnsureSuccess(lastResult, "Git fetch 失败");
        }

        private async Task AssertRemoteTreeSafeAsync(string git, string projectRoot)
        {
            string protectedPath = null;
            CommandResult tree = await runner.RunAsync(
                git,
                "-C " + ProcessRunner.Quote(projectRoot)
                    + " -c core.quotepath=false ls-tree -r --full-tree --name-only refs/remotes/origin/"
                    + LauncherConstants.GitBranch,
                projectRoot,
                null,
                "git",
                delegate(string path)
                {
                    if (protectedPath == null && IsProtectedUpdatePath(path))
                    {
                        protectedPath = path.Trim();
                    }
                    return true;
                });
            EnsureSuccess(tree, "无法读取远端项目树");
            if (!String.IsNullOrWhiteSpace(protectedPath))
            {
                throw new InvalidOperationException("远端包含受保护路径，更新暂停：" + protectedPath);
            }
        }

        internal static bool IsProtectedUpdatePath(string path)
        {
            if (String.IsNullOrWhiteSpace(path))
            {
                return false;
            }
            string normalized = path.Trim().Replace('\\', '/').Trim('/');
            if (normalized.Length >= 2 && normalized[0] == '"' && normalized[normalized.Length - 1] == '"')
            {
                normalized = normalized.Substring(1, normalized.Length - 2).Trim('/');
            }
            while (normalized.IndexOf("//", StringComparison.Ordinal) >= 0)
            {
                normalized = normalized.Replace("//", "/");
            }
            for (int index = 0; index < ProtectedUpdatePaths.Length; index++)
            {
                string protectedPath = ProtectedUpdatePaths[index];
                if (String.Equals(normalized, protectedPath, StringComparison.OrdinalIgnoreCase)
                    || normalized.StartsWith(protectedPath + "/", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private async Task<bool> IsConfigTrackedAtHeadAsync(string git, string projectRoot)
        {
            CommandResult result = await runner.RunAsync(
                git,
                "-C " + ProcessRunner.Quote(projectRoot) + " cat-file -e HEAD:_internal/config.txt",
                projectRoot,
                null,
                "git");
            return result.Success;
        }

        private Task WriteHeadConfigToWorktreeAsync(string git, string projectRoot)
        {
            return Task.Run(delegate
            {
                string targetPath = Path.Combine(projectRoot, "_internal", "config.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(targetPath));
                string stagingPath = targetPath + ".launcher-head-" + Guid.NewGuid().ToString("N");
                try
                {
                    ProcessStartInfo startInfo = new ProcessStartInfo();
                    startInfo.FileName = git;
                    startInfo.Arguments = "-C " + ProcessRunner.Quote(projectRoot) + " show HEAD:_internal/config.txt";
                    startInfo.WorkingDirectory = projectRoot;
                    startInfo.UseShellExecute = false;
                    startInfo.CreateNoWindow = true;
                    startInfo.RedirectStandardOutput = true;
                    startInfo.RedirectStandardError = true;

                    string error;
                    int exitCode;
                    using (Process process = new Process())
                    using (FileStream output = new FileStream(stagingPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        process.StartInfo = startInfo;
                        if (!process.Start())
                        {
                            throw new InvalidOperationException("无法读取 Git 中的配置基线。");
                        }
                        Task<string> errorTask = Task.Factory.StartNew(delegate { return process.StandardError.ReadToEnd(); });
                        process.StandardOutput.BaseStream.CopyTo(output);
                        output.Flush(true);
                        process.WaitForExit();
                        error = errorTask.Result;
                        exitCode = process.ExitCode;
                    }
                    if (exitCode != 0)
                    {
                        throw new InvalidOperationException("无法读取 Git 中的配置基线" + (String.IsNullOrWhiteSpace(error) ? "。" : "：" + error.Trim()));
                    }
                    ReplaceFileAtomically(stagingPath, targetPath);
                }
                finally
                {
                    TryDeleteFile(stagingPath);
                }
            });
        }

        private static ProtectedFileBackup BackupProtectedConfig(string projectRoot)
        {
            string targetPath = Path.Combine(projectRoot, "_internal", "config.txt");
            string backupDirectory = Path.Combine(
                LauncherConstants.SettingsDirectory,
                "update-backups",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(backupDirectory);
            string backupPath = Path.Combine(backupDirectory, "config.txt");
            bool existed = File.Exists(targetPath);
            if (existed)
            {
                File.Copy(targetPath, backupPath, false);
            }
            return new ProtectedFileBackup(targetPath, backupDirectory, backupPath, existed);
        }

        private static void RestoreProtectedConfig(ProtectedFileBackup backup)
        {
            bool restored = false;
            try
            {
                if (backup.Existed)
                {
                    string stagingPath = backup.TargetPath + ".launcher-restore-" + Guid.NewGuid().ToString("N");
                    try
                    {
                        File.Copy(backup.BackupPath, stagingPath, false);
                        ReplaceFileAtomically(stagingPath, backup.TargetPath);
                    }
                    finally
                    {
                        TryDeleteFile(stagingPath);
                    }
                }
                else
                {
                    TryDeleteFile(backup.TargetPath);
                }
                restored = true;
            }
            finally
            {
                if (restored)
                {
                    TryDeleteDirectory(backup.BackupDirectory);
                }
            }
        }

        private static void ReplaceFileAtomically(string stagingPath, string targetPath)
        {
            if (File.Exists(targetPath))
            {
                File.Replace(stagingPath, targetPath, null, true);
            }
            else
            {
                File.Move(stagingPath, targetPath);
            }
        }

        private static bool HasUnsafeDirtyChanges(string porcelain)
        {
            if (String.IsNullOrWhiteSpace(porcelain))
            {
                return false;
            }
            using (StringReader reader = new StringReader(porcelain))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (String.IsNullOrWhiteSpace(line))
                    {
                        continue;
                    }
                    string path = line.Length > 3 ? line.Substring(3).Trim() : String.Empty;
                    if (!String.Equals(path.Replace('\\', '/'), "_internal/config.txt", StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            return false;
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

        private static void TryDeleteDirectory(string path)
        {
            try
            {
                if (Directory.Exists(path))
                {
                    Directory.Delete(path, true);
                }
            }
            catch
            {
            }
        }

        private sealed class ProtectedFileBackup
        {
            public string TargetPath { get; private set; }
            public string BackupDirectory { get; private set; }
            public string BackupPath { get; private set; }
            public bool Existed { get; private set; }

            public ProtectedFileBackup(string targetPath, string backupDirectory, string backupPath, bool existed)
            {
                TargetPath = targetPath;
                BackupDirectory = backupDirectory;
                BackupPath = backupPath;
                Existed = existed;
            }
        }

        private async Task<string> ReadGitAsync(string git, string projectRoot, string arguments)
        {
            CommandResult result = await runner.RunAsync(
                git,
                "-C " + ProcessRunner.Quote(projectRoot) + " " + arguments,
                projectRoot,
                null,
                "git");
            EnsureSuccess(result, "Git 命令失败");
            return result.StandardOutput.Trim();
        }

        private string RequireGit()
        {
            string git = LocateGit();
            if (String.IsNullOrWhiteSpace(git))
            {
                throw new FileNotFoundException("未找到 git.exe。请先安装 Git for Windows，或把便携 Git 放入 PATH。");
            }
            return git;
        }

        private static bool IsExpectedRemote(string value)
        {
            if (String.IsNullOrWhiteSpace(value))
            {
                return false;
            }
            string normalized = value.Trim().TrimEnd('/');
            if (normalized.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized.Substring(0, normalized.Length - 4);
            }
            string expected = LauncherConstants.GitRemote.TrimEnd('/');
            if (expected.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
            {
                expected = expected.Substring(0, expected.Length - 4);
            }
            return String.Equals(normalized, expected, StringComparison.OrdinalIgnoreCase);
        }

        private static void EnsureSuccess(CommandResult result, string prefix)
        {
            if (result.Success)
            {
                return;
            }
            string detail = !String.IsNullOrWhiteSpace(result.StandardError)
                ? result.StandardError
                : result.StandardOutput;
            throw new InvalidOperationException(prefix + "（退出码 " + result.ExitCode + "）" + (String.IsNullOrWhiteSpace(detail) ? String.Empty : "：" + detail));
        }
    }
}
