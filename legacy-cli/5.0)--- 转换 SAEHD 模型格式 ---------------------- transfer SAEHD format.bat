@echo off
chcp 65001 > nul
title ---【转换 SAEHD 模型格式】---【神农汉化】---【QQ交流群 747439134】

set "filename=%~nx0"

if not "%filename:~0,2%"=="0-" (
    copy "%~f0" "%~dp00-%~nx0" > nul
    echo [最近使用] 已写入，如果需要清空历史请手动删除！
)

echo.

echo 请选择要从SAEHD转为ME格式的模型序号！注意是单向转换，请自行备份！
echo 如果想从ME转为SAEHD，建议先在ME把学习率降到2e-05，开启超级扭曲，迭代5000次。然后再自行修改文件名到SAEHD！

setlocal enabledelayedexpansion

set "workspace=%~dp0..\workspace\model"
set "pattern=*_SAEHD_data.dat"

REM 遍历目录，找到符合条件的文件并保存到数组

REM 设置一个变量count，并初始化为0
set /a count=0

REM 遍历指定目录中符合指定模式的文件
for %%F in ("%workspace%\*_SAEHD_data.dat") do (
    
    REM 获取文件名部分，并将其中的"_SAEHD_data"字符串替换为空
    set "file=%%~nF"
    set "file=!file:_SAEHD_data=!"

    REM 输出文件编号和处理后的文件名
    echo 	[!count!]	:  !file!

    REM 将处理后的文件名存储到数组中
    set "files[!count!]=!file!"

    REM 递增计数器
    set /a count+=1
)

REM 用户选择序号
set /p choice="输入序号: "

REM 验证用户输入
if not defined files[%choice%] (
    echo 无效的选择。退出脚本。
    exit /b 1
)


REM 遍历指定目录中符合特定命名模式的文件
for %%F in ("%workspace%\!files[%choice%]!_SAEHD_*.*") do (

    REM 获取原始文件名部分
    set "newName=%%~nxF"

    REM 将文件名中的"_SAEHD_"替换为"_ME_"
    set "newName=!newName:_SAEHD_=_ME_!"

    ren "%%F" "!newName!"

    REM 输出重命名信息
    echo %%~nxF 到 !newName!
)

REM 关闭延迟扩展
endlocal

echo 请注意备份！此时把文件名的ME改为SAEHD还能回到原格式

echo 一旦使用ME训练并且保存模型后，回退原版SAEHD就要损失很多迭代时间了！

pause
