param(
    [ValidateSet(
        "menu",
        "stopping",
        "node-missing",
        "manager-missing",
        "stop-failed",
        "action-failed",
        "input-failed"
    )]
    [string]$View = "menu"
)

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

try {
    $Host.UI.RawUI.WindowTitle = "DeepFaceLabSN WebUI Manager"
} catch {
    # Some redirected consoles do not expose a writable window title.
}

function Write-Rule {
    param(
        [ConsoleColor]$Color = [ConsoleColor]::DarkCyan,
        [string]$Character = "━"
    )

    Write-Host ("  " + ($Character * 54)) -ForegroundColor $Color
}

function Write-MenuItem {
    param(
        [string]$Key,
        [string]$English,
        [string]$Chinese,
        [ConsoleColor]$Color
    )

    Write-Host "    [" -NoNewline -ForegroundColor DarkGray
    Write-Host $Key -NoNewline -ForegroundColor Yellow
    Write-Host "]  " -NoNewline -ForegroundColor DarkGray
    Write-Host $English.PadRight(17) -NoNewline -ForegroundColor $Color
    Write-Host "│  " -NoNewline -ForegroundColor DarkGray
    Write-Host $Chinese -ForegroundColor Gray
}

function Write-Notice {
    param(
        [string]$English,
        [string]$Chinese,
        [ConsoleColor]$Color = [ConsoleColor]::Yellow
    )

    Write-Host
    Write-Rule -Color DarkGray -Character "─"
    Write-Host "  " -NoNewline
    Write-Host $English -NoNewline -ForegroundColor $Color
    Write-Host "  /  " -NoNewline -ForegroundColor DarkGray
    Write-Host $Chinese -ForegroundColor Gray
    Write-Rule -Color DarkGray -Character "─"
    Write-Host
}

switch ($View) {
    "stopping" {
        Clear-Host
        Write-Notice "Stopping WebUI..." "正在停止 WebUI…" Red
        exit 0
    }
    "node-missing" {
        Write-Notice "Node.js was not found." "未找到 Node.js。" Red
        Write-Host "  Install Node.js 20 or newer and try again." -ForegroundColor DarkGray
        Write-Host "  请安装 Node.js 20 或更高版本后重试。" -ForegroundColor DarkGray
        exit 0
    }
    "manager-missing" {
        Write-Notice "The WebUI manager script is missing." "WebUI 管理脚本缺失。" Red
        exit 0
    }
    "stop-failed" {
        Write-Notice "WebUI could not be stopped cleanly." "WebUI 未能正常停止。" Red
        Write-Host "  Check webui\.runtime\logs for details." -ForegroundColor DarkGray
        Write-Host "  请检查 webui\.runtime\logs 中的日志。" -ForegroundColor DarkGray
        exit 0
    }
    "action-failed" {
        Write-Notice "The operation failed." "操作失败。" Red
        Write-Host "  Check the latest log under webui\.runtime\logs." -ForegroundColor DarkGray
        Write-Host "  请查看 webui\.runtime\logs 下的最新日志。" -ForegroundColor DarkGray
        exit 0
    }
    "input-failed" {
        Write-Notice "No valid selection was received." "没有收到有效选项。" Yellow
        exit 0
    }
}

Clear-Host
Write-Host
Write-Rule
Write-Host "  " -NoNewline
Write-Host "DEEPFACELABSN" -NoNewline -ForegroundColor Cyan
Write-Host "  WEBUI MANAGER" -ForegroundColor White
Write-Host "  Local Web + Runtime Control" -NoNewline -ForegroundColor DarkGray
Write-Host "  ·  本地服务控制" -ForegroundColor Gray
Write-Rule -Color DarkGray -Character "─"
Write-Host
Write-MenuItem "1" "START" "启动并打开浏览器" Green
Write-MenuItem "2" "STATUS" "查看服务状态" Cyan
Write-MenuItem "3" "RESTART" "重启并打开浏览器" Magenta
Write-MenuItem "4" "STOP" "停止后台服务" Red
Write-MenuItem "0" "EXIT" "停止服务并退出" DarkYellow
Write-Host
Write-Rule -Color DarkGray -Character "─"
Write-Host "  Browser language is selected and saved in the WebUI." -ForegroundColor DarkGray
Write-Host "  浏览器语言请在 WebUI 中切换，选择结果会自动保存。" -ForegroundColor DarkGray
Write-Rule
Write-Host
Write-Host "  SELECT" -NoNewline -ForegroundColor Yellow
Write-Host " / 请选择  " -NoNewline -ForegroundColor Gray
Write-Host "›" -NoNewline -ForegroundColor Cyan
exit 0
