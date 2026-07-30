@echo off

chcp 65001 > nul

title ---【SRC-aligned 高清修复】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

call "%~dp0..\_internal\setenv.bat"

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" facesettool enhance  ^
    --input-dir "%WORKSPACE%\data_src\aligned"

pause