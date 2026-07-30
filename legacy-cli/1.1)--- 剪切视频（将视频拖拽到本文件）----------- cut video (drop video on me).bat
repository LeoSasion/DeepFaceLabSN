@echo off

cd /d "%~dp0.."
call "%~dp0..\_internal\setenv.bat"

set "INPUT_VIDEO=%~1"
if not defined INPUT_VIDEO (
    echo.
    set /p "INPUT_VIDEO=请输入需要剪切的视频完整路径："
)

if not exist "%INPUT_VIDEO%" (
    echo 未找到视频文件：%INPUT_VIDEO%
    pause
    exit /b 1
)

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" videoed cut-video ^
       --input-file "%INPUT_VIDEO%"

pause
