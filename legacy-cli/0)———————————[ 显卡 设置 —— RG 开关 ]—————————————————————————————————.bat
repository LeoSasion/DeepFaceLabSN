@echo off
setlocal
chcp 65001 > nul
cd /d "%~dp0.."
set "CONFIG_FILE=_internal\config.txt"
set "DEFAULT_CONFIG_FILE=_internal\config.default.txt"

if not exist "%CONFIG_FILE%" (
    if not exist "%DEFAULT_CONFIG_FILE%" (
        echo 错误：找不到默认配置 "%DEFAULT_CONFIG_FILE%"
        goto end
    )
    copy /y "%DEFAULT_CONFIG_FILE%" "%CONFIG_FILE%" > nul
    if errorlevel 1 (
        echo 错误：无法创建本地配置 "%CONFIG_FILE%"
        goto end
    )
    echo 已从默认模板创建本地配置。
)

< "%CONFIG_FILE%" (
    set /p var1=
    set /p var2=
)

call :tell
call :choose
call :tell
call :do
goto end

:choose

echo.

echo 请选择显卡选项：

echo 1. DML（通用，支持AMD显卡）

echo 2. CUDA（NVIDIA）

echo.

set /p var1=输入您的选择（1 或 2）: 

echo.

echo 是否开启RG优化（训练变慢，降低显存要求）：

echo 1. 开启RG优化

echo 2. 关闭RG优化

echo.

set /p var2=输入您的选择（1 或 2）: 

echo.
echo.
goto :eof


:tell


if "%var1%" == "1" (
    cd "_internal\python_common\Lib\site-packages\"
    call dml.bat
    echo ------------------------------------------------您已选择 DML
) else if "%var1%" == "2" (
    cd "_internal\python_common\Lib\site-packages\"
    call cuda.bat
    echo ------------------------------------------------您已选择 CUDA
) else (
    echo ------------------------------------------------显卡：无效的选择
    goto end
)

cd /d "%~dp0.."

if "%var2%" == "1" (
    echo ------------------------------------------------已开启RG优化
) else if "%var2%" == "2" (
    echo ------------------------------------------------已关闭RG优化
) else (
    echo ------------------------------------------------RG:无效的选择
    goto end
)

goto :eof

:do

cd /d "%~dp0.."
>"%CONFIG_FILE%" echo %var1: =%
>>"%CONFIG_FILE%" echo %var2: =%
echo 配置已保存；RG 架构将在下次启动时自动选择。
goto :eof

:end
endlocal

pause
