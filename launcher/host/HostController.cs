using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Forms = System.Windows.Forms;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class HostController : IDisposable
    {
        private readonly SettingsStore settings;
        private readonly LogBuffer logs;
        private readonly ProcessRunner runner;
        private readonly GitService git;
        private readonly TerminalBridgeService terminal;
        private readonly SemaphoreSlim operationGate = new SemaphoreSlim(1, 1);
        private volatile bool webUiActivatedInSession;

        public event Action<object> ProgressChanged;

        public HostController(SettingsStore settings, LogBuffer logs)
        {
            this.settings = settings;
            this.logs = logs;
            runner = new ProcessRunner(logs);
            git = new GitService(settings, runner, logs);
            terminal = new TerminalBridgeService(logs);
        }

        public LogBuffer Logs
        {
            get { return logs; }
        }

        public async Task<object> GetStateAsync()
        {
            LauncherSettings snapshot = settings.Current;
            string projectRoot = ProjectLocator.Resolve(snapshot);
            bool projectReady = ProjectLocator.IsProject(projectRoot);
            if (projectReady)
            {
                try
                {
                    IList<string> createdWorkspaceDirectories = WorkspaceTemplate.Ensure(projectRoot);
                    if (createdWorkspaceDirectories.Count > 0)
                    {
                        logs.Add(
                            "workspace",
                            "已补建工作区模板目录：" + String.Join("、", createdWorkspaceDirectories) + "。",
                            "success");
                    }
                }
                catch (Exception error)
                {
                    logs.Add("workspace", "工作区模板补建未完成：" + error.Message, "warning");
                }
            }
            string runtimeRoot = projectReady ? projectRoot : PreparedRuntimeStore.GetRoot(projectRoot);

            RuntimeBootstrapResources bootstrapResources = RuntimeBootstrapLocator.Resolve(
                projectReady ? projectRoot : null,
                LauncherPayload.GetPath("bootstrap"));
            string manifestPath = bootstrapResources.ManifestPath;
            RuntimeManifestValidation runtimeValidation = await Task.Run(delegate
            {
                return RuntimeManifestValidator.Validate(runtimeRoot, manifestPath);
            });
            RuntimeComponentValidation gitRuntime = runtimeValidation.Get("mingit");
            RuntimeComponentValidation nodeRuntime = runtimeValidation.Get("node");
            RuntimeComponentValidation pythonRuntime = runtimeValidation.Get("python");
            RuntimeComponentValidation cudaRuntime = runtimeValidation.Get("cuda");
            RuntimeComponentValidation cudnnRuntime = runtimeValidation.Get("cudnn");
            string webuiBuild = Path.Combine(projectRoot, "webui", "dist", "client", "index.html");
            bool buildReady = WebUiDependencyFilesPresent(projectRoot) && File.Exists(webuiBuild);
            bool webUiServicesOnline = await AreWebUiServicesOnlineAsync();
            bool webuiRunning = webUiActivatedInSession && webUiServicesOnline;
            int? webUiPid = webuiRunning ? TryReadManagedWebUiPid(projectRoot) : null;
            GitStatus gitStatus = await git.InspectAsync(projectRoot, false);

            string mirrorLabel = GetMirrorLabel(snapshot.Mirror);
            List<object> runtimeItems = new List<object>();
            runtimeItems.Add(RuntimeItem("project", "GitHub 项目", projectReady, projectReady ? "仓库内容已获取" : "等待获取项目", projectRoot, "GitHub", LauncherConstants.GitRemote));
            runtimeItems.Add(RuntimeItem("mingit", "Portable Git", gitRuntime.Ready, RuntimeDetail(gitRuntime), gitRuntime.TargetPath, "GitHub", null));
            runtimeItems.Add(RuntimeItem("node", "Node.js", nodeRuntime.Ready, RuntimeDetail(nodeRuntime), nodeRuntime.TargetPath, mirrorLabel, null));
            runtimeItems.Add(RuntimeItem("python", "Python", pythonRuntime.Ready, RuntimeDetail(pythonRuntime), pythonRuntime.TargetPath, "项目运行环境", null));
            runtimeItems.Add(RuntimeItem("cuda", "CUDA 运行库", cudaRuntime.Ready, RuntimeDetail(cudaRuntime), cudaRuntime.TargetPath, mirrorLabel, null));
            runtimeItems.Add(RuntimeItem("cudnn", "cuDNN DLL", cudnnRuntime.Ready, RuntimeDetail(cudnnRuntime), cudnnRuntime.TargetPath, mirrorLabel, null));
            runtimeItems.Add(RuntimeItem("webui", "WebUI build", buildReady, buildReady ? "已构建" : "尚未构建", webuiBuild, "本地构建", null));

            bool runtimesReady = runtimeValidation.RequiredComponentsReady;
            bool dependenciesReady = runtimesReady && buildReady;
            bool environmentReady = projectReady && dependenciesReady;
            List<object> steps = new List<object>();
            steps.Add(Step("environment", "环境检测", "complete"));
            steps.Add(Step("project", "获取项目", projectReady ? "complete" : "active"));
            steps.Add(Step("dependencies", "安装依赖", runtimesReady ? (projectReady && !buildReady ? "active" : "complete") : "active"));
            steps.Add(Step("finish", "准备完成", environmentReady ? "complete" : "upcoming"));

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["mode"] = environmentReady ? "ready" : "install";
            result["environmentStatus"] = environmentReady ? "ready" : "incomplete";
            result["installPath"] = projectRoot;
            result["mirror"] = snapshot.Mirror;
            result["mirrorLabel"] = mirrorLabel;
            result["gitProxyMode"] = snapshot.GitProxyMode;
            result["gitProxy"] = snapshot.GitProxy ?? String.Empty;
            result["gitMirror"] = snapshot.GitMirror ?? String.Empty;
            result["gitNetworkLabel"] = GitNetworkOptions.Describe(snapshot);
            result["steps"] = steps;
            result["runtimeItems"] = runtimeItems;
            result["runtimeManifest"] = runtimeValidation.Loaded ? "validated" : runtimeValidation.Error;
            result["projectDir"] = projectRoot;
            result["projectReady"] = projectReady;
            result["lastCheck"] = snapshot.LastCheck;
            result["terminalUrl"] = terminal.CurrentUrl;
            result["terminalRunning"] = terminal.IsRunning;
            result["webuiRunning"] = webuiRunning;
            result["webuiPid"] = webUiPid.HasValue ? (object)webUiPid.Value : null;
            result["webuiUrl"] = LauncherConstants.WebUiUrl;
            result["settingsPath"] = settings.SettingsPath;
            result["logs"] = GetUiLogs();
            result["git"] = gitStatus;
            result["updateAvailable"] = gitStatus.UpdateAvailable;
            return result;
        }

        public object ChooseInstallPath(string requestedPath)
        {
            string selected = requestedPath;
            if (String.IsNullOrWhiteSpace(selected))
            {
                using (Forms.FolderBrowserDialog dialog = new Forms.FolderBrowserDialog())
                {
                    dialog.Description = "选择 DeepFaceLabSN 安装目录（应为空目录）";
                    dialog.ShowNewFolderButton = true;
                    string current = ProjectLocator.Resolve(settings.Current);
                    string parent = Directory.GetParent(current) == null ? current : Directory.GetParent(current).FullName;
                    if (Directory.Exists(parent))
                    {
                        dialog.SelectedPath = parent;
                    }
                    if (dialog.ShowDialog() != Forms.DialogResult.OK)
                    {
                        return new Dictionary<string, object>
                        {
                            { "cancelled", true },
                            { "path", current }
                        };
                    }
                    selected = Path.Combine(dialog.SelectedPath, "DeepFaceLabSN");
                }
            }

            ProjectLocator.AssertSafeInstallPath(selected);
            string fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(selected));
            settings.Update(delegate(LauncherSettings value) { value.ProjectRoot = fullPath; });
            return new Dictionary<string, object>
            {
                { "cancelled", false },
                { "path", fullPath }
            };
        }

        public object SetMirror(string mirror)
        {
            string normalized = String.Equals(mirror, "official", StringComparison.OrdinalIgnoreCase)
                ? "official"
                : (String.Equals(mirror, "china", StringComparison.OrdinalIgnoreCase) ? "china" : "auto");
            settings.Update(delegate(LauncherSettings value) { value.Mirror = normalized; });
            logs.Add("launcher", "下载源已切换为：" + GetMirrorLabel(normalized) + "。", "info");
            return new Dictionary<string, object>
            {
                { "mirror", normalized },
                { "mirrorLabel", GetMirrorLabel(normalized) }
            };
        }

        public object ToggleMirror()
        {
            string current = settings.Current.Mirror;
            string next = String.Equals(current, "auto", StringComparison.OrdinalIgnoreCase)
                ? "china"
                : (String.Equals(current, "china", StringComparison.OrdinalIgnoreCase) ? "official" : "auto");
            return SetMirror(next);
        }

        public object SetGitNetwork(string mode, string proxy, string mirror)
        {
            string normalizedMode = GitNetworkOptions.NormalizeProxyMode(mode);
            string normalizedProxy = normalizedMode == "manual"
                ? GitNetworkOptions.NormalizeProxy(proxy)
                : null;
            if (normalizedMode == "manual" && String.IsNullOrWhiteSpace(normalizedProxy))
            {
                throw new InvalidOperationException("手动代理模式需要填写代理地址。");
            }
            string normalizedMirror = GitNetworkOptions.NormalizeMirror(mirror);
            settings.Update(delegate(LauncherSettings value)
            {
                value.GitProxyMode = normalizedMode;
                value.GitProxy = normalizedProxy;
                value.GitMirror = normalizedMirror;
            });
            LauncherSettings snapshot = settings.Current;
            string label = GitNetworkOptions.Describe(snapshot);
            logs.Add("git", "GitHub 网络策略已更新：" + label + "。", "info");
            return new Dictionary<string, object>
            {
                { "gitProxyMode", snapshot.GitProxyMode },
                { "gitProxy", snapshot.GitProxy ?? String.Empty },
                { "gitMirror", snapshot.GitMirror ?? String.Empty },
                { "gitNetworkLabel", label }
            };
        }

        public async Task<object> RunBootstrapAsync(bool repair)
        {
            await operationGate.WaitAsync();
            try
            {
                if (repair && await IsUrlOnlineAsync(LauncherConstants.WebUiUrl))
                {
                    throw new InvalidOperationException("WebUI 正在运行。请先停止 WebUI，再修复依赖，以免运行中的文件被锁定。");
                }
                ReportProgress("environment", "正在检测安装环境…", "active", 0, 4);
                string projectRoot = ProjectLocator.Resolve(settings.Current);
                if (!ProjectLocator.IsProject(projectRoot))
                {
                    await EnsurePortableGitAsync();
                    string preparedRoot = PreparedRuntimeStore.GetRoot(projectRoot);
                    ProjectLocator.AssertSafeInstallPath(preparedRoot);
                    Directory.CreateDirectory(Path.Combine(preparedRoot, "_internal"));
                    Directory.CreateDirectory(Path.Combine(preparedRoot, "webui"));
                    RuntimeBootstrapResources preparedResources = RuntimeBootstrapLocator.Resolve(
                        null,
                        LauncherPayload.GetPath("bootstrap"));

                    ReportProgress("project", "正在后台获取项目源码…", "downloading", 1, 4);
                    ReportProgress("dependencies", "正在并行准备其他依赖…", "active", 2, 4);
                    Exception runtimeFailure = null;
                    Exception cloneFailure;
                    using (CancellationTokenSource retryCancellation = new CancellationTokenSource())
                    {
                        Task<Exception> cloneTask = CloneProjectWithRetryAsync(projectRoot, retryCancellation.Token);
                        try
                        {
                            await RunBootstrapScriptAsync(preparedRoot, preparedResources, repair);
                            ReportProgress("dependencies", "其他运行时已准备完成，等待项目源码。", "complete", 3, 4);
                        }
                        catch (Exception error)
                        {
                            runtimeFailure = error;
                        }
                        finally
                        {
                            retryCancellation.Cancel();
                        }
                        cloneFailure = await cloneTask;
                    }

                    if (!ProjectLocator.IsProject(projectRoot))
                    {
                        string cloneMessage = cloneFailure == null ? "GitHub 项目尚未获取成功。" : cloneFailure.Message;
                        if (runtimeFailure == null)
                        {
                            throw new InvalidOperationException(
                                cloneMessage + "；其他运行时已在暂存区准备完成。网络恢复后点击重试即可继续获取项目。",
                                cloneFailure);
                        }
                        throw new InvalidOperationException(
                            cloneMessage + "；已并行尝试其他运行时，但依赖准备也未全部完成：" + runtimeFailure.Message,
                            cloneFailure ?? runtimeFailure);
                    }
                    if (runtimeFailure != null)
                    {
                        logs.Add("bootstrap", "并行依赖准备未全部完成，将在项目内继续修复：" + runtimeFailure.Message, "warning");
                    }
                }

                try
                {
                    IList<string> adopted = PreparedRuntimeStore.Adopt(projectRoot);
                    if (adopted.Count > 0)
                    {
                        logs.Add("bootstrap", "已将并行准备的运行时安全迁入项目：" + String.Join("、", adopted) + "。", "success");
                    }
                }
                catch (Exception error)
                {
                    logs.Add("bootstrap", "暂存运行时迁移未完成，将由依赖检查继续修复：" + error.Message, "warning");
                }

                ReportProgress("dependencies", "正在校验项目依赖…", "active", 2, 4);
                RuntimeBootstrapResources bootstrapResources = RuntimeBootstrapLocator.Resolve(
                    projectRoot,
                    LauncherPayload.GetPath("bootstrap"));
                logs.Add(
                    "bootstrap",
                    bootstrapResources.Embedded
                        ? "当前项目尚未包含完整依赖引导，正在使用启动器内嵌资源。"
                        : "正在使用项目自带的依赖引导资源。",
                    "info");
                await RunBootstrapScriptAsync(projectRoot, bootstrapResources, repair);

                ReportProgress("finish", "正在检查 WebUI 构建…", "active", 3, 4);
                await BuildWebUiIfPossibleAsync(projectRoot, repair);
                ReportProgress("finish", "环境检查完成。", "complete", 4, 4);
                return await GetStateAsync();
            }
            finally
            {
                operationGate.Release();
            }
        }

        public async Task<object> CheckUpdatesAsync()
        {
            await operationGate.WaitAsync();
            try
            {
                string root = RequireProjectRoot();
                ReportProgress("updates", "正在检查 GitHub 更新…", "running", 0, 1);
                GitStatus result = await git.CheckUpdatesAsync(root);
                ReportProgress("updates", result.UpdateAvailable ? "发现项目更新。" : "当前已是最新版本。", "complete", 1, 1);
                return result;
            }
            finally
            {
                operationGate.Release();
            }
        }

        public async Task<object> ApplyUpdateAsync()
        {
            await operationGate.WaitAsync();
            try
            {
                string root = RequireProjectRoot();
                if (await IsUrlOnlineAsync(LauncherConstants.WebUiUrl))
                {
                    throw new InvalidOperationException("WebUI 正在运行。请先停止 WebUI，再更新项目，以免运行中的文件被锁定。");
                }
                ReportProgress("updates", "正在安全拉取源码更新…", "running", 0, 2);
                GitStatus result = await git.ApplyUpdateAsync(root);
                ReportProgress("updates", "源码已更新，本地配置与工作区数据已保留。", "complete", 1, 2);
                await BuildWebUiIfPossibleAsync(root, true);
                ReportProgress("updates", "更新完成。", "complete", 2, 2);
                return await GetStateAsync();
            }
            finally
            {
                operationGate.Release();
            }
        }

        public async Task<object> StartWebUiAsync()
        {
            await operationGate.WaitAsync();
            try
            {
                string root = RequireProjectRoot();
                string node = Path.Combine(root, "_internal", "node", "bin", "node.exe");
                string manager = Path.Combine(root, "webui", "scripts", "local-manager.mjs");
                if (!File.Exists(node) || !File.Exists(manager))
                {
                    throw new InvalidOperationException("WebUI 运行环境不完整，请先执行首次设置或修复依赖。");
                }

                IDictionary<string, string> environment = PortableNodeEnvironment.Ensure(
                    DflEnvironment.Load(root, logs),
                    node);
                environment["DFL_UI_LANG"] = "zh";
                CommandResult result = await runner.RunAsync(node, ProcessRunner.Quote(manager) + " start", root, environment, "webui");
                EnsureSuccess(result, "WebUI 启动失败");
                webUiActivatedInSession = true;
                OpenUrl(LauncherConstants.WebUiUrl);
                return await GetStateAsync();
            }
            finally
            {
                operationGate.Release();
            }
        }

        public async Task<object> StopWebUiAsync()
        {
            await operationGate.WaitAsync();
            try
            {
                string root = RequireProjectRoot();
                string node = Path.Combine(root, "_internal", "node", "bin", "node.exe");
                string manager = Path.Combine(root, "webui", "scripts", "local-manager.mjs");
                if (!File.Exists(node) || !File.Exists(manager))
                {
                    webUiActivatedInSession = false;
                    return await GetStateAsync();
                }
                IDictionary<string, string> environment = PortableNodeEnvironment.Ensure(
                    DflEnvironment.Load(root, logs),
                    node);
                environment["DFL_UI_LANG"] = "zh";
                CommandResult result = await runner.RunAsync(node, ProcessRunner.Quote(manager) + " stop", root, environment, "webui");
                EnsureSuccess(result, "WebUI 停止失败");
                webUiActivatedInSession = false;
                return await GetStateAsync();
            }
            finally
            {
                operationGate.Release();
            }
        }

        public async Task<bool> HasRunningWebUiAsync()
        {
            string projectRoot = ProjectLocator.Resolve(settings.Current);
            int? managedPid = ProjectLocator.IsProject(projectRoot)
                ? TryReadManagedWebUiPid(projectRoot)
                : null;
            Task<bool> web = IsUrlOnlineAsync(LauncherConstants.WebUiUrl);
            Task<bool> runtime = IsUrlOnlineAsync(LauncherConstants.WebUiRuntimeHealthUrl);
            await Task.WhenAll(web, runtime);
            return managedPid.HasValue || web.Result || runtime.Result;
        }

        public async Task<object> StartTerminalAsync()
        {
            string url = await terminal.StartAsync(RequireProjectRoot());

            return new Dictionary<string, object>
            {
                { "terminalUrl", url },
                { "protocol", "dflsn-terminal-v1" }
            };
        }

        public Task<object> OpenLegacyAsync()
        {
            return StartTerminalAsync();
        }

        public object OpenExternal(string url)
        {
            OpenUrl(url);
            return new Dictionary<string, object> { { "ok", true } };
        }

        public LogSnapshot PollLogs(long sequence, int limit)
        {
            return logs.ReadSince(sequence, limit);
        }

        public void Dispose()
        {
            terminal.Dispose();
            operationGate.Dispose();
        }

        private async Task<Exception> CloneProjectWithRetryAsync(string projectRoot, CancellationToken cancellationToken)
        {
            Exception lastFailure = null;
            int attempt = 0;
            while (!cancellationToken.IsCancellationRequested && !ProjectLocator.IsProject(projectRoot))
            {
                attempt++;
                try
                {
                    logs.Add("git", "GitHub 后台克隆第 " + attempt + " 次尝试开始。", "info");
                    ReportProgress("project", "后台获取项目 · 第 " + attempt + " 次尝试", "downloading", 1, 4);
                    await git.CloneAsync(projectRoot, attempt);
                    logs.Add("git", "GitHub 项目已在后台获取完成。", "success");
                    ReportProgress("project", "项目源码获取完成。", "complete", 2, 4);
                    return null;
                }
                catch (Exception error)
                {
                    lastFailure = error;
                    logs.Add("git", "第 " + attempt + " 次获取失败；其他依赖继续安装，60 秒后自动重试：" + error.Message, "warning");
                    ReportProgress("project", "网络不稳定；60 秒后自动重试", "checking", 1, 4);
                }
                if (cancellationToken.IsCancellationRequested) break;
                try
                {
                    await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
                }
                catch (TaskCanceledException)
                {
                    break;
                }
            }
            return lastFailure;
        }
        private async Task EnsurePortableGitAsync()
        {
            if (!String.IsNullOrWhiteSpace(git.LocateGit()))
            {
                return;
            }

            string bootstrapRoot = LauncherPayload.GetPath("bootstrap");
            string bootstrapScript = Path.Combine(bootstrapRoot, "bootstrap.ps1");
            string manifest = Path.Combine(bootstrapRoot, "runtime-manifest.json");
            if (!File.Exists(bootstrapScript) || !File.Exists(manifest))
            {
                throw new FileNotFoundException("未找到便携 Git 引导文件；请重新解压完整启动器。", bootstrapScript);
            }

            string toolsRoot = Path.Combine(LauncherConstants.SettingsDirectory, "bootstrap-tools");
            string arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "
                + ProcessRunner.Quote(bootstrapScript)
                + " -GitOnly -ProjectRoot " + ProcessRunner.Quote(toolsRoot)
                + " -ManifestPath " + ProcessRunner.Quote(manifest)
                + " -Mirror " + ProcessRunner.Quote(settings.Current.Mirror);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string failureMessage = null;
            logs.Add("bootstrap", "未检测到 Git，正在准备便携 MinGit…", "info");
            CommandResult result = await runner.RunAsync(
                "powershell.exe",
                arguments,
                bootstrapRoot,
                MirrorEnvironment(null),
                "bootstrap",
                delegate(string line)
                {
                    string candidate = TryGetBootstrapFailureMessage(line, serializer);
                    if (!String.IsNullOrWhiteSpace(candidate)) { failureMessage = candidate; }
                    return TryForwardBootstrapProgress(line, serializer);
                });
            EnsureBootstrapSuccess(result, "便携 Git 安装失败", failureMessage);
            if (String.IsNullOrWhiteSpace(git.LocateGit()))
            {
                throw new FileNotFoundException("便携 Git 安装完成，但未找到 git.exe。", Path.Combine(toolsRoot, "git", "cmd", "git.exe"));
            }
        }

        private async Task RunBootstrapScriptAsync(
            string projectRoot,
            RuntimeBootstrapResources resources,
            bool repair)
        {
            string arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "
                + ProcessRunner.Quote(resources.ScriptPath)
                + " -ProjectRoot " + ProcessRunner.Quote(projectRoot)
                + " -ManifestPath " + ProcessRunner.Quote(resources.ManifestPath)
                + " -Mirror " + ProcessRunner.Quote(settings.Current.Mirror);
            if (repair)
            {
                arguments += " -Repair";
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string failureMessage = null;
            CommandResult result = await runner.RunAsync(
                "powershell.exe",
                arguments,
                projectRoot,
                MirrorEnvironment(null),
                "bootstrap",
                delegate(string line)
                {
                    string candidate = TryGetBootstrapFailureMessage(line, serializer);
                    if (!String.IsNullOrWhiteSpace(candidate)) { failureMessage = candidate; }
                    return TryForwardBootstrapProgress(line, serializer);
                });
            EnsureBootstrapSuccess(result, "依赖安装失败", failureMessage);
        }

        private async Task BuildWebUiIfPossibleAsync(string projectRoot, bool force)
        {
            string node = Path.Combine(projectRoot, "_internal", "node", "bin", "node.exe");
            string corepack = Path.Combine(projectRoot, "_internal", "node", "bin", "node_modules", "corepack", "dist", "corepack.js");
            string webuiRoot = Path.Combine(projectRoot, "webui");
            string vite = Path.Combine(webuiRoot, "node_modules", "vite", "bin", "vite.js");
            string index = Path.Combine(webuiRoot, "dist", "client", "index.html");
            if (!File.Exists(node))
            {
                throw new FileNotFoundException("WebUI 构建需要项目内的便携 Node.js。", node);
            }

            IDictionary<string, string> environment = PortableNodeEnvironment.Ensure(
                DflEnvironment.Load(projectRoot, logs),
                node);
            environment = MirrorEnvironment(environment);
            bool dependencyTreePresent = Directory.Exists(Path.Combine(webuiRoot, "node_modules"));
            bool dependencyFilesPresent = WebUiDependencyFilesPresent(projectRoot);
            bool dependenciesLoad = dependencyFilesPresent
                && await CanLoadWebUiDependenciesAsync(node, webuiRoot, environment);
            if (!force && dependenciesLoad && File.Exists(index))
            {
                return;
            }

            if (force || !dependenciesLoad)
            {
                if (!File.Exists(corepack))
                {
                    throw new FileNotFoundException("缺少 Node.js Corepack，无法安装 WebUI 依赖。", corepack);
                }
                logs.Add("bootstrap", "正在按 pnpm 锁文件安装 WebUI 依赖…", "info");
                string installArguments = ProcessRunner.Quote(corepack)
                    + " pnpm install --frozen-lockfile --prefer-offline";
                if (dependencyTreePresent && !dependenciesLoad)
                {
                    installArguments += " --force";
                    logs.Add("bootstrap", "检测到依赖残留或正在修复，将强制重建原生 Node.js 依赖。", "warning");
                }
                CommandResult install = await runner.RunAsync(
                    node,
                    installArguments,
                    webuiRoot,
                    environment,
                    "bootstrap");
                EnsureSuccess(install, "WebUI 依赖安装失败");

                if (!WebUiDependencyFilesPresent(projectRoot)
                    || !await CanLoadWebUiDependenciesAsync(node, webuiRoot, environment))
                {
                    throw new InvalidOperationException(
                        "WebUI 依赖安装命令已结束，但 node-pty 或 esbuild 仍无法加载；请重试修复依赖。");
                }
            }

            if (force || !File.Exists(index))
            {
                CommandResult build = await runner.RunAsync(
                    node,
                    ProcessRunner.Quote(vite) + " build --configLoader runner",
                    webuiRoot,
                    environment,
                    "bootstrap");
                EnsureSuccess(build, "WebUI 构建失败");
            }
        }

        private async Task<bool> CanLoadWebUiDependenciesAsync(
            string node,
            string webuiRoot,
            IDictionary<string, string> environment)
        {
            CommandResult validation = await runner.RunAsync(
                node,
                "-e \"try{require('node-pty');require('esbuild').transformSync('let ready=true')}catch(error){process.exit(1)}\"",
                webuiRoot,
                environment,
                "bootstrap");
            if (!validation.Success)
            {
                logs.Add("bootstrap", "检测到未完成的 Node.js 依赖安装，将自动修复。", "warning");
            }
            return validation.Success;
        }

        private static bool WebUiDependencyFilesPresent(string projectRoot)
        {
            string webuiRoot = Path.Combine(projectRoot, "webui");
            return File.Exists(Path.Combine(webuiRoot, "node_modules", "vite", "bin", "vite.js"))
                && File.Exists(Path.Combine(
                    webuiRoot,
                    "node_modules",
                    "node-pty",
                    "prebuilds",
                    "win32-x64",
                    "pty.node"))
                && File.Exists(Path.Combine(
                    webuiRoot,
                    "node_modules",
                    "@esbuild",
                    "win32-x64",
                    "esbuild.exe"));
        }

        private IDictionary<string, string> MirrorEnvironment(IDictionary<string, string> source)
        {
            Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (source != null)
            {
                foreach (KeyValuePair<string, string> item in source)
                {
                    environment[item.Key] = item.Value;
                }
            }

            string mirror = settings.Current.Mirror;
            environment["DFL_MIRROR"] = mirror;
            if (!String.Equals(mirror, "official", StringComparison.OrdinalIgnoreCase))
            {
                environment["NPM_CONFIG_REGISTRY"] = "https://registry.npmmirror.com";
                environment["COREPACK_NPM_REGISTRY"] = "https://registry.npmmirror.com";
                environment["PIP_INDEX_URL"] = "https://pypi.tuna.tsinghua.edu.cn/simple";
                environment["PIP_TRUSTED_HOST"] = "pypi.tuna.tsinghua.edu.cn";
            }
            else if (String.Equals(mirror, "official", StringComparison.OrdinalIgnoreCase))
            {
                environment["NPM_CONFIG_REGISTRY"] = "https://registry.npmjs.org";
                environment["COREPACK_NPM_REGISTRY"] = "https://registry.npmjs.org";
                environment["PIP_INDEX_URL"] = "https://pypi.org/simple";
                environment.Remove("PIP_TRUSTED_HOST");
            }
            return environment;
        }

        private string RequireProjectRoot()
        {
            string root = ProjectLocator.Resolve(settings.Current);
            if (!ProjectLocator.IsProject(root))
            {
                throw new InvalidOperationException("项目尚未安装，请先完成首次设置。");
            }
            return root;
        }

        private static async Task<string> ReadVersionQuietlyAsync(string executable, string arguments)
        {
            if (!File.Exists(executable))
            {
                return null;
            }
            return await Task.Run(delegate
            {
                try
                {
                    ProcessStartInfo startInfo = new ProcessStartInfo(executable, arguments);
                    startInfo.UseShellExecute = false;
                    startInfo.CreateNoWindow = true;
                    startInfo.RedirectStandardOutput = true;
                    startInfo.RedirectStandardError = true;
                    using (Process process = Process.Start(startInfo))
                    {
                        string output = process.StandardOutput.ReadToEnd();
                        string error = process.StandardError.ReadToEnd();
                        process.WaitForExit(5000);
                        string value = String.IsNullOrWhiteSpace(output) ? error : output;
                        return String.IsNullOrWhiteSpace(value) ? null : value.Trim();
                    }
                }
                catch
                {
                    return null;
                }
            });
        }

        private static int CountDlls(string directory)
        {
            try
            {
                return Directory.Exists(directory)
                    ? Directory.GetFiles(directory, "*.dll", SearchOption.AllDirectories).Length
                    : 0;
            }
            catch
            {
                return 0;
            }
        }

        private static string FindFile(string directory, string fileName)
        {
            try
            {
                if (!Directory.Exists(directory))
                {
                    return null;
                }
                string[] matches = Directory.GetFiles(directory, fileName, SearchOption.AllDirectories);
                return matches.Length == 0 ? null : matches[0];
            }
            catch
            {
                return null;
            }
        }

        private static async Task<bool> IsUrlOnlineAsync(string url)
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "GET";
                    request.Timeout = 800;
                    request.ReadWriteTimeout = 800;
                    request.Proxy = null;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        return (int)response.StatusCode >= 200 && (int)response.StatusCode < 500;
                    }
                }
                catch
                {
                    return false;
                }
            });
        }

        private static async Task<bool> AreWebUiServicesOnlineAsync()
        {
            Task<bool> web = IsUrlOnlineAsync(LauncherConstants.WebUiUrl);
            Task<bool> runtime = IsUrlOnlineAsync(LauncherConstants.WebUiRuntimeHealthUrl);
            await Task.WhenAll(web, runtime);
            return web.Result && runtime.Result;
        }

        private static int? TryReadManagedWebUiPid(string projectRoot)
        {
            try
            {
                string runtimeRoot = Path.Combine(projectRoot, "webui", ".runtime");
                string pidPath = Path.Combine(runtimeRoot, "local-manager.pid");
                string statusPath = Path.Combine(runtimeRoot, "local-manager.status.json");
                int pid;
                if (!File.Exists(pidPath)
                    || !Int32.TryParse(File.ReadAllText(pidPath).Trim(), out pid)
                    || pid <= 0
                    || !File.Exists(statusPath))
                {
                    return null;
                }

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> status = serializer.Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(statusPath));
                int supervisorPid = status != null && status.ContainsKey("supervisorPid")
                    ? Convert.ToInt32(status["supervisorPid"])
                    : 0;
                string state = status != null && status.ContainsKey("state")
                    ? Convert.ToString(status["state"])
                    : null;
                if (supervisorPid != pid || !String.Equals(state, "running", StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }

                using (Process process = Process.GetProcessById(pid))
                {
                    if (process.HasExited || !String.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                    {
                        return null;
                    }
                }
                return pid;
            }
            catch
            {
                return null;
            }
        }

        private static string RuntimeDetail(RuntimeComponentValidation runtime)
        {
            if (runtime == null) return "运行时清单未提供校验结果。";
            if (!runtime.Ready) return String.IsNullOrWhiteSpace(runtime.Reason) ? "未安装" : runtime.Reason;
            return String.IsNullOrWhiteSpace(runtime.Version) ? "已通过完整校验" : runtime.Version + " · 已校验";
        }

        private static object RuntimeItem(string id, string label, bool ready, string detail, string path, string source, string link)
        {
            Dictionary<string, object> value = new Dictionary<string, object>
            {
                { "id", id },
                { "label", label },
                { "status", ready ? "installed" : "waiting" },
                { "ready", ready },
                { "detail", detail },
                { "path", path },
                { "source", source }
            };
            if (!String.IsNullOrWhiteSpace(link))
            {
                value["link"] = link;
            }
            return value;
        }

        private static object Step(string id, string label, string status)
        {
            return new Dictionary<string, object>
            {
                { "id", id },
                { "label", label },
                { "status", status }
            };
        }

        private IList<object> GetUiLogs()
        {
            IList<LogEntry> entries = logs.ReadSince(0, 200).Entries;
            List<object> result = new List<object>();
            for (int index = 0; index < entries.Count; index++)
            {
                LogEntry entry = entries[index];
                DateTime timestamp;
                string time = DateTime.TryParse(entry.Timestamp, out timestamp)
                    ? timestamp.ToLocalTime().ToString("HH:mm:ss")
                    : null;
                result.Add(new Dictionary<string, object>
                {
                    { "time", time },
                    { "text", entry.Line },
                    { "line", entry.Line },
                    { "level", entry.Level },
                    { "channel", entry.Channel },
                    { "sequence", entry.Sequence }
                });
            }
            return result;
        }

        private bool TryForwardBootstrapProgress(string line, JavaScriptSerializer serializer)
        {
            try
            {
                Dictionary<string, object> raw = serializer.DeserializeObject(line) as Dictionary<string, object>;
                if (raw == null)
                {
                    return false;
                }
                string message = raw.ContainsKey("message") ? Convert.ToString(raw["message"]) : null;
                string status = raw.ContainsKey("status") ? Convert.ToString(raw["status"]) : null;
                string normalizedStatus = NormalizeBootstrapStatus(status);
                if (!String.IsNullOrWhiteSpace(message))
                {
                    bool failed = String.Equals(normalizedStatus, "error", StringComparison.OrdinalIgnoreCase);
                    logs.Add("bootstrap", message, failed ? "error" : "info");
                }
                Dictionary<string, object> value = new Dictionary<string, object>(raw);
                if (!String.IsNullOrWhiteSpace(normalizedStatus))
                {
                    value["status"] = normalizedStatus;
                }
                string id = raw.ContainsKey("id") ? Convert.ToString(raw["id"]) : null;
                if (String.IsNullOrWhiteSpace(id) && raw.ContainsKey("stage"))
                {
                    id = Convert.ToString(raw["stage"]);
                    value["id"] = id;
                }
                if (String.IsNullOrWhiteSpace(id))
                {
                    return true;
                }
                if (!value.ContainsKey("label") && raw.ContainsKey("message"))
                {
                    value["label"] = Convert.ToString(raw["message"]);
                }
                Action<object> handler = ProgressChanged;
                if (handler != null)
                {
                    handler(value);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string TryGetBootstrapFailureMessage(string line, JavaScriptSerializer serializer)
        {
            try
            {
                Dictionary<string, object> raw = serializer.DeserializeObject(line) as Dictionary<string, object>;
                if (raw == null || !raw.ContainsKey("status") || !raw.ContainsKey("message"))
                {
                    return null;
                }
                string status = Convert.ToString(raw["status"]);
                string message = Convert.ToString(raw["message"]);
                return String.Equals(status, "failed", StringComparison.OrdinalIgnoreCase)
                    && !String.IsNullOrWhiteSpace(message)
                    ? message
                    : null;
            }
            catch
            {
                return null;
            }
        }
        private static string NormalizeBootstrapStatus(string status)
        {
            string value = String.IsNullOrWhiteSpace(status) ? String.Empty : status.Trim().ToLowerInvariant();
            switch (value)
            {
                case "ready":
                case "cached":
                case "verified":
                case "resumed":
                case "configured":
                case "space-ok":
                case "selected":
                case "staged":
                case "preserved":
                case "backup-retained":
                    return "installed";
                case "checking":
                case "verifying":
                case "verifying-cache":
                case "probing":
                case "source-failed":
                case "http-failed":
                    return "checking";
                case "downloading":
                case "downloaded":
                case "connecting":
                case "restart":
                    return "downloading";
                case "extracting":
                case "repairing":
                    return "installing";
                case "planned":
                case "rolled-back":
                    return "waiting";
                case "failed":
                case "unavailable":
                case "rollback-failed":
                case "cache-rejected":
                case "hash-mismatch":
                    return "error";
                case "complete":
                    return "complete";
                default:
                    return value.StartsWith("bits-", StringComparison.Ordinal) ? "downloading" : value;
            }
        }

        private static string GetMirrorLabel(string mirror)
        {
            if (String.Equals(mirror, "china", StringComparison.OrdinalIgnoreCase))
            {
                return "国内镜像";
            }
            if (String.Equals(mirror, "official", StringComparison.OrdinalIgnoreCase))
            {
                return "官方源";
            }
            return "自动选择";
        }

        private void ReportProgress(string id, string label, string status, int current, int total)
        {
            Dictionary<string, object> value = new Dictionary<string, object>
            {
                { "id", id },
                { "label", label },
                { "status", status },
                { "current", current },
                { "total", total },
                { "percent", total <= 0 ? 0 : (int)Math.Round((double)current * 100.0 / total) }
            };
            Action<object> handler = ProgressChanged;
            if (handler != null)
            {
                handler(value);
            }
        }

        private static void OpenUrl(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                throw new InvalidOperationException("只允许打开 HTTP 或 HTTPS 地址。");
            }
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = uri.AbsoluteUri;
            startInfo.UseShellExecute = true;
            Process.Start(startInfo);
        }

        private static void EnsureSuccess(CommandResult result, string prefix)
        {
            if (result.Success)
            {
                return;
            }
            string detail = String.IsNullOrWhiteSpace(result.StandardError) ? result.StandardOutput : result.StandardError;
            throw new InvalidOperationException(prefix + "（退出码 " + result.ExitCode + "）" + (String.IsNullOrWhiteSpace(detail) ? String.Empty : "：" + detail));
        }
        private static void EnsureBootstrapSuccess(CommandResult result, string prefix, string failureMessage)
        {
            if (result.Success)
            {
                return;
            }
            if (!String.IsNullOrWhiteSpace(failureMessage))
            {
                throw new InvalidOperationException(prefix + "（退出码 " + result.ExitCode + "）：" + failureMessage);
            }
            EnsureSuccess(result, prefix);
        }
    }
}
