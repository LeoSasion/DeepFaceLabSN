@echo off

chcp 65001 > nul

title ---【Aligned 角度分布】---【作者】---【marsmana1】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

call "%~dp0..\_internal\setenv.bat"

cd /d "%~dp0..\_internal\facesets"
"%PYTHON_EXECUTABLE%" facesets.py

pause