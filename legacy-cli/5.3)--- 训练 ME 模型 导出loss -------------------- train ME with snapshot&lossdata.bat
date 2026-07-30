@echo off

chcp 65001 > nul

title ---【ME 模型 导出loss】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

call "%~dp0..\_internal\setenv.bat"

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" train ^
    --training-data-src-dir "%WORKSPACE%\data_src\aligned" ^
    --training-data-dst-dir "%WORKSPACE%\data_dst\aligned" ^
    --pretraining-data-dir "%WORKSPACE%\pretrain_faces" ^
    --model-dir "%WORKSPACE%\model" ^
    --model ME --reduce-clutter --gen-snapshot
echo 文件已导出到\workspace\model\模型名_SAEHD_state_history\日期\dst_state.json和src_state.json
pause