@echo off

chcp 65001 > nul

title ---【提取 SRC 视频图片帧】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo 图片浏览器的启动比较慢，请等待1分钟

call "%~dp0..\_internal\setenv.bat"

start "" /D "%XNVIEWMP_PATH%" /LOW "%XNVIEWMP_PATH%\xnviewmp.exe" "%WORKSPACE%\data_dst\aligned"