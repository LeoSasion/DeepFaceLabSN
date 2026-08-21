using System;
using System.Reflection;
using System.Windows;

namespace DeepFaceLabSN.Launcher
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application application = null;
            try
            {
                int? applyUpdateResult = LauncherSelfUpdater.TryRunApplyUpdate(args);
                if (applyUpdateResult.HasValue)
                {
                    return applyUpdateResult.Value;
                }
                LauncherSelfUpdater.ScheduleCleanup(args);

                application = new Application();
                application.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                if (!LauncherSelfUpdater.ShouldSkipStartupCheck(args) &&
                    LauncherSelfUpdater.CheckAtStartup())
                {
                    application.Shutdown();
                    return 0;
                }
                if (!WebView2RuntimeBootstrapper.EnsureInstalled())
                {
                    application.Shutdown();
                    return 2;
                }
                PayloadRuntime runtime = PayloadRuntime.Prepare();
                return RunApplication(application, runtime);
            }
            catch (Exception error)
            {
                Exception detail = Unwrap(error);
                if (application != null)
                {
                    application.Shutdown();
                }
                MessageBox.Show(
                    detail.Message,
                    LauncherConstants.ProductName,
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
                return 1;
            }
        }

        private static int RunApplication(Application application, PayloadRuntime runtime)
        {
            if (application == null)
            {
                throw new ArgumentNullException("application");
            }
            if (runtime == null)
            {
                throw new ArgumentNullException("runtime");
            }
            Type windowType = Assembly.GetExecutingAssembly().GetType(
                "DeepFaceLabSN.Launcher.MainWindow",
                true,
                false);
            Window window = Activator.CreateInstance(windowType) as Window;
            if (window == null)
            {
                throw new InvalidOperationException("无法创建启动器主窗口。");
            }

            application.ShutdownMode = ShutdownMode.OnMainWindowClose;
            application.Run(window);
            return 0;
        }

        private static Exception Unwrap(Exception error)
        {
            Exception current = error;
            while (current is TargetInvocationException && current.InnerException != null)
            {
                current = current.InnerException;
            }
            return current;
        }
    }
}
