# Web 运行时真实闭环烟雾测试

测试时间：2026-07-30（Asia/Shanghai）

## 测试素材

- SRC：NASA / Glenn Research Center 的 Sally Ride 公有领域肖像。
- DST：NASA 的 Buzz Aldrin 公有领域肖像。
- 本地生成：两段 6 秒、720×720、15 FPS 的 H.264 MP4。
- 完整来源与许可记录：`workspace/.webui/test-assets/SOURCES.md`。

## Web 作业结果

| 步骤 | 最终作业 ID | 结果 | 产物 |
| --- | --- | --- | --- |
| SRC 拆帧 | `20260729222202-2ed4616b` | 成功 | 90 张 PNG |
| DST 拆帧 | `20260729222301-d97c19bb` | 成功 | 90 张 PNG |
| SRC S3FD 切脸 | `20260729222342-44c2c81d` | 成功，RTX 3060 | 90 张 256px aligned JPG |
| DST S3FD 切脸 | `20260729222736-334320ad` | 成功，RTX 3060 | 90 张 256px aligned JPG |
| SAEHD 训练 | `20260729223557-b467607d` | 成功并安全停止 | 128px 模型，第 1007 次迭代 |

所有作业均由 Web 运行时固定白名单启动，通过 PTY 接收交互输入；未执行 BAT，也未开放任意 shell。

## SAEHD 实测配置

- 模型名：`web-smoke-128`
- 分辨率：128
- 架构：`df-d`
- AE / Encoder / Decoder / Mask：64 / 32 / 32 / 16
- Batch size：2
- AdaBelief：关闭
- 模型与优化器：GPU
- Masked training：开启
- Random warp：开启
- 预训练：关闭
- 最终保存迭代：1007

首轮图编译迭代耗时 14.10 秒；稳定后约为 120–200 毫秒/迭代。训练指标由终端输出解析后实时进入 Web 作业状态。

## 控制与恢复验证

- 预览：成功生成并刷新 `preview.png`，页面可通过版本号避免缓存。
- 保存：成功更新模型权重与 `data.dat`。
- 备份：成功生成 `web-smoke-128_SAEHD_autobackups`，共 9 个文件。
- 安全停止：先保存再退出，退出码 0，`stopReason=safe-stop`。
- 持久日志：每个作业均保留 `metadata.json` 与 `events.ndjson`。
- 服务重连：重启本地运行时后成功恢复最终状态、第 1007 次指标、预览版本和 2193 条训练事件。
- 页面入口：`http://127.0.0.1:4173/` 返回 200；运行时 PTY 与 Trainer bridge 均为可用状态。
- 自动回归：20/20 测试通过，生产构建成功。

## 完整流水线与浏览器回归（2026-07-30）

- 注册表：53 条固定工作流全部可见；Runtime 不执行或解析 BAT。
- 参数向导：`src.extract_faces` 的 128 px 引导参数通过服务端前置检查；CLI 模式仍可切换。
- 工作区：SRC/DST 素材、帧、aligned、SAEHD/XSeg 模型与输出接口返回正常。
- 遥测：实机识别 NVIDIA GeForce RTX 3060，页面显示利用率、0.5 / 12.0 GB 显存与温度。
- 真实 CLI：通过 Web 终端运行 `src.sort_faces`，发送排序方式 `10` 和默认 CPU 核心数，90/90 完成。
- 真实训练控制：恢复 `web-smoke-128` 的 128 px SAEHD 模型，通过“安全停止”触发保存并以 exit 0 结束。
- 刷新与恢复：浏览器刷新、Runtime 重启与模拟健康检查断线后均能恢复到“本地服务在线”。
- 布局：进入“工作区”会自动收起终端，横屏主内容不再被展开终端挤压。
- 在线烟雾：53 条命令、1 张 GPU、工作区、ConPTY、Trainer bridge 与 WebSocket 快照全部通过。
- 可重复 E2E：`pnpm test:e2e` 覆盖非变更场景；`pnpm test:e2e:mutating` 显式开启真实 CLI 与 SAEHD 保存式停止。

## 本轮发现并修复的问题

1. Windows 环境中同时存在 `Path` 与 `PATH` 时，ConPTY 子进程可能拿不到内置 ffmpeg。现已在构造 DFL 环境时去重，并只传递包含仓库内置工具的 `PATH`。
2. DFL 的视频拆帧代码会捕获 ffmpeg 异常并以退出码 0 结束。运行时现会识别 `ffmpeg fail`，把作业标记为失败，避免页面误报成功。
3. ffmpeg 元数据中的 `(default)` 曾被误识别为 CLI 提示。提示解析规则已收紧。

## 最终功能闭环（2026-07-30）

- Web 参数化合成：作业 `20260730103212-0884c686` 使用 `web-smoke-128`、GPU 0 和完整合成参数成功退出，生成 90 张 merged 与 90 张 merged_mask；终端确认未打开 Merger 窗口。
- 标准 MP4：作业 `20260730094858-8e995f6a` 成功生成 `workspace/result.mp4`。
- 无损 MP4：作业 `20260730094941-f004b86f` 成功生成 `workspace/result_mask.mp4`。
- XSeg 元数据：通过真实 API 对 `src/00000.jpg` 完成“空标注 → 写入 1 个多边形 → 读回 1 个 → 恢复空标注”往返。
- 可恢复清洗：`src/00089.jpg` 完成隔离与恢复往返，最终 SRC aligned 保持 90 张。
- 浏览器验收：1280×720 逐页检查 SRC/DST、XSeg、训练、模型应用、导出、工具和设置；终端自动收起、无横向溢出、控制台 0 错误。
- 自动 E2E：刷新、参数向导、工作区、遥测和“离线后自动轮询恢复”全部通过；未启用会修改素材/模型的可选套件。
- 最终自动检查：20/20 测试、生产构建、改动 Python 文件 `py_compile` 与 Impeccable 布局审计全部通过。
- 依赖审计：Vite 升级至 6.4.3，`pnpm audit --prod` 未发现已知漏洞。
