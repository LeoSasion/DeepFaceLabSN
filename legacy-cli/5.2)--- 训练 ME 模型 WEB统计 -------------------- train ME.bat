@echo off

chcp 65001 > nul

title ---【训练 ME 模型 开启WEB面板】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

echo 请注意！dfl原版模型可以升级到mve版训练，但是很难退回去。注意备份！

echo 或者选择 5.4)--- 训练 SAEHD 原版模型 -- train SAEHDLegacy

echo.

echo 使用说明：这里生成和读取的yaml文件是取自model文件夹的模型命名！

echo 例如：workspace\model\new_ME_configuration_file.yaml

call "%~dp0..\_internal\setenv.bat"

"%PYTHON_EXECUTABLE%" "%DFL_ROOT%\main.py" train ^
    --training-data-src-dir "%WORKSPACE%\data_src\aligned" ^
    --training-data-dst-dir "%WORKSPACE%\data_dst\aligned" ^
    --pretraining-data-dir "%WORKSPACE%\pretrain_faces" ^
    --model-dir "%WORKSPACE%\model" ^
    --model ME ^
    --tensorboard-logdir "%WORKSPACE%\TFLog" ^
    --start-tensorboard ^
    --no-preview ^
    --auto-gen-config

pause