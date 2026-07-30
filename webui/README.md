# DeepFaceLabSN Web 管理器

本目录同时包含已采纳的 React 工作台和本机运行时服务。运行时只监听 `127.0.0.1`，通过白名单直接启动 DFL Python 入口；不会执行 BAT，也不提供任意 Shell。

## 一键启动

在仓库根目录双击：

```text
启动 WebUI.bat
```

启动器会检查并管理 Web、Runtime 和端口占用，异常退出时自动重启。也可以在本目录运行：

```powershell
pnpm serve:local
pnpm status:local
pnpm restart:local
pnpm stop:local
```

页面地址为 `http://127.0.0.1:4173`，本地 Runtime 为 `http://127.0.0.1:4174`。

## 开发运行

```powershell
pnpm install
pnpm dev
```

- Web：`http://127.0.0.1:4173`
- 本地运行时：`http://127.0.0.1:4174`

`pnpm dev` 会同时管理 Vite 和本地运行时。生产构建使用：

```powershell
pnpm build
pnpm start
```

`pnpm start` 从 `dist/client` 提供静态页面和 `/api`、`/ws`。

## 已接入的 53 条固定工作流

- 素材提取 4 条：SRC/DST 拆帧和 S3FD 切脸。
- aligned 数据集 18 条：SRC/DST 排序、关键点检查图、缩放、增强、打包/解包、恢复文件名、元数据保存/恢复。
- XSeg 10 条：训练、自定义模型应用、内置模型应用、获取/移除标签和移除已应用遮罩。
- 模型训练 5 条：SAEHD、ME、Q384、Q512 与 XSeg；SAEHD 固定使用 legacy DFL 路径。
- 模型应用 5 条：SAEHD、AMP、ME、Q384、Q512。
- 模型导出 4 条：SAEHD、ME、Q384、Q512 导出 DFM。
- 视频工具 3 条：SRC/DST 裁切、DST 帧降噪。
- 视频封装 4 条：MP4、无损 MP4、AVI、无损 MOV。

每条命令都支持服务端前置检查。常用参数通过向导收集并严格校验；仍可切换到 CLI 模式处理高级或意外交互。输入缺失会在启动前停止，不创建假任务。模型训练强制使用 `--no-preview`；保存、备份、刷新预览和安全停止通过 Trainer 控制桥进入原有模型代码。

合成向导会把经过白名单验证的参数送入 DFL 源码适配层，直接完成合成，不再打开 Merger 窗口。运行时始终直接启动固定 Python/Node 可执行文件与 argv，不读取、不解析、不执行 BAT。

## 工作区与监控

- 工作区管理器扫描 SRC/DST 视频、帧、aligned、SAEHD/XSeg 模型与输出视频。
- 浏览器可导入或替换 SRC/DST 视频；被替换的旧视频移动到可恢复归档。
- SRC/DST 页面可浏览真实 aligned JPG、检查 DFL 元数据，并把误素材移动到可恢复隔离区。
- XSeg 页面可直接编辑 aligned JPG 中的 include/exclude 多边形，保存后仍由原 DFL 数据结构读取。
- `result.mp4` 和 `result_mask.mp4` 可在浏览器播放，支持 Range 请求。
- 顶栏实时显示 GPU 利用率、显存、温度、功耗与风扇；训练任务显示速度和预计完成时间。
- 失败或失联任务可按原命令和参数重新创建；已完成任务可以归档到 `workspace/.webui/archive`。

## 任务数据

每个任务保存到：

```text
workspace/.webui/jobs/<job-id>/
  metadata.json
  events.ndjson
  control.jsonl
  preview.png
```

页面刷新后会重连仍由服务持有的 ConPTY。若服务本身重启，旧活动任务会被标记为“连接已丢失”，避免误导用户。

## 验证

```powershell
pnpm test
pnpm build
```

测试包含命令白名单、路径边界、aligned 元数据读写、资源锁、输出解析、HTTP/会话/Origin、WebSocket、Sites 打包、Trainer 语法和真实 ConPTY 交互。

真实浏览器测试需要先启动本地管理器。默认用例只做刷新、参数向导、工作区、遥测和断线恢复，不修改 DFL 素材：

```powershell
pnpm test:e2e
```

实际排序 SRC aligned 并短暂恢复 128 px 测试模型的 CLI/安全停止用例默认关闭。明确需要执行时：

```powershell
$env:DFL_E2E_MODEL_NAME = "web-smoke-128"
pnpm test:e2e:mutating
```

测试会依次尝试 Playwright Chromium、本机 Chrome 和 Edge；三者都不可用时再运行 `pnpm exec playwright install chromium`。

产品范围见 [PRD.md](./PRD.md)，技术细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)，完整覆盖范围与暂缓项见 [CAPABILITY_MATRIX.md](./CAPABILITY_MATRIX.md)。
