@echo off
setlocal
chcp 65001 > nul

set "PYTHON_EXE=%~dp0..\_internal\python_common\python.exe"

if not exist "%PYTHON_EXE%" (
    echo [FAIL] Bundled Python not found: %PYTHON_EXE%
    exit /b 1
)

"%PYTHON_EXE%" "%~dp0smoke_test.py"
set "SMOKE_EXIT=%ERRORLEVEL%"

endlocal & exit /b %SMOKE_EXIT%
