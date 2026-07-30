@echo off
chcp 65001 > nul
setlocal EnableExtensions

set "LEGACY_DIR=%~dp0legacy-cli"
set "MENU_SCRIPT=%LEGACY_DIR%\menu.bat"

if not exist "%MENU_SCRIPT%" (
    echo [错误] 未找到传统 CLI 路由器：
    echo %MENU_SCRIPT%
    echo.
    pause
    exit /b 1
)

if /i "%DFL_LEGACY_MENU_DRY_RUN%"=="1" (
    echo [OK] 传统 CLI 路由器可用：%MENU_SCRIPT%
    exit /b 0
)

call "%MENU_SCRIPT%" %*
exit /b %errorlevel%
