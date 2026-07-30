# DeepFaceLabSN Web 管理器架构

## 1. 运行拓扑

```text
React/Vite UI (127.0.0.1:4173)
        │ HTTP + WebSocket
        ▼
Local Runtime Service (127.0.0.1:4174)
        ├── CommandRegistry ── 固定 executable/argv/environment
        ├── JobManager ─────── 状态、资源锁、日志、重连
        ├── PtyRunner ──────── Windows ConPTY / node-pty
        ├── OutputParser ───── 提示、迭代、损失和状态
        ├── TrainerBridge ──── JSONL 控制文件 + PNG 预览
        ├── WorkspaceManager ─ 固定目录扫描、导入、归档、产物读取
        ├── AssetManager ───── aligned 元数据、图片流、隔离与恢复
        ├── TelemetryProvider  nvidia-smi 缓存采样
        ├── EncodeMedia ────── 固定视频编码模式
        └── ExternalWindowAdapter (disabled)
                 │
                 ▼
_internal/python_common/python.exe
        ├── _internal/DeepFaceLab/main.py
        └── _internal/DeepFaceLab_old/main.py
```

BAT 文件不在运行链路中。它们只在开发阶段用于核对现有参数语义。

## 2. 目录

```text
webui/
  server/
    index.mjs
    app-server.mjs
    command-registry.mjs
    environment.mjs
    external-window-adapter.mjs
    job-manager.mjs
    output-parser.mjs
    paths.mjs
    pty-runner.mjs
    telemetry.mjs
    workspace-manager.mjs
    asset-manager.mjs
    encode-mp4.mjs
  python/
    dfl_asset_tool.py
  scripts/
    dev.mjs
    local-manager.mjs
    smoke-live.mjs
  src/
    runtime/
      api.js
      useRuntime.js
    components/
      ConsoleDock.jsx
      OperationsView.jsx
      TrainingView.jsx
      WorkspaceView.jsx
  tests/
workspace/
  .webui/
    runtime.json
    jobs/<job-id>/
      metadata.json
      events.ndjson
      control.jsonl
      preview.png
    archive/
```

## 3. 服务接口

### HTTP

- `GET /api/health`
- `GET /api/commands`
- `GET /api/commands/:id/preflight`
- `GET /api/workspace`
- `GET /api/workspace/artifacts/result.mp4`
- `GET /api/workspace/artifacts/result_mask.mp4`
- `GET /api/telemetry`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/events?after=<sequence>`
- `GET /api/jobs/:id/preview`
- `POST /api/jobs`
- `POST /api/jobs/:id/retry`
- `POST /api/jobs/:id/input`
- `POST /api/jobs/:id/control`
- `POST /api/workspace/import/:side`
- `POST /api/jobs/archive-completed`
- `GET /api/assets/:side/aligned`
- `GET /api/assets/:side/aligned/:name`
- `GET /api/assets/:side/aligned/:name/annotation`
- `PUT /api/assets/:side/aligned/:name/annotation`
- `POST /api/assets/:side/aligned/:name/quarantine`
- `GET /api/assets/:side/quarantine`
- `POST /api/assets/:side/quarantine/:entry/restore`

所有响应使用 `{ ok, data }` 或 `{ ok: false, error: { code, message, details? } }`。

### WebSocket

连接：`/ws?jobId=<id>&after=<sequence>`。握手必须携带 `/api/health`
签发的 `HttpOnly`、`SameSite=Strict` 会话 Cookie，并通过精确的本机 Origin
白名单校验；令牌不会出现在 URL 或日志中。

服务事件：

- `snapshot`
- `terminal.output`
- `terminal.prompt`
- `job.state`
- `job.metric`
- `job.artifact`
- `job.finished`

客户端消息：

- `terminal.input`
- `terminal.resize`
- `job.control`

HTTP 输入和控制端点作为 WebSocket 不可用时的降级通道。

## 4. 状态机

```text
queued → starting → running ↔ waiting_input
                     │
                     ├── stopping → succeeded / failed
                     ├── succeeded
                     ├── failed
                     └── orphaned（服务失去进程所有权）
```

进程退出码 `0` 为 `succeeded`，其他退出码为 `failed`。用户安全停止仍由 Trainer 正常退出，元数据另记 `stopReason: safe-stop`。

## 5. 命令和环境

运行环境等价于现有 setenv 语义，但由代码直接构造：

- Python：`_internal/python_common/python.exe`
- current DFL：`_internal/DeepFaceLab/main.py`
- legacy DFL：`_internal/DeepFaceLab_old/main.py`
- `PYTHONHOME`、`PYTHONPATH`、CUDA/CUDNN/FFmpeg 路径均解析为仓库内绝对路径。
- 工作目录固定为仓库根目录。

注册表只接收结构化参数。每条命令拥有独立 schema，服务端校验类型、范围、枚举和固定路径；客户端不能控制 executable、入口文件或任意 argv。命令可选择 `guided` 或 `cli` 启动模式，但最终都由同一注册表构造。

视频导出由 `encode-mp4.mjs` 按注册模式顺序执行固定的音视频处理命令，支持标准/无损 MP4、AVI 和无损 MOV。浏览器不提交 Shell 字符串。

引导合成把验证后的配置序列化到 `DFL_WEB_MERGE_CONFIG`。current/legacy `Merger.py` 只解析这组固定字段并应用到 `MergerConfig`，因此无需启动 OpenCV Merger 窗口；CLI 模式不设置该变量，保留原始交互。

## 6. 持久化与恢复

- 每个事件有单调递增 `sequence`。
- 终端输出按块写入 NDJSON，内存仅保留有限环形缓存。
- 元数据每次状态变化后写临时文件再原子替换。
- 前端保存最近 sequence，断线后以 `after` 补齐。
- 服务启动时读取任务目录；任何持久化为活动态但没有本服务进程句柄的任务都改为 `orphaned`。
- 已完成任务可移动到 `workspace/.webui/archive`；素材替换也进入可恢复归档，不直接删除旧文件。
- aligned 清洗移动到 `workspace/.webui/quarantine/<side>`；恢复操作再次校验文件名和目标边界。

## 7. 工作区与遥测

- `WorkspaceManager` 只扫描固定的 SRC、DST、aligned、model、merged 和 result 路径，识别 SAEHD、ME、AMP、Q384、Q512 模型及 MP4/AVI/MOV 输出。
- `AssetManager` 只允许 `src`/`dst` 和安全 JPG 文件名；固定 Python helper 复用 DFLIMG/SegIEPolys 读取与写回元数据。
- 视频上传只接受允许扩展名，并写入固定的 `data_src`/`data_dst` 目标；结果播放只允许 `result.mp4` 与 `result_mask.mp4`。
- 视频元数据由固定的 `ffprobe` 读取，结果接口实现 HTTP Range。
- `TelemetryProvider` 以缓存频率调用 `nvidia-smi`，返回利用率、显存、温度、功耗和风扇；前端每 3 秒轮询。
- `JobManager` 根据 SAEHD 迭代耗时和引导模式的目标迭代数计算每小时迭代数与 ETA。

## 8. Trainer 控制桥

训练进程通过两个环境变量启用桥：

- `DFL_WEB_CONTROL_FILE=<job>/control.jsonl`
- `DFL_WEB_PREVIEW_FILE=<job>/preview.png`

legacy Trainer 主线程增量读取控制文件，将允许的操作送入原有 `s2c` 队列。收到 `show` 后把第一张预览图原子写为 PNG。未设置变量时行为与原项目一致。

## 9. 安全边界

- 服务只监听 loopback。
- WebSocket 和写请求校验启动令牌。
- Origin 只允许 loopback 主机。
- 请求体最大 64 KiB，终端输入最大 8 KiB。
- job ID、command ID 和 control op 采用枚举或严格正则。
- 不调用 `cmd.exe`、PowerShell、BAT 或 `shell: true`。
- UI 不显示强制终止为常规训练动作。
- 文件导入与产物读取都使用固定槽位/文件名，不接受用户提供的目标路径。

## 10. 统一启动器

根目录的 `启动 WebUI.bat` 仅启动 `local-manager.mjs`，不参与 DFL 任务执行。管理器负责 Web/Runtime 进程、端口检查、日志、状态文件和异常重启；状态存放在 `webui/.runtime`。传统命令集中在 `legacy-cli`，由根目录的白名单式交互 CLI 路由器访问；旧 Explorer 展开/收缩菜单仅作为二级兼容入口。

## 11. 外部窗口适配

`ExternalWindowAdapter` 统一声明 `capabilities()`、`attach()`、`snapshot()`、`sendInput()`、`close()`。默认适配器全部返回 `supported: false`。未来实现不会改变任务和终端协议。
