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
set "MENU_ACTION="

:parse_arguments
if "%~1"=="" goto arguments_done
if /i "%~1"=="--lang" (
    if "%~2"=="" goto invalid_arguments
    if /i not "%~2"=="zh" if /i not "%~2"=="en" goto invalid_arguments
    shift
    shift
    goto parse_arguments
)
if /i "%~1"=="zh" (
    shift
    goto parse_arguments
)
if /i "%~1"=="en" (
    shift
    goto parse_arguments
)
if /i "%~1"=="--check" (
    if defined MENU_ACTION goto invalid_arguments
    set "MENU_ACTION=check"
    shift
    goto parse_arguments
)
if /i "%~1"=="--preview" (
    if defined MENU_ACTION goto invalid_arguments
    set "MENU_ACTION=preview"
    shift
    goto parse_arguments
)
goto invalid_arguments

:arguments_done
:initialize
call :initialize_copy
call :initialize_theme

if /i "!MENU_ACTION!"=="check" goto self_check
if /i "!MENU_ACTION!"=="preview" goto preview

mode con cols=118 lines=38 > nul 2>&1
if defined ESC (
    color 07
) else (
    color 0A
)
title !TXT_CONSOLE_TITLE!

:main
call :render_main
choice /c 12345678RGEWQ /n /m "  请选择功能 / Select an option  > "
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
    call :run_fixed_bat "%GPU_SCRIPT%" "!TXT_GPU_SETTINGS_ZH!" "!TXT_GPU_SETTINGS_EN!"
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

:initialize_copy
set "TXT_CONSOLE_TITLE=DeepFaceLabSN 传统命令控制台 / Legacy Command Console"
set "TXT_MISSING_ZH=缺失"
set "TXT_MISSING_EN=Missing"
set "TXT_AVAILABLE_ZH=就绪"
set "TXT_AVAILABLE_EN=Ready"
set "TXT_WORKFLOW_ZH=核心流程"
set "TXT_WORKFLOW_EN=CORE WORKFLOW"
set "TXT_TOOLS_ZH=快捷工具"
set "TXT_TOOLS_EN=QUICK TOOLS"
set "TXT_CAT1_ZH=视频处理"
set "TXT_CAT1_EN=Video processing"
set "TXT_CAT2_ZH=SRC 数据"
set "TXT_CAT2_EN=Source faces"
set "TXT_CAT3_ZH=DST 数据"
set "TXT_CAT3_EN=Destination footage"
set "TXT_CAT4_ZH=XSeg 遮罩"
set "TXT_CAT4_EN=XSeg masks"
set "TXT_CAT5_ZH=模型训练"
set "TXT_CAT5_EN=Model training"
set "TXT_CAT6_ZH=模型应用"
set "TXT_CAT6_EN=Merge and export"
set "TXT_CAT7_ZH=视频封装"
set "TXT_CAT7_EN=Video encoding"
set "TXT_CAT8_ZH=其他工具"
set "TXT_CAT8_EN=Utilities"
set "TXT_UNNAMED_ZH=未命名分类"
set "TXT_UNNAMED_EN=Unnamed category"
set "TXT_RECENT_ZH=最近使用"
set "TXT_RECENT_EN=Recent commands"
set "TXT_GPU_SETTINGS_ZH=显卡与 RG 设置"
set "TXT_GPU_SETTINGS_EN=GPU and RG settings"
set "TXT_EXPLORER_ZH=Explorer 兼容菜单"
set "TXT_EXPLORER_EN=Explorer compatibility"
set "TXT_WEBUI_ZH=WebUI 管理器"
set "TXT_WEBUI_EN=WebUI manager"
set "TXT_QUIT_ZH=退出"
set "TXT_QUIT_EN=Quit"
set "TXT_SELECT_FUNCTION_ZH=请选择功能"
set "TXT_SELECT_FUNCTION_EN=Select an option"
set "TXT_NO_HISTORY_ZH=暂无历史记录。执行传统命令后，它会自动出现在这里。"
set "TXT_NO_HISTORY_EN=No command history yet. Commands you run will appear here automatically."
set "TXT_SELECT_COMMAND_INFO_ZH=选择已登记的命令。BAT 在当前终端执行，GUI 工具会在独立窗口启动。"
set "TXT_SELECT_COMMAND_INFO_EN=Choose a registered command. BAT runs here; GUI tools open separately."
set "TXT_BACK_ZH=返回主菜单"
set "TXT_BACK_EN=Back to main menu"
set "TXT_SELECT_COMMAND_ZH=请选择命令"
set "TXT_SELECT_COMMAND_EN=Select a command"
set "TXT_NUMBER_MISSING_ZH=当前页面没有这个序号。"
set "TXT_NUMBER_MISSING_EN=That key is not available on this page."
set "TXT_FILE_MISSING_ZH=命令文件已不存在："
set "TXT_FILE_MISSING_EN=Command file no longer exists:"
set "TXT_STARTING_ZH=正在启动"
set "TXT_STARTING_EN=STARTING"
set "TXT_EXTERNAL_STARTED_ZH=外部工具已在独立窗口打开。"
set "TXT_EXTERNAL_STARTED_EN=External tool opened in a separate window."
set "TXT_COMMAND_FINISHED_ZH=命令已结束。"
set "TXT_COMMAND_FINISHED_EN=Command finished."
set "TXT_NONZERO_ZH=命令返回非零状态："
set "TXT_NONZERO_EN=Command returned a non-zero status:"
set "TXT_NOT_FOUND_ZH=未找到："
set "TXT_NOT_FOUND_EN=Not found:"
set "TXT_WEBUI_MISSING_ZH=未找到 WebUI 启动器。"
set "TXT_WEBUI_MISSING_EN=WebUI launcher was not found."
set "TXT_EXPLORER_INFO_ZH=旧版隐藏/展开菜单仍被保留，但它不再是推荐入口。"
set "TXT_EXPLORER_INFO_EN=The legacy hide/expand menu remains available as a compatibility tool."
set "TXT_EXPLORER_INIT_ZH=初始化 Explorer 二级菜单显示"
set "TXT_EXPLORER_INIT_EN=Initialize the Explorer submenu"
set "TXT_EXPLORER_OPEN_ZH=打开 legacy-cli 目录"
set "TXT_EXPLORER_OPEN_EN=Open the legacy-cli folder"
set "TXT_SELECT_ZH=请选择"
set "TXT_SELECT_EN=Select"
set "TXT_INIT_MISSING_ZH=初始化脚本缺失。"
set "TXT_INIT_MISSING_EN=Initialization script is missing."
set "TXT_WAIT_ZH=按任意键继续"
set "TXT_WAIT_EN=Press any key to continue"
exit /b 0

:initialize_theme
set "ESC="
set "C_RESET="
set "C_BORDER="
set "C_BRAND="
set "C_ZH="
set "C_EN="
set "C_SEP="
set "C_TEXT="
set "C_MUTED="
set "C_KEY="
set "C_OK="
set "C_ERROR="
set "COL_TRANSLATION="
set "COL_ITEM_EN="

if /i "%NO_COLOR%"=="1" exit /b 0
if /i "%DFL_CLI_NO_COLOR%"=="1" exit /b 0
ver | find "10." > nul
if errorlevel 1 exit /b 0

for /F "delims=#" %%E in ('"prompt #$E# & for %%B in (1) do rem"') do set "ESC=%%E"
if not defined ESC exit /b 0

set "C_RESET=!ESC![0m"
set "C_BORDER=!ESC![90m"
set "C_BRAND=!ESC![96m"
set "C_ZH=!ESC![92m"
set "C_EN=!ESC![95m"
set "C_SEP=!ESC![90m"
set "C_TEXT=!ESC![97m"
set "C_MUTED=!ESC![37m"
set "C_KEY=!ESC![93m"
set "C_OK=!ESC![92m"
set "C_ERROR=!ESC![91m"
set "COL_TRANSLATION=!ESC![38G"
set "COL_ITEM_EN=!ESC![56G"
exit /b 0

:render_main
set "PYTHON_STATUS_ZH=!TXT_MISSING_ZH!"
set "PYTHON_STATUS_EN=!TXT_MISSING_EN!"
set "WORKSPACE_STATUS_ZH=!TXT_MISSING_ZH!"
set "WORKSPACE_STATUS_EN=!TXT_MISSING_EN!"
set "PYTHON_COLOR=!C_ERROR!"
set "WORKSPACE_COLOR=!C_ERROR!"
if exist "%PYTHON_EXE%" (
    set "PYTHON_STATUS_ZH=!TXT_AVAILABLE_ZH!"
    set "PYTHON_STATUS_EN=!TXT_AVAILABLE_EN!"
    set "PYTHON_COLOR=!C_OK!"
)
if exist "%WORKSPACE_DIR%\" (
    set "WORKSPACE_STATUS_ZH=!TXT_AVAILABLE_ZH!"
    set "WORKSPACE_STATUS_EN=!TXT_AVAILABLE_EN!"
    set "WORKSPACE_COLOR=!C_OK!"
)

cls
echo.
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo(!C_BRAND!    DeepFaceLabSN!C_SEP!  ::  !C_ZH!传统命令控制台!C_SEP! / !C_EN!Legacy Command Console!C_RESET!
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
echo(!C_ZH!    项目  !C_EN!PROJECT!C_MUTED!      %ROOT_DIR%!C_RESET!
echo(!C_ZH!    环境  !C_EN!RUNTIME!C_MUTED!      Python !PYTHON_COLOR![!PYTHON_STATUS_ZH! / !PYTHON_STATUS_EN!]!C_MUTED!   Workspace !WORKSPACE_COLOR![!WORKSPACE_STATUS_ZH! / !WORKSPACE_STATUS_EN!]!C_RESET!
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo.
echo(!C_ZH!    !TXT_WORKFLOW_ZH!!C_SEP! / !C_EN!!TXT_WORKFLOW_EN!!C_RESET!
echo.
call :render_option "1" "!TXT_CAT1_ZH!" "!TXT_CAT1_EN!"
call :render_option "2" "!TXT_CAT2_ZH!" "!TXT_CAT2_EN!"
call :render_option "3" "!TXT_CAT3_ZH!" "!TXT_CAT3_EN!"
call :render_option "4" "!TXT_CAT4_ZH!" "!TXT_CAT4_EN!"
call :render_option "5" "!TXT_CAT5_ZH!" "!TXT_CAT5_EN!"
call :render_option "6" "!TXT_CAT6_ZH!" "!TXT_CAT6_EN!"
call :render_option "7" "!TXT_CAT7_ZH!" "!TXT_CAT7_EN!"
call :render_option "8" "!TXT_CAT8_ZH!" "!TXT_CAT8_EN!"
echo.
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
echo.
echo(!C_ZH!    !TXT_TOOLS_ZH!!C_SEP! / !C_EN!!TXT_TOOLS_EN!!C_RESET!
echo.
call :render_option "R" "!TXT_RECENT_ZH!" "!TXT_RECENT_EN!"
call :render_option "G" "!TXT_GPU_SETTINGS_ZH!" "!TXT_GPU_SETTINGS_EN!"
call :render_option "E" "!TXT_EXPLORER_ZH!" "!TXT_EXPLORER_EN!"
call :render_option "W" "!TXT_WEBUI_ZH!" "!TXT_WEBUI_EN!"
call :render_option "Q" "!TXT_QUIT_ZH!" "!TXT_QUIT_EN!"
echo.
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
echo.
exit /b 0

:render_option
if defined ESC (
    echo(      !C_KEY![%~1]!C_RESET!  !C_ZH!%~2!COL_TRANSLATION!!C_SEP!/  !C_EN!%~3!C_RESET!
) else (
    echo      [%~1]  %~2  /  %~3
)
exit /b 0

:show_category
set "CATEGORY=%~1"
call :category_title "%CATEGORY%"
call :load_category "%CATEGORY%"
call :select_and_run "!CATEGORY_TITLE_ZH!" "!CATEGORY_TITLE_EN!"
exit /b 0

:category_title
set "CATEGORY_TITLE_ZH=!TXT_UNNAMED_ZH!"
set "CATEGORY_TITLE_EN=!TXT_UNNAMED_EN!"
if "%~1"=="1" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT1_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT1_EN!"
)
if "%~1"=="2" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT2_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT2_EN!"
)
if "%~1"=="3" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT3_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT3_EN!"
)
if "%~1"=="4" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT4_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT4_EN!"
)
if "%~1"=="5" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT5_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT5_EN!"
)
if "%~1"=="6" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT6_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT6_EN!"
)
if "%~1"=="7" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT7_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT7_EN!"
)
if "%~1"=="8" (
    set "CATEGORY_TITLE_ZH=!TXT_CAT8_ZH!"
    set "CATEGORY_TITLE_EN=!TXT_CAT8_EN!"
)
exit /b 0

:clear_items
for /l %%I in (1,1,13) do (
    set "ITEM_%%I="
    set "ITEM_ZH_%%I="
    set "ITEM_EN_%%I="
)
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
set "RAW_ITEM_LABEL=%~n1"
call :format_item_label
set "ITEM_ZH_!ITEM_COUNT!=!FORMATTED_ZH!"
set "ITEM_EN_!ITEM_COUNT!=!FORMATTED_EN!"
exit /b 0

:format_item_label
set "DISPLAY_LABEL=!RAW_ITEM_LABEL!"
for /f "tokens=1,* delims=)" %%A in ("!DISPLAY_LABEL!") do set "DISPLAY_LABEL=%%B"
if not defined DISPLAY_LABEL set "DISPLAY_LABEL=!RAW_ITEM_LABEL!"
for /f "tokens=* delims= " %%A in ("!DISPLAY_LABEL!") do set "DISPLAY_LABEL=%%A"
if "!DISPLAY_LABEL:~0,4!"=="--- " set "DISPLAY_LABEL=!DISPLAY_LABEL:~4!"
if "!DISPLAY_LABEL:~0,3!"=="---" set "DISPLAY_LABEL=!DISPLAY_LABEL:~3!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:----------=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:||=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:||=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|---------=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|--------=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|-------=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|------=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|-----=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|----=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|---=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|--=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|-=|!"
set "DISPLAY_LABEL=!DISPLAY_LABEL:|= / !"

set "FORMATTED_ZH="
set "FORMATTED_EN="
for /f "tokens=1,* delims=/" %%A in ("!DISPLAY_LABEL!") do (
    set "FORMATTED_ZH=%%A"
    set "FORMATTED_EN=%%B"
)
if defined FORMATTED_ZH if "!FORMATTED_ZH:~-1!"==" " set "FORMATTED_ZH=!FORMATTED_ZH:~0,-1!"
if defined FORMATTED_ZH if "!FORMATTED_ZH:~-1!"==" " set "FORMATTED_ZH=!FORMATTED_ZH:~0,-1!"
if defined FORMATTED_EN for /f "tokens=* delims= " %%A in ("!FORMATTED_EN!") do set "FORMATTED_EN=%%A"
if not defined FORMATTED_EN set "FORMATTED_EN=!FORMATTED_ZH!"
exit /b 0

:show_recent
call :load_recent
if !ITEM_COUNT! EQU 0 (
    cls
    echo.
    echo(!C_BORDER!  ==============================================================================================================!C_RESET!
    echo(!C_ZH!    !TXT_RECENT_ZH!!C_SEP! / !C_EN!!TXT_RECENT_EN!!C_RESET!
    echo(!C_BORDER!  ==============================================================================================================!C_RESET!
    echo.
    echo(!C_ZH!    !TXT_NO_HISTORY_ZH!!C_RESET!
    echo(!C_EN!    !TXT_NO_HISTORY_EN!!C_RESET!
    echo.
    call :pause_bilingual
    exit /b 0
)
call :select_and_run "!TXT_RECENT_ZH!" "!TXT_RECENT_EN!"
exit /b 0

:select_and_run
set "PAGE_TITLE_ZH=%~1"
set "PAGE_TITLE_EN=%~2"

:select_loop
cls
echo.
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo(!C_ZH!    !PAGE_TITLE_ZH!!C_SEP! / !C_EN!!PAGE_TITLE_EN!!C_RESET!
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
echo(!C_ZH!    !TXT_SELECT_COMMAND_INFO_ZH!!C_RESET!
echo(!C_EN!    !TXT_SELECT_COMMAND_INFO_EN!!C_RESET!
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo.

for /l %%I in (1,1,!ITEM_COUNT!) do (
    set "ITEM_KEY=%%I"
    if %%I==10 set "ITEM_KEY=A"
    if %%I==11 set "ITEM_KEY=B"
    if %%I==12 set "ITEM_KEY=C"
    if %%I==13 set "ITEM_KEY=D"
    call :render_item "!ITEM_KEY!" "!ITEM_ZH_%%I!" "!ITEM_EN_%%I!"
)

echo.
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
call :render_option "0" "!TXT_BACK_ZH!" "!TXT_BACK_EN!"
echo.
choice /c 123456789ABCD0 /n /m "  请选择命令 / Select a command  > "
set "ITEM_CHOICE=!errorlevel!"

if "!ITEM_CHOICE!"=="14" exit /b 0
if !ITEM_CHOICE! GTR !ITEM_COUNT! (
    echo.
    echo(!C_KEY!  [!] !C_ZH!!TXT_NUMBER_MISSING_ZH!!C_SEP! / !C_EN!!TXT_NUMBER_MISSING_EN!!C_RESET!
    timeout /t 1 /nobreak > nul
    goto select_loop
)

for %%I in (!ITEM_CHOICE!) do set "TARGET=!ITEM_%%I!"
call :run_target "!TARGET!"
exit /b 0

:render_item
set "RENDER_KEY=%~1"
set "RENDER_ZH=%~2"
set "RENDER_EN=%~3"
if defined ESC (
    echo(     !C_KEY![!RENDER_KEY!]!C_RESET!  !C_ZH!!RENDER_ZH!!COL_ITEM_EN!!C_SEP!/  !C_EN!!RENDER_EN!!C_RESET!
) else (
    echo     [!RENDER_KEY!]  !RENDER_ZH!  /  !RENDER_EN!
)
exit /b 0

:run_target
set "TARGET=%~1"
set "TARGET_PATH=%LEGACY_DIR%%TARGET%"

if not exist "%TARGET_PATH%" (
    echo.
    echo(!C_ERROR!  [ERROR] !C_ZH!!TXT_FILE_MISSING_ZH!!C_SEP! / !C_EN!!TXT_FILE_MISSING_EN!!C_RESET!
    echo(!C_MUTED!          !TARGET!!C_RESET!
    call :pause_bilingual
    exit /b 1
)

cls
echo.
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo(!C_ZH!    !TXT_STARTING_ZH!!C_SEP! / !C_EN!!TXT_STARTING_EN!!C_RESET!
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
echo(!C_TEXT!    !TARGET!!C_RESET!
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo.

if /i "!TARGET:~-4!"==".exe" (
    start "" "!TARGET_PATH!"
    echo(!C_OK!  [OK] !C_ZH!!TXT_EXTERNAL_STARTED_ZH!!C_SEP! / !C_EN!!TXT_EXTERNAL_STARTED_EN!!C_RESET!
    timeout /t 1 /nobreak > nul
    exit /b 0
)

echo(!C_RESET!
color 07
call "%TARGET_PATH%"
set "TASK_EXIT=!errorlevel!"
cd /d "%ROOT_DIR%"
if defined ESC (
    color 07
) else (
    color 0A
)
title !TXT_CONSOLE_TITLE!

echo.
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
if "!TASK_EXIT!"=="0" (
    echo(!C_OK!    [OK] !C_ZH!!TXT_COMMAND_FINISHED_ZH!!C_SEP! / !C_EN!!TXT_COMMAND_FINISHED_EN!!C_RESET!
) else (
    echo(!C_ERROR!    [ERROR] !C_ZH!!TXT_NONZERO_ZH! !TASK_EXIT!!C_SEP! / !C_EN!!TXT_NONZERO_EN! !TASK_EXIT!!C_RESET!
)
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
call :pause_bilingual
exit /b !TASK_EXIT!

:run_fixed_bat
set "FIXED_PATH=%~1"
set "FIXED_TITLE_ZH=%~2"
set "FIXED_TITLE_EN=%~3"
if not exist "!FIXED_PATH!" (
    echo.
    echo(!C_ERROR!  [ERROR] !C_ZH!!TXT_NOT_FOUND_ZH! !FIXED_TITLE_ZH!!C_SEP! / !C_EN!!TXT_NOT_FOUND_EN! !FIXED_TITLE_EN!!C_RESET!
    call :pause_bilingual
    exit /b 1
)
call :run_target "%~nx1"
exit /b !errorlevel!

:open_webui
if not exist "%WEBUI_LAUNCHER%" (
    echo.
    echo(!C_ERROR!  [ERROR] !C_ZH!!TXT_WEBUI_MISSING_ZH!!C_SEP! / !C_EN!!TXT_WEBUI_MISSING_EN!!C_RESET!
    call :pause_bilingual
    exit /b 1
)
echo(!C_RESET!
color 07
call "%WEBUI_LAUNCHER%"
cd /d "%ROOT_DIR%"
if defined ESC (
    color 07
) else (
    color 0A
)
title !TXT_CONSOLE_TITLE!
exit /b 0

:explorer_compat
cls
echo.
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo(!C_ZH!    !TXT_EXPLORER_ZH!!C_SEP! / !C_EN!!TXT_EXPLORER_EN!!C_RESET!
echo(!C_BORDER!  --------------------------------------------------------------------------------------------------------------!C_RESET!
echo(!C_ZH!    !TXT_EXPLORER_INFO_ZH!!C_RESET!
echo(!C_EN!    !TXT_EXPLORER_INFO_EN!!C_RESET!
echo(!C_BORDER!  ==============================================================================================================!C_RESET!
echo.
call :render_option "1" "!TXT_EXPLORER_INIT_ZH!" "!TXT_EXPLORER_INIT_EN!"
call :render_option "2" "!TXT_EXPLORER_OPEN_ZH!" "!TXT_EXPLORER_OPEN_EN!"
call :render_option "B" "!TXT_BACK_ZH!" "!TXT_BACK_EN!"
echo.
choice /c 12B /n /m "  请选择 / Select  > "
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
        echo(!C_ERROR!  [ERROR] !C_ZH!!TXT_INIT_MISSING_ZH!!C_SEP! / !C_EN!!TXT_INIT_MISSING_EN!!C_RESET!
        call :pause_bilingual
    )
)
exit /b 0

:preview
call :render_main
exit /b 0

:pause_bilingual
echo.
echo(!C_KEY!  [~] !C_ZH!!TXT_WAIT_ZH!!C_SEP! / !C_EN!!TXT_WAIT_EN!!C_RESET!
pause > nul
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
    echo [FAIL] 缺少 _internal\setenv.bat / Missing _internal\setenv.bat
    set "CHECK_FAILED=1"
)
if not exist "%WORKSPACE_DIR%\" (
    echo [FAIL] 缺少 workspace / Missing workspace
    set "CHECK_FAILED=1"
)

for /l %%C in (1,1,8) do (
    call :count_category %%C
    if !CATEGORY_COUNT! LEQ 0 (
        echo [FAIL] 分类 / Category %%C 没有可用命令 / has no available commands
        set "CHECK_FAILED=1"
    )
    set /a TOTAL_COMMANDS+=CATEGORY_COUNT
)

if "!CHECK_FAILED!"=="1" exit /b 1
echo [OK] CLI 路由器：8 个分类，!TOTAL_COMMANDS! 个可选命令 / CLI router: 8 categories, !TOTAL_COMMANDS! selectable commands
exit /b 0

:invalid_arguments
echo [CLI] 参数无效 / Invalid arguments.
echo 用法 / Usage: "%~nx0" [--check^|--preview]
exit /b 2

:quit
echo(!C_RESET!
color 07
endlocal
exit /b 0
