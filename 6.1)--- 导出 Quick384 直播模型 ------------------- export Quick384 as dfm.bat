@echo off

chcp 65001 > nul

title ---【导出 Quick384 直播模型】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~nx0" "0-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

call _internal\setenv.bat

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" exportdfm ^
    --model-dir "%WORKSPACE%\model" ^
    --model Q384

pause