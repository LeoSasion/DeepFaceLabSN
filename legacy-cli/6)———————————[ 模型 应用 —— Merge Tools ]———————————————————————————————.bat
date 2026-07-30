@echo off
chcp 65001 > nul
cd /d "%~dp0"
attrib +h "6)———————————[ 模型 应用 —— Merge Tools ]———————————————————————————————.bat"
attrib -h "6)++++++++++++++++[ 模型 应用 —— Merge Tools ]++++++++++++++++++++++++++++++++++++++++++++.bat"
attrib -h "6.1)--- 导出 ME 直播模型 -------------------------- export ME as dfm.bat"
attrib -h "6.1)--- 导出 Quick512 直播模型 ------------------- export Quick512 as dfm.bat"
attrib -h "6.1)--- 导出 Quick384 直播模型 ------------------- export Quick384 as dfm.bat"
attrib -h "6.1)--- 导出 SAEHD 直播模型 ---------------------- export SAEHD as dfm.bat"
attrib -h "6.2)--- 模型 AMP 合成人脸 ------------------------ merge AMP.bat"
attrib -h "6.2)--- 模型 Quick512 合成人脸 ------------------- merge Quick512.bat"
attrib -h "6.2)--- 模型 Quick384 合成人脸 ------------------- merge Quick384.bat"
attrib -h "6.2)--- 模型 ME 合成人脸 -------------------------- merge ME.bat"
attrib -h "6.2)--- 模型 SAEHD 合成人脸 ---------------------- merge SAEHD.bat"