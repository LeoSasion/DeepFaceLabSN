@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"

echo 正在初始化传统 BAT 二级菜单...

rem 默认隐藏传统命令和展开状态，仅保留一级分类入口。
attrib +h *.* > nul 2>&1

attrib -h "README.md"
attrib -h "0)++++++++++++++++[ 最近 使用 —— Recent Use ]+++++++++++++++++++++++++++++++++++++++++++++.bat"
attrib -h "0)———————————[ 显卡 设置 —— RG 开关 ]—————————————————————————————————.bat"
attrib -h "0)———————————[ 展开 全部 —— Expand All ]————————————————————————————————.bat"
attrib -h "1)———————————[ 视频 处理 —— Video Tools ]———————————————————————————————.bat"
attrib -h "2)———————————[ SRC 处理 —— Data_src Tools ]——————————————————————————————.bat"
attrib -h "3)———————————[ DST 处理 —— Data_dst Tools ]——————————————————————————————.bat"
attrib -h "4)———————————[ 遮罩 处理 —— XSeg Tools ]———————————————————————————————.bat"
attrib -h "5)———————————[ 模型 训练 —— Train Models ]———————————————————————————————.bat"
attrib -h "6)———————————[ 模型 应用 —— Merge Tools ]———————————————————————————————.bat"
attrib -h "7)———————————[ 封装 视频 —— Encode Videos ]——————————————————————————————.bat"
attrib -h "8)———————————[ 其他 测试 —— Extra Function ]——————————————————————————————.bat"

rem 初始化完成后隐藏自身；“展开全部”仍可重新显示。
attrib +h "%~nx0"

echo 传统命令菜单初始化完成。
echo 后续可使用各分类 BAT 展开或收缩二级命令。
echo.
endlocal
pause
