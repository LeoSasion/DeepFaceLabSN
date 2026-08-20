@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "UI_LANG="
set "MANAGER_ACTION="
set "MENU_RENDERER=%~dp0webui\scripts\launcher-menu.ps1"
set "NODE_INSTALLER=%~dp0webui\scripts\install-node.ps1"
set "NODE_REQUIRED_VERSION=24.19.0"
if /i "%DFL_UI_LANG%"=="zh" set "UI_LANG=zh"
if /i "%DFL_UI_LANG%"=="en" set "UI_LANG=en"

:parse_arguments
if "%~1"=="" goto arguments_done
if /i "%~1"=="--lang" (
    if "%~2"=="" goto invalid_arguments
    set "UI_LANG=%~2"
    shift
    shift
    goto parse_arguments
)
if /i "%~1"=="zh" (
    set "UI_LANG=zh"
    shift
    goto parse_arguments
)
if /i "%~1"=="en" (
    set "UI_LANG=en"
    shift
    goto parse_arguments
)
if not defined MANAGER_ACTION (
    set "MANAGER_ACTION=%~1"
    shift
    goto parse_arguments
)
goto invalid_arguments

:arguments_done
if defined UI_LANG if /i not "%UI_LANG%"=="zh" if /i not "%UI_LANG%"=="en" goto invalid_language
if not defined UI_LANG set "UI_LANG=en"

:initialize
set "DFL_UI_LANG=%UI_LANG%"

call :find_node
if not defined NODE_EXE (
    if not exist "%NODE_INSTALLER%" goto node_installer_missing
    call :render_notice node-installing
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%NODE_INSTALLER%"
    if errorlevel 1 goto node_install_failed
    call :find_node
    if not defined NODE_EXE goto node_install_failed
)

if not exist "%~dp0webui\scripts\local-manager.mjs" (
    call :render_notice manager-missing
    echo.
    pause
    exit /b 1
)

if defined MANAGER_ACTION goto run_argument

:menu
call :render_menu
choice /c 12340 /n /m " "
set "WEBUI_CHOICE=%errorlevel%"

if "%WEBUI_CHOICE%"=="1" goto start_webui
if "%WEBUI_CHOICE%"=="2" goto status_webui
if "%WEBUI_CHOICE%"=="3" goto restart_webui
if "%WEBUI_CHOICE%"=="4" goto stop_webui
if "%WEBUI_CHOICE%"=="5" goto exit_webui
goto input_failed

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

:exit_webui
call :render_notice stopping
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" stop
if errorlevel 1 goto exit_failed
exit /b 0

:exit_failed
call :render_notice stop-failed
echo.
pause
exit /b 1

:run_argument
"%NODE_EXE%" "%~dp0webui\scripts\local-manager.mjs" "%MANAGER_ACTION%"
exit /b %errorlevel%

:action_failed
call :render_notice action-failed

:action_done
echo.
pause
goto menu

:input_failed
call :render_notice input-failed
pause
goto menu

:invalid_language
echo [WebUI] Unsupported language: %UI_LANG%
echo Supported: zh, en
exit /b 2

:invalid_arguments
echo [WebUI] Invalid arguments.
echo Usage: "%~nx0" [--lang zh^|en] [start^|status^|restart^|stop]
exit /b 2

:node_installer_missing
call :render_notice node-installer-missing
echo.
pause
exit /b 1

:node_install_failed
call :render_notice node-install-failed
echo.
pause
exit /b 1

:render_menu
if exist "%MENU_RENDERER%" (
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%MENU_RENDERER%" -View menu
    if not errorlevel 1 exit /b 0
)
cls
echo.
echo   DeepFaceLabSN WebUI Manager
echo   ---------------------------
echo   [1] Start
echo   [2] Status
echo   [3] Restart
echo   [4] Stop
echo   [0] Stop and exit
echo.
echo   Select:
exit /b 0

:render_notice
if exist "%MENU_RENDERER%" (
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%MENU_RENDERER%" -View "%~1"
    if not errorlevel 1 exit /b 0
)
echo.
echo [WebUI] %~1
exit /b 0

:find_node
set "NODE_EXE="
call :try_node "%~dp0_internal\node\bin\node.exe"
if defined NODE_EXE exit /b 0
for /f "delims=" %%N in ('where node.exe 2^>nul') do call :try_node "%%N"
if defined NODE_EXE exit /b 0
call :try_node "%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE exit /b 0
call :try_node "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
exit /b 0

:try_node
if defined NODE_EXE exit /b 0
if not exist "%~1" exit /b 0
"%~1" -e "process.exit(process.versions.node === '%NODE_REQUIRED_VERSION%' && process.platform === 'win32' && process.arch === 'x64' ? 0 : 1)" >nul 2>&1
if not errorlevel 1 set "NODE_EXE=%~1"
exit /b 0
