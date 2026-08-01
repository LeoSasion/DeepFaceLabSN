# DeepFaceLab Python 工具 Web 化地图

更新日期：2026-08-02

## 本轮落地

工具页现在以“证据、判断、下一步”统一呈现九个入口：数据审计、提取复核、合成复核、视频时间线、元数据与打包、模型导出、姿态图谱、覆盖清单和命令目录。Python 分析保持只读、有界和可测试；修改型操作继续经过恢复区或固定命令注册表。

### FaceGrid 人脸姿态图谱

- Python 来源：`_internal/facesets/UI/controls/facegrid.py`、`Ui_FaceGrid.py`、`Ui_previewUI.py`
- Web 入口：左侧“工具” → “人脸姿态图谱”
- 数据：直接读取 `workspace/data_src/aligned` 或 `workspace/data_dst/aligned` 中的真实 DFL JPG。
- 分析：复用 DFL landmarks 姿态估计，生成 Yaw × Pitch 分布；额外计算归一化 Laplacian 清晰度和亮度。
- 交互：SRC/DST 切换、数量/清晰度指标切换、姿态格选择、低清晰度样本检查、回到数据集定位、可恢复隔离、打开固定打包命令。
- 安全：分析只读；隔离必须由用户确认，并移动到 `workspace/.webui/quarantine`，不直接删除。

## 原生 UI 的 Web 迁移状态

| 状态 | 原工具 | Python 来源 | 当前 Web 交互与边界 |
| --- | --- | --- | --- |
| Web 复核 + 固定接力 | Manual Extractor | `_internal/DeepFaceLab/mainscripts/Extractor.py` | 逐帧源画布、真实检测框/landmarks、候选 aligned 栏、漏提/多人脸筛选；重新落点仍启动固定 Extractor 路径 |
| Web 复核 + 固定接力 | Interactive Merger | `_internal/DeepFaceLab/merger/InteractiveMergerSubprocessor.py` | 原帧/结果/遮罩三联画、逐帧验收和引导参数；GPU 逐帧实时重算仍走固定 Merger 路径 |
| 已完成 | Faceset 姿态格预览 | `_internal/facesets/UI/Ui_previewUI.py` | 姿态图谱、质量筛选、样本定位、隔离与固定打包接力 |
| 已完成 | XSeg Editor | `_internal/DeepFaceLab/XSegEditor/XSegEditor.py` | Web Canvas 多边形编辑与 DFL JPG 原位保存 |
| 已完成 | Trainer Preview | `_internal/DeepFaceLab_old/mainscripts/Trainer.py` | 预览、损失曲线、保存、备份、刷新、安全停止 |

## 原本没有独立 UI 的 Python 工具

| 状态 | Python 工具 | 已实现可视化 |
| --- | --- | --- |
| 已完成 | `mainscripts/Sorter.py` | 质量分、清晰度、曝光、重复来源、姿态与元数据问题筛选；可恢复隔离；原排序走固定命令 |
| 已完成 | `mainscripts/VideoEd.py` | 真实视频预览、时长/分辨率/帧率/大小，以及 SRC/DST 裁切、抽帧、DST 降噪固定命令 |
| 已完成 | `mainscripts/Util.py` metadata save/restore | 元数据覆盖、无效文件、唯一来源、重复来源和遮罩覆盖统计，以及保存/恢复固定命令 |
| 已完成 | `samplelib/PackedFaceset.py` | `faceset.pak`/`faceset.zip` 固定格式识别、样本数、大小、完整性与 SHA-256 前缀；打包/解包固定命令 |
| 已完成 | 模型 DFM 导出 | SAEHD/ME/Q384/Q512 模型分组、数据/权重完整性、现有 DFM、阻塞项与固定导出命令 |

## 交互原则

1. 保留 DeepFaceLab 的真实执行逻辑，Web 只重构操作方式和反馈。
2. 原窗口的逐帧键盘节奏要保留，同时补充鼠标、触控和可访问焦点。
3. 高风险清洗默认进入可恢复隔离区；元数据写入和批量合成必须显示影响范围。
4. 运行仍使用固定命令注册表或专用本地 API，不开放任意 Shell、可执行文件或客户端 argv。
5. 外部闭源 EXE 不伪造状态、不抓取窗口；只有可维护 Python 源码能力进入 Web 原生闭环。
