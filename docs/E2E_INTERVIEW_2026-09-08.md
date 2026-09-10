# 双人访谈端到端验证（2026-09-08）

人物分组功能已完成，在真实访谈素材上完成了提帧、切脸、人物筛选、恢复、遮罩编辑、SAEHD 训练与续训、质量快照、合成和带音轨的视频导出。

本次使用 128px 小模型训练 1,000 次，验证功能和数据流。模型尚未收敛，合成脸明显模糊，成片不能作为最终画质验收结果。使用 CPU 完成验证，未验证 GPU 训练性能。

## 素材和实际结果

活动项目为 `workspaces/interview-practice`。素材作者 W!ZARD Radio Media，来自 [Commons 来源页](https://commons.wikimedia.org/wiki/File:Interview_with_Rebecca_Ferguson_-_Mission-_Impossible_-_Fallout.webm)。来源页标注 CC BY 3.0，外部来源许可待站内复核；出处和原视频链接保留在本地项目说明中。

| 环节 | 实测结果 |
| --- | --- |
| 原视频 | 1920×1080、25 fps、285.84 秒；原文件 SHA-256 保持不变 |
| SRC 拆帧与切脸 | 全片 1 fps，286 帧，S3FD + 2DFAN 提取 353 张 aligned JPG |
| SRC 人物分组 | 默认严格度 0.50 得到 6 组：男士 67、海报 67、女士 184 + 33 + 1 + 1；未出现无法分析的脸图 |
| SRC 筛选 | 界面保留男士 67 张，其余 286 张隔离；逐张取消/重新选择、整组选取均通过 |
| DST | 原片 50–54 秒，100 帧，提取 138 张；分组为女士 62、男士 38、海报 38 |
| DST 筛选 | 保留女士 62 张，其余 76 张隔离 |
| 恢复 | 从隔离区恢复一张海报脸，验证文件 SHA-256 完全相同，再隔离；最终 SRC 仍为 67 张 |
| 遮罩编辑 | 真实浏览器绘制多边形，写入 JPG，刷新后从 DFL 元数据读回；验证后恢复原始 JPG 字节 |
| 训练 | legacy SAEHD，`interview-e2e-128`，wf / df-d / 128px，AE 32、E/D 16、mask 8、batch 2、CPU |
| 保存及续训 | 首轮 0→300，保存并安全停止；第二轮从 301 接续到 1,000，再保存及安全停止，两个进程均 exit 0 |
| 质量评测 | 迭代 173、300、1,000 的 3 份真实快照；每份 37 个固定样本，Web 比较前提 4/4 通过 |
| 合成 | learned-prd × learned-dst 遮罩、overlay、rct、2 workers；100 张 merged、100 张 merged_mask |
| 逐帧验收 | 前 38 帧非目标人物镜头逐像素不变且遮罩全黑；后 62 帧均有目标脸变化和非空遮罩，画面左侧背景保持不变 |
| 导出 | `result.mp4` 为 4.00 秒、100 帧、25 fps、1920×1080，AAC 音轨也为 4.00 秒；`result_mask.mp4` 同帧数与时长 |
| 解码 | 两个 MP4 全部 100 帧成功解码；DFL 自带 VideoEd 入口另行提取测试片段，也生成 100 帧 |

使用 SAEHD 学得的遮罩完成合成，没有训练或应用独立 XSeg 模型。

## 新功能与修复

- 新增「工具 → 数据审计 → 按角色分组」。SFace 在本地计算人脸特征，使用 complete linkage 分组；同帧不同脸不能自动并组，海报和路人可单独排除。
- 允许选择多个候选组和逐张取消；批量保留复用可恢复隔离机制，校验数据集指纹并阻止基于过期/截断分析执行保留。
- 增加固定的视觉依赖准备任务：FFmpeg、S3FD、2DFAN、SFace 的版本及 SHA-256 固定，安装和缓存均留在项目目录，保留许可文件。
- 修复 Windows PowerShell 5.1 从 PowerShell 7 环境启动时模块路径混用，导致准备任务找不到 Get-FileHash 的问题；已通过 WebUI 实际任务重跑。
- 修复内置 Python 的 `._pth` 隔离配置导致 current/legacy DFL 入口和素材分析助手找不到本地模块的问题。
- CPU SAEHD 训练每侧最多使用 2 个样本进程，并保证至少 1 个；达到目标迭代后等待控制命令时不再忙等占用一颗 CPU 核。
- 引导合成仅在选择 XSeg 遮罩时要求 XSeg 模型；使用 learned / landmark 遮罩可正常完成合成。CLI 问答模式继续保留完整依赖检查。
- 修复分组界面固定网格造成预览区域被挤压，以及长项目名/GPU 名造成顶栏换行溢出。
- 修复流程状态计算中把 Array.map 的索引误传为“已有产物”标志的问题。

操作说明与算法边界见 `docs/ROLE_GROUPING.md`。

## 验证记录

- WebUI 隔离测试：102 通过、0 失败、1 跳过；跳过项为当前 Windows 权限拒绝创建文件符号链接（EPERM）。目录 junction 防护另有通过的测试。
- Python 分组契约：7 项通过，覆盖同角色归拢、同帧排斥、弱匹配桥接、严格度、坏输入、空目录和模型校验。
- 原有浏览器回归：4 通过、0 失败、1 跳过；默认跳过的旧 mutating 脚本由本次独立真实训练/保存/续训流程覆盖。首次在训练进行中运行向导检查因资源锁被阻止，训练结束后重跑通过。
- 本次实际浏览器验证：角色整组及单张选择、SRC/DST 保留、英文切换、遮罩写入/回读、训练与姿态诊断页面、合成三联复核、最终视频播放及跳转到 2.8 秒；未出现页面脚本错误。
- 生产构建和 i18n 检查通过；新增分组界面英文条目齐备，既有翻译债务由 215 项减少到 212 项。
- Browser plugin not available；使用仓库现有 Playwright 和本机 Edge 做真实浏览器测试，未模拟模型输出。

## 本地产物

- 成片：`workspaces/interview-practice/result.mp4`，5,831,745 字节，SHA-256 `77d134fbb54dadc92eef0724fc13ddbc7f63bc3026732a347c8dbde23ca74f26`。
- 遮罩视频：`workspaces/interview-practice/result_mask.mp4`，421,807 字节。
- 可续训权重：`workspaces/interview-practice/model/interview-e2e-128_SAEHD_*`。
- 原片、提取帧、aligned 脸图、隔离区、模型和诊断快照都留在本地项目。
- 截图、逐帧校验清单和测试日志位于项目旁的 `../DFL-E2E-evidence`。关键文件：`output-verification.json`、`e2e-comparison.jpg`、`ui-role-results.json`、`mask-roundtrip.json`、`recovery-roundtrip.json`、`unit-tests.log`、`browser-regression.log`。

视频、脸图、权重、测试缓存不进入 Git 或 Release。此次没有构建或发布新的 EXE。
