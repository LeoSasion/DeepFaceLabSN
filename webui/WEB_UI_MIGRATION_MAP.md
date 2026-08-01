# DeepFaceLab Python 工具 Web 化地图

更新日期：2026-08-02

## 本轮落地

### FaceGrid 人脸姿态图谱

- Python 来源：`_internal/facesets/UI/controls/facegrid.py`、`Ui_FaceGrid.py`、`Ui_previewUI.py`
- Web 入口：左侧“工具” → “人脸姿态图谱”
- 数据：直接读取 `workspace/data_src/aligned` 或 `workspace/data_dst/aligned` 中的真实 DFL JPG。
- 分析：复用 DFL landmarks 姿态估计，生成 Yaw × Pitch 分布；额外计算归一化 Laplacian 清晰度和亮度。
- 交互：SRC/DST 切换、数量/清晰度指标切换、姿态格选择、低清晰度样本检查、回到数据集定位、可恢复隔离、打开固定打包命令。
- 安全：分析只读；隔离必须由用户确认，并移动到 `workspace/.webui/quarantine`，不直接删除。

## 仍适合 Web 化的原生 UI

| 优先级 | 原工具 | Python 来源 | 建议 Web 交互 |
| --- | --- | --- | --- |
| P0 | Manual Extractor | `_internal/DeepFaceLab/mainscripts/Extractor.py` | 全屏逐帧审片台；源帧画布、检测框与 landmarks、候选人脸栏、帧带、接受/跳过快捷键 |
| P0 | Interactive Merger | `_internal/DeepFaceLab/merger/InteractiveMergerSubprocessor.py` | 当前帧 A/B 预览；遮罩、腐蚀、模糊、色彩、锐化侧栏；时间轴缓存；确认后批量合成 |
| P1 | Faceset 姿态格预览 | `_internal/facesets/UI/Ui_previewUI.py` | 已大部分并入姿态图谱；后续补多选姿态与精确打包 |
| 已完成 | XSeg Editor | `_internal/DeepFaceLab/XSegEditor/XSegEditor.py` | Web Canvas 多边形编辑与 DFL JPG 原位保存 |
| 已完成 | Trainer Preview | `_internal/DeepFaceLab_old/mainscripts/Trainer.py` | 预览、损失曲线、保存、备份、刷新、安全停止 |

## 原本没有独立 UI、适合可视化的 Python 工具

| 优先级 | Python 工具 | 可视化方案 |
| --- | --- | --- |
| P1 | `mainscripts/Sorter.py` | 清洗工作台：展示模糊、姿态、直方图等排序理由；双图比较；先隔离、再提交或回滚 |
| P1 | `mainscripts/VideoEd.py` | 时间轴裁剪、关键帧缩略图、抽帧范围、降噪强度与前后帧比较 |
| P2 | `mainscripts/Util.py` metadata save/restore | 元数据版本时间线、影响文件数、差异预览、冲突提示与恢复点 |
| P2 | `samplelib/PackedFaceset.py` | 包内容检查器：文件清单、姿态覆盖、模型兼容性和打包前校验 |
| P2 | 模型 DFM 导出 | 兼容性预检、模型文件完整性、输出产物与失败恢复步骤 |

## 交互原则

1. 保留 DeepFaceLab 的真实执行逻辑，Web 只重构操作方式和反馈。
2. 原窗口的逐帧键盘节奏要保留，同时补充鼠标、触控和可访问焦点。
3. 高风险清洗默认进入可恢复隔离区；元数据写入和批量合成必须显示影响范围。
4. 运行仍使用固定命令注册表或专用本地 API，不开放任意 Shell、可执行文件或客户端 argv。
5. 外部闭源 EXE 不伪造状态、不抓取窗口；只有可维护 Python 源码能力进入 Web 原生闭环。
