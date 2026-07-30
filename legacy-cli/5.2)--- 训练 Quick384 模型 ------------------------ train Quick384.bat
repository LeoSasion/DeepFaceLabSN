@echo off

chcp 65001 > nul

title ---【训练 Quick384 原版模型】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

echo 温馨提示：本模型需要8G显存！

echo 显存大于8G 请关闭RG优化

echo.

call "%~dp0..\_internal\setenv.bat"

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" train ^
    --training-data-src-dir "%WORKSPACE%\data_src\aligned" ^
    --training-data-dst-dir "%WORKSPACE%\data_dst\aligned" ^
    --pretraining-data-dir "%WORKSPACE%\pretrain_faces" ^
    --pretrained-model-dir "%INTERNAL%\pretrain_Quick384" ^
    --model-dir "%WORKSPACE%\model" ^
    --model Q384 ^
    --flask-preview

:end
echo 如果有问题请在 QQ群:747439134 反馈
pause