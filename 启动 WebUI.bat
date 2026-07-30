@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
    echo.
    echo [WebUI] 未找到 Node.js。
    echo 请先安装 Node.js 20 或更高版本，再重新运行本管理器。
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0webui\scripts\local-manager.mjs" (
    echo.
    echo [WebUI] 启动脚本缺失：webui\scripts\local-manager.mjs
    echo.
    pause
    exit /b 1
)

if not "%~1"=="" goto run_argument

:menu
cls
echo ============================================================
echo                 DeepFaceLabSN WebUI 管理器
echo ============================================================
echo.
echo   1. 启动并打开 WebUI
echo   2. 查看运行状态
echo   3. 重启 WebUI
echo   4. 停止 WebUI
echo   0. 退出
echo.
set "WEBUI_CHOICE="
set /p "WEBUI_CHOICE=请选择："

if "%WEBUI_CHOICE%"=="1" goto start_webui
if "%WEBUI_CHOICE%"=="2" goto status_webui
if "%WEBUI_CHOICE%"=="3" goto restart_webui
if "%WEBUI_CHOICE%"=="4" goto stop_webui
if "%WEBUI_CHOICE%"=="0" exit /b 0
goto menu

:start_webui
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" start
if errorlevel 1 goto action_failed
start "" "http://127.0.0.1:4173/"
goto action_done

:status_webui
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" status
goto action_done

:restart_webui
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" restart
if errorlevel 1 goto action_failed
start "" "http://127.0.0.1:4173/"
goto action_done

:stop_webui
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" stop
if errorlevel 1 goto action_failed
goto action_done

:run_argument
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" %~1
exit /b %errorlevel%

:action_failed
echo.
echo 操作失败。请查看 webui\.runtime\logs 下的最新日志。

:action_done
echo.
pause
goto menu
