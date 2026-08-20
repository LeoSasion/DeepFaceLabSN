@echo off
setlocal
chcp 65001 > nul

set "XSEG_DIR=%~dp0..\workspace\xseg_model"
if not "%~1"=="" set "XSEG_DIR=%~1"

if not exist "%XSEG_DIR%\" (
    echo 找不到 XSeg 模型目录："%XSEG_DIR%"
    exit /b 1
)

call :rename_one "XSeg_256.npy" "default_XSeg_256.npy"
if errorlevel 1 exit /b 1
call :rename_one "XSeg_256_opt.npy" "default_XSeg_256_opt.npy"
if errorlevel 1 exit /b 1
call :rename_one "XSeg_data.dat" "default_XSeg_data.dat"
if errorlevel 1 exit /b 1

echo XSeg 模型文件名迁移完成。
exit /b 0

:rename_one
if not exist "%XSEG_DIR%\%~1" exit /b 0
if exist "%XSEG_DIR%\%~2" (
    echo 已存在目标文件，为避免覆盖已停止："%XSEG_DIR%\%~2"
    exit /b 1
)
ren "%XSEG_DIR%\%~1" "%~2"
if errorlevel 1 (
    echo 无法重命："%XSEG_DIR%\%~1"
    exit /b 1
)
exit /b 0
