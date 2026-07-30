@echo off

chcp 65001 > nul

title ---【Landmarks 自动识错】---【作者】---【吃果子的果子狸】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

call "%~dp0..\_internal\setenv.bat"
"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\ErrFaceFilter\ErrFaceFilter.py" "1"
pause
