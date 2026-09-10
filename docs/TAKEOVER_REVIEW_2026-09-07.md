# DeepFaceLabSN 接手排查与开发路线

检查日期：2026-09-07。范围：仓库接手、开发环境准备、现有测试复测、浏览器冒烟检查与后续工作排序。

## 结论

项目已有完整的 Web 工作台、固定命令服务、两套 DFL Python 源码和 Windows 原生启动器，适合在现有架构上继续开发。当前首要工作是恢复可信的持续集成和验证实际 GPU 工作流。

本次未修改业务代码、依赖锁文件或远程仓库。测试与构建通过不等于已验证实际训练、合成或完整安装包。

## 接手基线

- 远程仓库：<https://github.com/LeoSasion/DeepFaceLabSN>。
- 本地目录：`C:\Users\Administrator\Documents\ChatGPT\DFL-WEBUI`；接手前为空，已克隆源码。
- 分支：`main`；提交：`64f135f14ec0721722a64b78f16fb3c7c00a117a`，2026-09-01。
- 最新 GitHub Release：`v0.2.0`，2026-08-21；发布的是启动器 EXE 和 SHA-256 文件，不能将其视为最新源码构建的完整整合包。
- 检查时 GitHub 显示未关闭 Issue 为 0；问题清单主要依据本次复测和源码检查形成。
- 未发现 `.codegraph/`，按仓库指示未创建索引。
- 开发约束已读取：`PRODUCT.md`、`DESIGN.md`、`webui/AGENTS.md`。
- 历史接管记录 `docs/TAKEOVER_BASELINE.md` 保留原样；其 2026-07-29 环境与本次干净克隆不同。

## 架构与现有能力

| 层 | 主要位置 | 后续开发边界 |
| --- | --- | --- |
| React/Vite 工作台 | `webui/src` | 保留中文优先、现有导航与工作流程；展示真实状态 |
| 本地 Node 服务 | `webui/server` | loopback、会话写保护、固定命令、资源锁、可恢复操作 |
| 数据与诊断助手 | `webui/python` | DFL 元数据、图像分析、姿态评测；检查调用只读且有界 |
| 模型与原始流程 | `_internal/DeepFaceLab`、`_internal/DeepFaceLab_old` | SAEHD 使用 legacy 路径；保持 CLI 兼容及输出一致性 |
| 原生启动器 | `launcher/host`、`launcher/ui`、`launcher/server` | C#/.NET Framework 4.8、WebView2、依赖准备、自更新、终端桥 |
| 发布验证 | `.github/workflows/ci.yml`、`tools/verify-release.ps1` | 固定版本、测试、构建产物一致性、更新签名策略 |

已见实现及相关测试：53 条固定命令、SRC/DST 浏览、XSeg 标注、隔离恢复、质量审计、对齐修复、视觉相似候选、训练诊断快照、视频分段、多项目隔离、磁盘余量与诊断导出。

这些能力的验证深度不同。尤其 SAEHD 评测虽有实现、确定性测试和静态检查，仍需真实模型验证权重与迭代不被评测修改。

## 本次验证结果

| 检查 | 结果 | 限制 |
| --- | --- | --- |
| 固定版本同步 | 通过 | 产品 0.2.0、Node 24.19.0、pnpm 11.19.0 |
| 翻译检查 | 通过 | 仍有 215 个基线允许的未翻译 key；不代表英语已完整 |
| 更新签名策略与单测 | 策略通过，2/2 测试通过 | 当前 0.2.x 允许无签名，真实可信公钥列表为空 |
| 启动器终端桥 | 5/5 通过 | 未构建或运行完整 WPF 启动器 |
| Python 架构配置测试 | 3/3 通过 | 使用 Python 3.10 |
| WebUI 隔离测试 | 95 通过、0 失败、1 跳过，共 96 项 | 使用独立 Python 3.10 测试环境；文件符号链接用例因 EPERM 跳过 |
| WebUI 生产构建 | 通过 | 使用项目内 Node 24.19.0 |
| Sites 产物测试 | 4/4 通过 | 仅检查产物，未发布站点 |
| dist 来源一致性及 HTTP 冒烟 | 通过 | 不覆盖 GPU 推理和完整浏览器工作流 |
| 浏览器手动冒烟 | 通过 | 工作台加载、GPU 状态、空素材状态、新建任务三步、缺少 Python 时禁用启动 |
| Windows Pester 发布测试 | 未执行 | 本机只有 Pester 3.4.0；CI 要求 4.10.1 |
| 真实训练、合成、编码、完整浏览器 E2E | 未执行 | 本地没有完整 DFL 运行时、ffmpeg、模型及业务素材 |

WebUI 依赖按锁文件安装。项目内便携 Node 已通过仓库固定 SHA-256 校验；系统 Node 未被替换。测试 Python 放在被忽略的 `webui/.runtime/`，未安装到 `_internal/python_common`，避免把测试环境冒充产品运行时。

### 可复核的测试环境与记录

Python 3.10 测试包：numpy 1.26.4、opencv-python-headless 4.10.0.84、Pillow 9.5.0、scipy 1.11.4、numexpr 2.8.6、colorama 0.4.6、tqdm 4.66.5。这是本次验证组合，不是生产 Python 3.7 的升级方案，也不是完整跨平台依赖锁。

本地记录（被 Git 忽略）：

- `webui/.runtime/audit-tests-initial.log`：按 CI 最小依赖复现缺少 PIL。
- `webui/.runtime/audit-tests.log`：补齐包后，Windows venv 映射导致 76 通过、20 失败。
- `webui/.runtime/audit-tests-standalone.log`：独立解释器环境下 95 通过、1 跳过。

本次已准备的独立解释器复测命令（仓库根目录，PowerShell）：

```powershell
$env:DFLSN_TEST_PYTHON = (Resolve-Path webui/.runtime/audit-standalone/python.exe).Path
_internal/node/bin/node.exe webui/tests/run-isolated.mjs
```

该目录由本机 Python 3.10 的解释器、标准库及上述测试包组成；新克隆需另行准备。后续应由仓库正式测试准备流程取代这种审计环境。

## 已确认问题与验证缺口

### P0：持续集成未建立有效基线

[2026-09-01 CI](https://github.com/LeoSasion/DeepFaceLabSN/actions/runs/33484534236) 的两个任务均失败：

1. Linux 在构造测试数据时出现 `ModuleNotFoundError: No module named 'PIL'`，主要测试未启动。本地仅装 CI 的 numpy/OpenCV 可复现；DFL 导入链还需要 scipy、numexpr、colorama 和 tqdm。
2. Windows 在安装 Pester 4.10.1 时遇到 `AuthenticodeIssuerMismatch`，尚未进入发布验证。日志显示预装 5.9.0 与拟装 4.10.1 的证书链不同。

位置：`.github/workflows/ci.yml`。下一步应统一测试依赖声明，隔离安装并明确导入 Pester 版本，在干净 Linux/Windows runner 上重新运行。验收必须覆盖整个任务，不能只看安装步骤成功。

### P1：Windows 测试入口不支持常见 venv 布局

位置：`webui/tests/run-isolated.mjs` 的 `mapPythonRuntime`。

将 `DFLSN_TEST_PYTHON` 指向 venv 的 `Scripts/python.exe` 时，工具把整个 `Scripts` 目录映射为 `python_common`，丢失解释器所需的父目录 `pyvenv.cfg`，后续 Python 子进程报 `No pyvenv.cfg file`。本次产生 20 项失败，改用独立解释器后消失。

建议为完整安装、便携 Python 和 venv 分别定义映射策略，增加子进程导入检查及明确的依赖错误提示。不能简单移除失败用例。

### P1：Blackwell 实机训练兼容性待验证

本机 GPU 为 NVIDIA RTX PRO 6000 Blackwell Workstation Edition，驱动 591.86。仓库产品运行时锁定 Python 3.7.1、tensorflow-gpu 2.10.1、CUDA 11.8 和 cuDNN 8.8。

这是必须实测的兼容性缺口，尚未确认不兼容。NVIDIA 说明旧 CUDA 应用能否在 Blackwell 上运行取决于是否包含可用 PTX 等条件；TensorFlow 官方说明 2.10 是原生 Windows GPU 支持的最后一个版本。因此不能直接升级一个依赖就宣称解决，也不能仅凭 nvidia-smi 成功宣称训练可用。

参考：[NVIDIA Blackwell 兼容指南](https://docs.nvidia.com/cuda/blackwell-compatibility-guide/index.html)、[TensorFlow Windows 构建说明](https://www.tensorflow.org/install/source_windows)。

验收应依次覆盖设备枚举、张量/卷积运算、最小 SAEHD 训练、保存与恢复、确定性评测、合成及导出，保存版本与错误证据。

### P1：发布签名仍是阶段性实现

`launcher/UPDATE-SIGNING.md` 明确当前保护发布流程，旧 .NET 启动器不在运行时验证 Ed25519。`launcher/update-signing-policy.json` 从 0.3.0 强制签名，但 `trustedKeys` 为空。

0.3.0 发布前需要维护者配置真实发布公钥与密钥保管流程；客户端验签如纳入目标，需要独立实现与验证。不能把已有两项签名单测当成客户端验签完成。

### P2：前置检查修复入口指向错误

浏览器复现：干净克隆 → 新建任务 → 提取 SRC 视频帧 → 确认执行。错误为“内置 Python 不存在 / INPUT_MISSING”，但下一操作显示“打开工作区导入素材”。

原因：`webui/server/command-registry.mjs` 用通用 `INPUT_MISSING` 报告运行时缺失；`webui/src/components/Overlays.jsx` 的 `preflightRecovery` 仅按流水线阶段选择修复入口。

应区分运行时、模型与素材缺失，将运行时问题引向依赖准备/诊断。验收覆盖三类缺失，确认按钮能解决对应阻塞。

### P2：文档及浏览器验收覆盖滞后

- `webui/CAPABILITY_MATRIX.md` 更新日期仍为 2026-08-02，未完整反映多项目、恢复、诊断等后续实现。
- `webui/TRAINING_POSE_REGRESSION_PLAN.md` 保留旧设计待选择表述，而 `webui/AGENTS.md` 已记录后续选定方案；应标注历史计划与当前状态。
- 现有 CI 和发布脚本没有运行 `test:e2e`。已有浏览器脚本依赖素材、可用运行时及 NVIDIA 遥测，不能直接视为干净克隆可运行的端到端检查。
- 英语文案存在 215 项允许债务，应按主要工作流逐步清理，避免通过扩大基线掩盖新增缺失。

## 开发路线与完成标准

| 顺序 | 交付 | 完成标准 |
| --- | --- | --- |
| 1：恢复开发基线 | CI 测试依赖、Pester 版本隔离、Windows venv 兼容、复现说明 | 干净 Linux/Windows CI 全通过；跳过项说明原因；不依赖开发者既有环境 |
| 2：打通本机实际流程 | 完整运行时准备、GPU 能力预检、缺失依赖修复指引、小型授权/合成数据集 | 提帧→切脸→XSeg→SAEHD→评测→合成→编码可运行；保存恢复和取消有证据 |
| 3：固定浏览器验收 | 独立 fixture、真实 API、非 GPU E2E 纳入 CI，GPU 测试单列 | 首次使用、失败修复、数据恢复、项目切换、诊断快照对比可重复验证 |
| 4：补齐发布可信链 | 真实公钥配置、签名渠道、按需实现客户端验签、启动器构建/安装/回滚验证 | 0.3.0 发布门槛通过；更新不覆盖 workspace/模型；旧版本迁移路径经过验证 |
| 5：按使用反馈扩展 | 刷新能力矩阵、整理旧计划、修正文案、评估原生工具缺口 | 每项功能有真实数据、可恢复操作和明确验收；先修阻塞再扩展能力 |

不建议此时大规模改写界面或迁移模型框架。先用稳定测试和实机结果确定瓶颈，再决定是否需要独立的新 GPU 运行时方案。

## 第一阶段实施结果（2026-09-07）

已在 `codex/restore-ci-baseline` 分支完成验证，最终提交 `1fd6b3c007381eb9b527a3a03056a76d180f8afb`；经用户确认，已快进合并并推送至 main，远程提交已核实。

- 统一 Python 3.10 测试依赖清单，Linux/Windows CI 均使用独立 venv。
- 修复 venv 映射，显式测试解释器优先；新增依赖导入、含空格路径及清理不破坏原环境的回归验证。
- Pester 4.10.1 保存到项目内并显式导入，失败输出可见，不更改全局模块或 PSGallery 信任。
- CI 先准备启动器 UI 与经过固定哈希验证的 WebView2 SDK，再执行离线构建回归测试。
- 修复带 .NET SDK 的 Windows runner 上编译器默认引用与显式引用冲突；发布脚本使子进程使用选定的 Node。
- 本地完整发布检查通过：WebUI 97 通过/1 权限跳过，Pester 49 通过/1 真实运行时缺失跳过，终端桥 5/5、Sites 4/4；构建、dist 一致性和 HTTP 冒烟通过。
- [最终 GitHub CI](https://github.com/LeoSasion/DeepFaceLabSN/actions/runs/34137861618)：Linux 与 Windows 两个任务均通过，Windows 已上传验证后的 WebUI 构建产物。

下一开发切入点：第 2 阶段，准备完整产品运行时并验证 Blackwell 上的真实训练、评测、合成与导出；本轮未开始 GPU 训练。
