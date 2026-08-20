using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class MainWindow : Window
    {
        private readonly Grid root;
        private readonly WebView2 webView;
        private readonly LogBuffer logs;
        private readonly SettingsStore settings;
        private readonly HostController controller;
        private RpcBridge bridge;
        private bool allowClose;
        private bool closePromptInProgress;

        public MainWindow()
        {
            Title = LauncherConstants.ProductName;
            Width = 1180;
            Height = 760;
            MinWidth = 900;
            MinHeight = 620;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.CanResize;
            Background = new SolidColorBrush(Color.FromRgb(8, 12, 18));
            UseLayoutRounding = true;

            WindowChrome chrome = new WindowChrome();
            chrome.CaptionHeight = 0;
            chrome.ResizeBorderThickness = new Thickness(7);
            chrome.CornerRadius = new CornerRadius(0);
            chrome.GlassFrameThickness = new Thickness(0);
            chrome.UseAeroCaptionButtons = false;
            WindowChrome.SetWindowChrome(this, chrome);

            root = new Grid();
            Content = root;
            webView = new WebView2();
            webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 8, 12, 18);
            root.Children.Add(webView);

            logs = new LogBuffer();
            settings = new SettingsStore();
            controller = new HostController(settings, logs);

            Loaded += OnLoaded;
            Closing += OnClosing;
            Closed += OnClosed;
        }

        public bool IsWindowMaximized
        {
            get { return WindowState == WindowState.Maximized; }
        }

        public void MinimizeWindow()
        {
            WindowState = WindowState.Minimized;
        }

        public void ToggleMaximizeWindow()
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        }

        public void CloseWindow()
        {
            Close();
        }

        public void DragWindow()
        {
            try
            {
                if (Mouse.LeftButton == MouseButtonState.Pressed)
                {
                    DragMove();
                }
            }
            catch
            {
            }
        }

        private async void OnLoaded(object sender, RoutedEventArgs args)
        {
            string uiDirectory = FindUiDirectory();
            if (uiDirectory == null)
            {
                ShowFatal("启动器内嵌界面资源不完整，请重新下载 EXE。", null);
                return;
            }

            try
            {
                string userData = Path.Combine(LauncherConstants.SettingsDirectory, "WebView2");
                Directory.CreateDirectory(userData);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await webView.EnsureCoreWebView2Async(environment);

                webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    LauncherConstants.VirtualHost,
                    uiDirectory,
                    CoreWebView2HostResourceAccessKind.DenyCors);
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = String.Equals(
                    Environment.GetEnvironmentVariable("DFLSN_LAUNCHER_DEVTOOLS"),
                    "1",
                    StringComparison.Ordinal);
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
                webView.CoreWebView2.NavigationStarting += OnNavigationStarting;
                webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
                webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;

                bridge = new RpcBridge(this, webView.CoreWebView2, controller);
                webView.Source = new Uri("https://" + LauncherConstants.VirtualHost + "/index.html");
                logs.Add("launcher", "原生宿主已就绪。", "info");
            }
            catch (Exception error)
            {
                ShowFatal("无法初始化 Microsoft Edge WebView2。请安装 WebView2 Runtime 后重试。", error);
            }
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            Uri uri;
            if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out uri))
            {
                args.Cancel = true;
                return;
            }
            if (String.Equals(uri.Host, LauncherConstants.VirtualHost, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            args.Cancel = true;
            OpenExternal(args.Uri);
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (!args.IsSuccess || bridge == null)
            {
                return;
            }
            await bridge.PushStateAsync();
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        }

        private async void OnClosing(object sender, CancelEventArgs args)
        {
            if (allowClose)
            {
                return;
            }

            args.Cancel = true;
            if (closePromptInProgress)
            {
                return;
            }

            closePromptInProgress = true;
            try
            {
                bool webUiRunning = await controller.HasRunningWebUiAsync();
                if (!webUiRunning)
                {
                    allowClose = true;
                    Close();
                    return;
                }

                MessageBoxResult choice = MessageBox.Show(
                    this,
                    "检测到 WebUI 服务仍在后台运行。是否同时关闭 WebUI 服务？\n\n"
                        + "是：关闭 WebUI 服务并退出\n"
                        + "否：保留 WebUI 后台运行并退出\n"
                        + "取消：返回启动器",
                    "确认关闭 WebUI 服务",
                    MessageBoxButton.YesNoCancel,
                    MessageBoxImage.Question,
                    MessageBoxResult.Yes);
                if (choice == MessageBoxResult.Cancel)
                {
                    return;
                }

                if (choice == MessageBoxResult.Yes)
                {
                    try
                    {
                        await controller.StopWebUiAsync();
                        if (await controller.HasRunningWebUiAsync())
                        {
                            throw new InvalidOperationException("WebUI 服务仍有组件在线，请稍后重试。");
                        }
                    }
                    catch (Exception error)
                    {
                        MessageBox.Show(
                            this,
                            "无法安全关闭 WebUI 服务，启动器将保持打开。\n\n" + error.Message,
                            "WebUI 服务关闭失败",
                            MessageBoxButton.OK,
                            MessageBoxImage.Error);
                        return;
                    }
                }

                allowClose = true;
                Close();
            }
            finally
            {
                closePromptInProgress = false;
            }
        }

        private void OnClosed(object sender, EventArgs args)
        {
            if (bridge != null)
            {
                bridge.Dispose();
            }
            controller.Dispose();
            webView.Dispose();
        }

        private void ShowFatal(string message, Exception error)
        {
            root.Children.Clear();
            StackPanel panel = new StackPanel();
            panel.HorizontalAlignment = HorizontalAlignment.Center;
            panel.VerticalAlignment = VerticalAlignment.Center;
            panel.MaxWidth = 680;

            TextBlock title = new TextBlock();
            title.Text = "DeepFaceLabSN Launcher";
            title.FontSize = 24;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = Brushes.White;
            title.Margin = new Thickness(0, 0, 0, 16);
            panel.Children.Add(title);

            TextBlock body = new TextBlock();
            body.Text = message + (error == null ? String.Empty : "\n\n" + error.Message);
            body.FontSize = 14;
            body.LineHeight = 22;
            body.TextWrapping = TextWrapping.Wrap;
            body.Foreground = new SolidColorBrush(Color.FromRgb(164, 181, 199));
            panel.Children.Add(body);
            root.Children.Add(panel);
        }

        private static string FindUiDirectory()
        {
            string directory = LauncherPayload.GetPath("ui");
            return File.Exists(Path.Combine(directory, "index.html")) ? directory : null;
        }

        private static void OpenExternal(string url)
        {
            try
            {
                Uri uri;
                if (!Uri.TryCreate(url, UriKind.Absolute, out uri)
                    || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                {
                    return;
                }
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = uri.AbsoluteUri;
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
            }
            catch
            {
            }
        }
    }
}
