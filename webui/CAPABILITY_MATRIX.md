# WebUI 能力矩阵

更新日期：2026-07-30

## Web 原生界面

| 能力 | 状态 | 实现 |
| --- | --- | --- |
| SRC/DST aligned 浏览 | 已完成 | 浏览真实 JPG、源文件名、DFL 元数据、多边形和已应用遮罩状态 |
| aligned 清洗 | 已完成 | 移入 `workspace/.webui/quarantine`，支持列表与恢复 |
| XSeg 多边形标注 | 已完成 | Web 中编辑 include/exclude，直接读写 DFL `SegIEPolys` |
| SAEHD Trainer 预览与控制 | 已完成 | 5:2 实时预览；保存、备份、刷新和安全停止走源码桥 |
| 引导合成 | 已完成 | Web 表单控制 Merger 参数，不打开 Merger 窗口 |
| 终端监视器 | 已完成 | 多会话 ConPTY、CLI 输入、提示、持久日志和断线恢复 |
| 工作区管理 | 已完成 | 视频导入/归档、素材/模型/输出检查、结果播放 |
| GPU 与训练监控 | 已完成 | 利用率、显存、温度、功耗、速度和 ETA |
| 任务恢复 | 已完成 | 失败/失联任务按原命令、模式和参数重试 |

## 固定命令注册表

| 分组 | 命令 ID |
| --- | --- |
| 提取 | `src.extract_frames`、`src.extract_faces`、`dst.extract_frames`、`dst.extract_faces` |
| 排序 | `src.sort_faces`、`dst.sort_faces` |
| 数据集 | `src.landmarks_debug`、`src.faces_resize`、`src.faces_enhance`、`src.faces_pack`、`src.faces_unpack`、`src.recover_names`、`src.metadata_save`、`src.metadata_restore`；DST 对应 8 条 |
| XSeg | `xseg.train`、`xseg.apply_src`、`xseg.apply_dst`、`xseg.src_apply_builtin`、`xseg.src_remove_labels`、`xseg.src_remove_mask`、`xseg.src_fetch_labels`；DST 对应内置应用/移除标签/移除遮罩/获取标签 |
| 训练 | `train.saehd`、`train.me`、`train.q384`、`train.q512` |
| 合成 | `merge.saehd`、`merge.amp`、`merge.me`、`merge.q384`、`merge.q512` |
| DFM 导出 | `export.dfm_saehd`、`export.dfm_me`、`export.dfm_q384`、`export.dfm_q512` |
| 视频工具 | `video.cut_src`、`video.cut_dst`、`dst.denoise_frames` |
| 封装 | `encode.mp4`、`encode.mp4_lossless`、`encode.avi`、`encode.mov_lossless` |

注册表合计 53 条；XSeg 训练同时计入 XSeg 与训练语义，但只计一个命令 ID。

## 保留原 CLI 的场景

- 首次 S3FD 自动切脸已接入；需要人工框选初始人脸的 manual extractor 仍使用 DFL 原源码窗口。
- 不常用或版本特有的高级问答可以切换到 CLI 模式，在 Web 终端完成。
- 这些路径仍由固定 Python 入口启动，不会变成任意 Shell。

## 明确暂缓

- EBSynth、第三方 aligned 浏览器/角度工具及其他独立闭源 EXE。
- 外部窗口捕获、嵌入和自动操控。
- TensorFlow 到 PyTorch 的模型迁移。

暂缓项不会出现在可执行命令注册表中。`ExternalWindowAdapter` 只保留禁用接口，方便未来逐项整合。
