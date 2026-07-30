@echo off
chcp 65001 > nul
setlocal EnableExtensions EnableDelayedExpansion

set "LEGACY_DIR=%~dp0"
for %%D in ("%LEGACY_DIR%..") do set "ROOT_DIR=%%~fD"
set "WORKSPACE_DIR=%ROOT_DIR%\workspace"
set "PYTHON_EXE=%ROOT_DIR%\_internal\python_common\python.exe"
set "WEBUI_LAUNCHER=%ROOT_DIR%\启动 WebUI.bat"
set "GPU_SCRIPT=%LEGACY_DIR%0)———————————[ 显卡 设置 —— RG 开关 ]—————————————————————————————————.bat"
set "INIT_SCRIPT=%LEGACY_DIR%0)———————————[ 你能看见我，说明你还没【初始化】，点我！ —— Initialize ]———————————————————.bat"
set "KEY_MAP=123456789ABCD"

if /i "%~1"=="--check" goto self_check
if /i "%~1"=="--preview" goto preview
if not "%~1"=="" (
    echo [错误] 未知参数：%~1
    echo 支持参数：--check、--preview
    exit /b 2
)

mode con cols=118 lines=38 > nul 2>&1
color 0A
title DeepFaceLabSN 传统命令控制台

:main
call :render_main
choice /c 12345678RGEWQ /n /m "  请选择功能："
set "MAIN_CHOICE=!errorlevel!"

if "!MAIN_CHOICE!"=="13" goto quit
if "!MAIN_CHOICE!"=="12" (
    call :open_webui
    goto main
)
if "!MAIN_CHOICE!"=="11" (
    call :explorer_compat
    goto main
)
if "!MAIN_CHOICE!"=="10" (
    call :run_fixed_bat "%GPU_SCRIPT%" "显卡与 RG 设置"
    goto main
)
if "!MAIN_CHOICE!"=="9" (
    call :show_recent
    goto main
)
if !MAIN_CHOICE! GEQ 1 if !MAIN_CHOICE! LEQ 8 (
    call :show_category !MAIN_CHOICE!
)
goto main

:render_main
set "PYTHON_STATUS=缺失"
set "WORKSPACE_STATUS=缺失"
if exist "%PYTHON_EXE%" set "PYTHON_STATUS=可用"
if exist "%WORKSPACE_DIR%\" set "WORKSPACE_STATUS=可用"

cls
echo.
echo  ==============================================================================================================
echo    DeepFaceLabSN  /  LEGACY CLI ROUTER
echo  --------------------------------------------------------------------------------------------------------------
echo    项目目录  %ROOT_DIR%
echo    本地环境  Python: %PYTHON_STATUS%    Workspace: %WORKSPACE_STATUS%    命令模式: 白名单路由
echo  ==============================================================================================================
echo.
echo       [1] 视频处理 / Video                    [2] SRC 数据 / Source Faces
echo       [3] DST 数据 / Destination              [4] XSeg 遮罩 / Mask
echo.
echo       [5] 模型训练 / Training                 [6] 模型应用 / Merge and Export
echo       [7] 视频封装 / Encoding                 [8] 其他工具 / Utilities
echo.
echo  --------------------------------------------------------------------------------------------------------------
echo       [R] 最近使用       [G] 显卡与 RG       [E] Explorer 兼容菜单       [W] WebUI 管理器
echo       [Q] 退出
echo  --------------------------------------------------------------------------------------------------------------
echo.
exit /b 0

:show_category
set "CATEGORY=%~1"
call :category_title "%CATEGORY%"
call :load_category "%CATEGORY%"
call :select_and_run "%CATEGORY_TITLE%"
exit /b 0

:category_title
set "CATEGORY_TITLE=未命名分类"
if "%~1"=="1" set "CATEGORY_TITLE=视频处理 / Video"
if "%~1"=="2" set "CATEGORY_TITLE=SRC 数据 / Source Faces"
if "%~1"=="3" set "CATEGORY_TITLE=DST 数据 / Destination"
if "%~1"=="4" set "CATEGORY_TITLE=XSeg 遮罩 / Mask"
if "%~1"=="5" set "CATEGORY_TITLE=模型训练 / Training"
if "%~1"=="6" set "CATEGORY_TITLE=模型应用 / Merge and Export"
if "%~1"=="7" set "CATEGORY_TITLE=视频封装 / Encoding"
if "%~1"=="8" set "CATEGORY_TITLE=其他工具 / Utilities"
exit /b 0

:clear_items
for /l %%I in (1,1,13) do set "ITEM_%%I="
set "ITEM_COUNT=0"
exit /b 0

:load_category
call :clear_items
for /f "delims=" %%F in ('dir /b /a:-d /o:n "%LEGACY_DIR%%~1.*.bat" 2^>nul') do call :add_item "%%F"
if "%~1"=="8" (
    for /f "delims=" %%F in ('dir /b /a:-d /o:n "%LEGACY_DIR%8.*.exe" 2^>nul') do call :add_item "%%F"
)
exit /b 0

:load_recent
call :clear_items
for /f "delims=" %%F in ('dir /b /a:-d /o:-d "%LEGACY_DIR%0-*.bat" 2^>nul') do (
    if !ITEM_COUNT! LSS 13 call :add_item "%%F"
)
exit /b 0

:add_item
if !ITEM_COUNT! GEQ 13 exit /b 0
set /a ITEM_COUNT+=1
set "ITEM_!ITEM_COUNT!=%~1"
exit /b 0

:show_recent
call :load_recent
if !ITEM_COUNT! EQU 0 (
    cls
    echo.
    echo  ==============================================================================================================
    echo    最近使用
    echo  ==============================================================================================================
    echo.
    echo    暂无历史记录。执行传统命令后，它会自动出现在这里。
    echo.
    pause
    exit /b 0
)
call :select_and_run "最近使用 / Recent"
exit /b 0

:select_and_run
set "PAGE_TITLE=%~1"

:select_loop
cls
echo.
echo  ==============================================================================================================
echo    %PAGE_TITLE%
echo  --------------------------------------------------------------------------------------------------------------
echo    选择一个已登记命令。BAT 在当前终端执行，GUI 工具会在独立窗口启动。
echo  ==============================================================================================================
echo.

for /l %%I in (1,1,!ITEM_COUNT!) do (
    set "ITEM_KEY=%%I"
    if %%I==10 set "ITEM_KEY=A"
    if %%I==11 set "ITEM_KEY=B"
    if %%I==12 set "ITEM_KEY=C"
    if %%I==13 set "ITEM_KEY=D"
    for %%F in ("!ITEM_%%I!") do echo      [!ITEM_KEY!] %%~nF
)

echo.
echo  --------------------------------------------------------------------------------------------------------------
echo      [0] 返回主菜单
echo.
choice /c 123456789ABCD0 /n /m "  请选择命令："
set "ITEM_CHOICE=!errorlevel!"

if "!ITEM_CHOICE!"=="14" exit /b 0
if !ITEM_CHOICE! GTR !ITEM_COUNT! (
    echo.
    echo  [提示] 当前页面没有这个序号。
    timeout /t 1 /nobreak > nul
    goto select_loop
)

for %%I in (!ITEM_CHOICE!) do set "TARGET=!ITEM_%%I!"
call :run_target "!TARGET!"
exit /b 0

:run_target
set "TARGET=%~1"
set "TARGET_PATH=%LEGACY_DIR%%TARGET%"

if not exist "%TARGET_PATH%" (
    echo.
    echo  [错误] 命令文件已不存在：%TARGET%
    pause
    exit /b 1
)

cls
echo.
echo  ==============================================================================================================
echo    正在启动
echo  --------------------------------------------------------------------------------------------------------------
echo    %TARGET%
echo  ==============================================================================================================
echo.

if /i "%TARGET:~-4%"==".exe" (
    start "" "%TARGET_PATH%"
    echo  [已启动] 外部工具已在独立窗口打开。
    timeout /t 1 /nobreak > nul
    exit /b 0
)

color 07
call "%TARGET_PATH%"
set "TASK_EXIT=!errorlevel!"
cd /d "%ROOT_DIR%"
color 0A
title DeepFaceLabSN 传统命令控制台

echo.
echo  --------------------------------------------------------------------------------------------------------------
if "!TASK_EXIT!"=="0" (
    echo    命令已结束。
) else (
    echo    命令返回非零状态：!TASK_EXIT!
)
echo  --------------------------------------------------------------------------------------------------------------
pause
exit /b !TASK_EXIT!

:run_fixed_bat
set "FIXED_PATH=%~1"
set "FIXED_TITLE=%~2"
if not exist "%FIXED_PATH%" (
    echo.
    echo  [错误] 未找到：%FIXED_TITLE%
    pause
    exit /b 1
)
call :run_target "%~nx1"
exit /b !errorlevel!

:open_webui
if not exist "%WEBUI_LAUNCHER%" (
    echo.
    echo  [错误] 未找到 WebUI 启动器。
    pause
    exit /b 1
)
color 07
call "%WEBUI_LAUNCHER%"
cd /d "%ROOT_DIR%"
color 0A
title DeepFaceLabSN 传统命令控制台
exit /b 0

:explorer_compat
cls
echo.
echo  ==============================================================================================================
echo    Explorer 兼容菜单
echo  --------------------------------------------------------------------------------------------------------------
echo    旧版隐藏/展开菜单仍被保留，但它不再是推荐入口。
echo  ==============================================================================================================
echo.
echo      [1] 初始化 Explorer 二级菜单显示
echo      [2] 打开 legacy-cli 目录
echo      [B] 返回
echo.
choice /c 12B /n /m "  请选择："
set "EXPLORER_CHOICE=!errorlevel!"

if "!EXPLORER_CHOICE!"=="3" exit /b 0
if "!EXPLORER_CHOICE!"=="2" (
    start "" explorer.exe "%LEGACY_DIR%"
    exit /b 0
)
if "!EXPLORER_CHOICE!"=="1" (
    if exist "%INIT_SCRIPT%" (
        call "%INIT_SCRIPT%"
    ) else (
        echo.
        echo  [错误] 初始化脚本缺失。
        pause
    )
)
exit /b 0

:preview
call :render_main
exit /b 0

:count_category
setlocal EnableDelayedExpansion
set "COUNT=0"
for /f "delims=" %%F in ('dir /b /a:-d "%LEGACY_DIR%%~1.*.bat" 2^>nul') do set /a COUNT+=1
if "%~1"=="8" (
    for /f "delims=" %%F in ('dir /b /a:-d "%LEGACY_DIR%8.*.exe" 2^>nul') do set /a COUNT+=1
)
endlocal & set "CATEGORY_COUNT=%COUNT%"
exit /b 0

:self_check
set "CHECK_FAILED=0"
set "TOTAL_COMMANDS=0"

if not exist "%ROOT_DIR%\_internal\setenv.bat" (
    echo [FAIL] 缺少 _internal\setenv.bat
    set "CHECK_FAILED=1"
)
if not exist "%WORKSPACE_DIR%\" (
    echo [FAIL] 缺少 workspace
    set "CHECK_FAILED=1"
)

for /l %%C in (1,1,8) do (
    call :count_category %%C
    if !CATEGORY_COUNT! LEQ 0 (
        echo [FAIL] 分类 %%C 没有可用命令
        set "CHECK_FAILED=1"
    )
    set /a TOTAL_COMMANDS+=CATEGORY_COUNT
)

if "%CHECK_FAILED%"=="1" exit /b 1
echo [OK] CLI 路由器：8 个分类，%TOTAL_COMMANDS% 个可选命令
exit /b 0

:quit
color 07
endlocal
exit /b 0
