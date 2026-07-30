@echo off

chcp 65001 > nul

title ---【提取 SRC 视频图片帧】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

call "%~dp0..\_internal\setenv.bat"

mkdir "%WORKSPACE%\data_src" 2>nul

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" videoed extract-video ^
    --input-file "%WORKSPACE%\data_src.*" ^
    --output-dir "%WORKSPACE%\data_src"

pause