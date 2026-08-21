rem ========== 基础环境变量 ==========
SET INTERNAL=%~dp0
SET INTERNAL=%INTERNAL:~0,-1%
rem 覆盖Windows用户/本地环境变量
SET LOCALENV_DIR=%INTERNAL%\_e
SET TMP=%LOCALENV_DIR%\t
SET TEMP=%LOCALENV_DIR%\t
SET HOME=%LOCALENV_DIR%\u
SET HOMEPATH=%LOCALENV_DIR%\u
SET USERPROFILE=%LOCALENV_DIR%\u
SET LOCALAPPDATA=%USERPROFILE%\AppData\Local
SET APPDATA=%USERPROFILE%\AppData\Roaming

rem ========== PYTHON环境变量 ==========
SET PYTHON_PATH=%INTERNAL%\python_common
rem 重写默认的Python环境变量，以避免干扰系统安装的Python
SET PYTHONHOME=
SET PYTHONPATH=
SET PYTHONEXECUTABLE=%PYTHON_PATH%\python.exe
SET PYTHONWEXECUTABLE=%PYTHON_PATH%\pythonw.exe
SET PYTHON_EXECUTABLE=%PYTHON_PATH%\python.exe
SET PYTHONW_EXECUTABLE=%PYTHON_PATH%\pythonw.exe
SET PYTHON_BIN_PATH=%PYTHON_EXECUTABLE%
SET PYTHON_LIB_PATH=%PYTHON_PATH%\Lib\site-packages
SET QT_QPA_PLATFORM_PLUGIN_PATH=%PYTHON_LIB_PATH%\PyQt5\Qt\plugins
SET PATH=%PYTHON_PATH%;%PYTHON_PATH%\Scripts;%PATH%

rem ========== Node.js环境变量 ==========
rem 依赖安装脚本（例如 node-pty、esbuild）会按命令名再次调用 node。
SET NODE_BIN_PATH=%INTERNAL%\node\bin
SET PATH=%NODE_BIN_PATH%;%PATH%
rem ========== CUDA环境变量 ==========
SET PATH=%INTERNAL%\CUDA;%INTERNAL%\CUDNN;%PATH%
for /f "tokens=4-7 delims=[.] " %%i in ('ver') do (if %%i==Version (set v=%%j.%%k) else (set v=%%i.%%j))
if "%v%" == "10.0" (
    SET "PATH=%INTERNAL%\CUDNN\Win10.0;%PATH%"
) else (
    SET "PATH=%INTERNAL%\CUDNN\Win6.x;%PATH%"
)

rem ========== 其他环境变量 ==========
SET XNVIEWMP_PATH=%INTERNAL%\XnViewMP
SET FFMPEG_PATH=%INTERNAL%\ffmpeg
SET PATH=%XNVIEWMP_PATH%;%FFMPEG_PATH%;%PATH%
SET WORKSPACE=%INTERNAL%\..\workspace
SET DFL_ROOT=%INTERNAL%\DeepFaceLab
