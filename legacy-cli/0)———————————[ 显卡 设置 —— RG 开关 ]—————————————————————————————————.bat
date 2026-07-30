@echo off
setlocal
chcp 65001 > nul
rem 检查配置文件是否存在
cd /d "%~dp0.."
if exist _internal\config.txt (
    rem 如果存在配置文件，则读取配置文件中的选择
    < _internal\config.txt (
        set /p var1=
        set /p var2=
    )

    call :tell
    call :choose
    call :tell
    call :do

) else (
    echo 首次写入配置

    call :choose
    call :tell
    call :do
)
goto end

:choose

echo.

echo 请选择显卡选项：

echo 1. DML（通用，支持AMD显卡）

echo 2. CUDA（NVIDIA）

echo.

set /p var1=输入您的选择（1 或 2）: 

echo.

echo 是否开启RG优化（训练变慢，降低显存要求）：

echo 1. 开启RG优化

echo 2. 关闭RG优化

echo.

set /p var2=输入您的选择（1 或 2）: 

echo.
echo.
goto :eof


:tell


if %var1% == 1 (
    cd "_internal\python_common\Lib\site-packages\"
    call dml.bat
    echo ------------------------------------------------您已选择 DML
) else if %var1% == 2 (
    cd "_internal\python_common\Lib\site-packages\"
    call cuda.bat
    echo ------------------------------------------------您已选择 CUDA
) else (
    echo ------------------------------------------------显卡：无效的选择
    goto end
)

cd /d "%~dp0.."

if %var2% == 1 (
    set source2=_internal\DeepFaceLab\core\leras\archis\DeepFakeArchi_rg.py
    echo ------------------------------------------------已开启RG优化
) else if %var2% == 2 (
    set source2=_internal\DeepFaceLab\core\leras\archis\DeepFakeArchi_old.py
    echo ------------------------------------------------已关闭RG优化
) else (
    echo ------------------------------------------------RG:无效的选择
    goto end
)

goto :eof

:do

cd /d "%~dp0.."

set destination2=_internal\DeepFaceLab\core\leras\archis\DeepFakeArchi.py

if exist %destination2% (
    del %destination2%
)

copy %source2% %destination2% > nul
echo RG文件替换完成！

echo.

rem 将用户选择保存到配置文件
cd /d "%~dp0.."
echo %var1: =% >_internal\config.txt

echo %var2: =% >>_internal\config.txt
goto :eof

:end
endlocal

pause
