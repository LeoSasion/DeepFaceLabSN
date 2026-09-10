# 按角色整理人脸素材

入口：**工具 → 数据审计 → 按角色分组**。先提帧、切脸，再选择 SRC 或 DST 分别分析。

1. 点击「分析角色」。默认严格度 0.50，数值越大，分组越保守。
2. 根据预览选择目标角色的一个或多个分组。同一人的大幅度侧脸、低头等可能分到不同候选组。
3. 可逐张取消误分图片，再点击「保留所选角色」。未选中的图片进入该项目的可恢复隔离区。
4. 从对应 SRC / DST 素材页的恢复区检查或恢复图片。源视频和源帧始终保留。

海报、路人等也会成为候选组，工具不会自动判断谁是主角，也不会给人物命名。分组仅作为人工复核的辅助。

## 分组方式与边界

- 使用 OpenCV SFace 的 128 维人脸特征，按照 DFL 的 68 点关键点生成五点对齐输入；全部在本地 CPU 上处理。
- 按余弦相似度做 complete linkage 聚类，避免通过一串弱匹配将不同人物连成一组；同一个源帧的不同脸图不能自动并组。
- 不保存特征向量，不上传脸图。返回的文件名、候选组及分数留在本地操作记录中。
- 每次最多分析 2,000 张。超过上限时只允许预览，禁止基于不完整分析批量保留。
- 提交保留操作时重新核对文件列表、大小和高精度修改时间；分析后素材发生变化会拒绝提交。批量隔离使用原有回滚及恢复机制。
- 分组严格度变化会清除旧的选择，须重新分析。

## 准备依赖

首次使用可从新建任务中运行「准备视觉依赖」，或从分组错误提示处打开该任务。也可在项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-vision-runtime.ps1
```

脚本下载固定版本并校验 SHA-256，安装在项目 `_internal` 内；校验失败不会覆盖原文件，替换旧文件前保留备份。下载缓存保存在 `.launcher-install/vision`。

| 依赖 | 固定来源 | 用途及许可 |
| --- | --- | --- |
| S3FD / 2DFAN | [DeepFaceLab e4b7543](https://github.com/iperov/DeepFaceLab/tree/e4b7543ffa1d73b26fce1e31852727f658ba490c/facelib) | 原项目的人脸检测及关键点模型，遵循上游 GPL-3.0 许可 |
| SFace 2021dec | [OpenCV Zoo 47534e2](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface) | 按人物分组，Apache-2.0；许可随脚本保存在 `tools/licenses/SFace-Apache-2.0.txt`，安装时复制到模型目录 |
| FFmpeg / ffprobe | [Gyan 9.0.1 essentials](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.1) | 视频读写，许可文件随上游发行包安装到 `_internal/ffmpeg/LICENSE` |

大模型、视频和工作区产物不提交到 Git。现有 DCT/HSV 相似组清洗保留，适用于近重复图片审查；人物分组提供独立入口。
