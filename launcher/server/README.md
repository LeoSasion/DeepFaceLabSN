# DeepFaceLabSN Terminal Bridge

这个进程为启动器提供单会话 ConPTY。它只监听 `127.0.0.1`，且唯一可启动的目标固定为：

```text
cmd.exe /d /q /s /c "call _internal\setenv.bat && call legacy-cli\menu.bat"
```

客户端不能传入 executable、args、工作目录或环境变量。

## 启动合同

```powershell
_internal\node\bin\node.exe launcher\server\index.mjs --port 0 --token <至少16字符的一次性令牌>
```

- `--port` 可省略；`0` 表示由系统选择空闲端口。
- `--token` 可省略；此时桥接进程生成 32 字节随机令牌。
- 不接受其他命令行参数。
- 正常启动时，stdout 第一行固定为 `READY ` 加单行 JSON：

```text
READY {"protocol":"dflsn-terminal-v1","host":"127.0.0.1","port":55334,"path":"/terminal","token":"...","pid":1234}
```

连接地址为：

```text
ws://127.0.0.1:<port>/terminal?token=<URL 编码后的 token>
```

令牌在第一次成功的 WebSocket Upgrade 时立即消耗，之后的连接会被拒绝。

## WebSocket 消息

客户端到桥接进程：

```json
{"type":"input","data":"1"}
{"type":"resize","cols":118,"rows":38}
{"type":"close"}
```

桥接进程到客户端：

```json
{"type":"ready","pid":4321,"cols":118,"rows":38}
{"type":"output","data":"..."}
{"type":"exit","exitCode":0,"signal":0}
{"type":"error","code":"PROTOCOL_ERROR","message":"..."}
```

## 合同测试

```powershell
_internal\node\bin\node.exe --test launcher\server\tests\*.test.mjs
```
