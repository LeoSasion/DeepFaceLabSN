@echo off

chcp 65001 > nul

title ---【DST-aligned 检查错误】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

echo 本程序是向data_dst\aligned文件夹添加landmarks-debug图片文件供手动检查

echo.

echo 如果需要自动检查，请使用 8.1)--- Landmarks自动识错 ------------------------ Landmarks auto check

call "%~dp0..\_internal\setenv.bat"

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" util ^
    --input-dir "%WORKSPACE%\data_dst\aligned" ^
    --add-landmarks-debug-images

pause