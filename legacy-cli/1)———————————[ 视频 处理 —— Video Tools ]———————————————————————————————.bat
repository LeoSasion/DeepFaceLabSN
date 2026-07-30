@echo off
chcp 65001 > nul
cd /d "%~dp0"
attrib +h "1)———————————[ 视频 处理 —— Video Tools ]———————————————————————————————.bat"
attrib -h "1)++++++++++++++++[ 视频 处理 —— Video Tools ]+++++++++++++++++++++++++++++++++++++++++++++.bat"
attrib -h "1.1)--- 剪切视频（将视频拖拽到本文件）----------- cut video (drop video on me).bat"
attrib -h "1.2)--- 提取 DST 视频图片帧 ------------------------ extract images from video data_dst FULL FPS.bat"
attrib -h "1.2)--- 提取 SRC 视频图片帧 ------------------------ extract images from video data_src.bat"
attrib -h "1.3)--- 降噪 data_dst 图片帧（可选） ------------- denoise data_dst images.bat"