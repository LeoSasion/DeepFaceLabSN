import { timingSafeEqual, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(serverDirectory, "..", "..");
export const LOOPBACK_HOST = "127.0.0.1";
export const TERMINAL_PATH = "/terminal";
export const PROTOCOL_VERSION = "dflsn-terminal-v1";

const DEFAULT_COLS = 118;
const DEFAULT_ROWS = 38;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_TOKEN_LENGTH = 512;
const MIN_TOKEN_LENGTH = 16;
function loadWs(repositoryRoot) {
  try {
    const requireFromWebui = createRequire(path.join(repositoryRoot, "webui", "package.json"));
    return requireFromWebui("ws");
  } catch (error) {
    throw new Error(
      "缺少 WebSocket 运行库：请先安装 webui 依赖（ws）。",
      { cause: error },
    );
  }
}

function loadNodePty(repositoryRoot) {
  try {
    const requireFromWebui = createRequire(path.join(repositoryRoot, "webui", "package.json"));
    return requireFromWebui("node-pty");
  } catch (error) {
    throw new Error(
      "缺少终端运行库：请先安装 webui 依赖（node-pty）。",
      { cause: error },
    );
  }
}

function createToken() {
  return randomBytes(32).toString("base64url");
}

function readOption(argv, index, name) {
  const current = argv[index];
  const prefix = `${name}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), consumed: 1 };
  }
  if (current === name) {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`${name} 缺少参数值`);
    }
    return { value: argv[index + 1], consumed: 2 };
  }
  return null;
}

export function validateToken(value) {
  if (
    typeof value !== "string"
    || value.length < MIN_TOKEN_LENGTH
    || value.length > MAX_TOKEN_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`token 必须是 ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} 个可打印字符`);
  }
  return value;
}

export function parseCliArguments(argv, { tokenFactory = createToken } = {}) {
  if (!Array.isArray(argv)) throw new TypeError("argv 必须是数组");

  let port = 0;
  let token;
  let repositoryRoot;
  for (let index = 0; index < argv.length;) {
    const portOption = readOption(argv, index, "--port");
    if (portOption) {
      if (!/^\d{1,5}$/u.test(portOption.value)) {
        throw new Error("端口必须是 0-65535 之间的整数");
      }
      port = Number.parseInt(portOption.value, 10);
      if (port > 65535) throw new Error("端口必须是 0-65535 之间的整数");
      index += portOption.consumed;
      continue;
    }

    const tokenOption = readOption(argv, index, "--token");
    if (tokenOption) {
      token = validateToken(tokenOption.value);
      index += tokenOption.consumed;
      continue;
    }

    const projectRootOption = readOption(argv, index, "--project-root");
    if (projectRootOption) {
      if (!path.isAbsolute(projectRootOption.value)) {
        throw new Error("--project-root 必须是绝对路径");
      }
      repositoryRoot = path.resolve(projectRootOption.value);
      index += projectRootOption.consumed;
      continue;
    }

    throw new Error(`不支持的参数：${argv[index]}`);
  }

  const result = {
    port,
    token: validateToken(token ?? tokenFactory()),
  };
  if (repositoryRoot) result.repositoryRoot = repositoryRoot;
  return Object.freeze(result);
}

function resolveCmdExecutable(environment) {
  const comSpec = environment.ComSpec ?? environment.COMSPEC;
  if (typeof comSpec === "string" && comSpec.trim()) return path.resolve(comSpec);
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "cmd.exe");
}

export function createLaunchSpec({
  repositoryRoot = REPOSITORY_ROOT,
  environment = process.env,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const setenvPath = path.join(root, "_internal", "setenv.bat");
  const menuPath = path.join(root, "legacy-cli", "menu.bat");
  // node-pty accepts a raw Windows command line. Keeping the fixed BAT paths
  // relative to the fixed cwd avoids cmd.exe's nested-quote ambiguity.
  const args = "/d /q /s /c \"call _internal\\setenv.bat && call legacy-cli\\menu.bat\"";

  return Object.freeze({
    executable: resolveCmdExecutable(environment),
    args,
    cwd: root,
    setenvPath,
    menuPath,
    terminal: Object.freeze({
      name: "xterm-256color",
      cols,
      rows,
      cwd: root,
      env: { ...environment },
      useConpty: true,
    }),
  });
}

function assertOnlyKeys(message, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(message)) {
    if (!allowed.has(key)) throw new Error(`消息字段不受支持：${key}`);
  }
}

export function validateClientMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("消息必须是 JSON 对象");
  }

  if (value.type === "input") {
    assertOnlyKeys(value, ["type", "data"]);
    if (typeof value.data !== "string") throw new Error("input.data 必须是字符串");
    if (value.data.length > MAX_INPUT_LENGTH) throw new Error("单次终端输入过长");
    return Object.freeze({ type: "input", data: value.data });
  }

  if (value.type === "resize") {
    assertOnlyKeys(value, ["type", "cols", "rows"]);
    if (!Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500) {
      throw new Error("resize.cols 必须是 2-500 之间的整数");
    }
    if (!Number.isInteger(value.rows) || value.rows < 1 || value.rows > 300) {
      throw new Error("resize.rows 必须是 1-300 之间的整数");
    }
    return Object.freeze({ type: "resize", cols: value.cols, rows: value.rows });
  }

  if (value.type === "close") {
    assertOnlyKeys(value, ["type"]);
    return Object.freeze({ type: "close" });
  }

  throw new Error("消息类型不受支持");
}

function tokensEqual(expected, candidate) {
  if (typeof candidate !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

function isLoopbackSocket(socket) {
  return socket.remoteAddress === LOOPBACK_HOST
    || socket.remoteAddress === `::ffff:${LOOPBACK_HOST}`;
}

function rejectUpgrade(socket, statusCode, statusText) {
  if (!socket.writable) return socket.destroy();
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
    + "Connection: close\r\n"
    + "Content-Length: 0\r\n"
    + "Cache-Control: no-store\r\n"
    + "\r\n",
  );
}

function parseJsonMessage(raw, isBinary) {
  if (isBinary) throw new Error("不接受二进制消息");
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("消息不是有效 JSON");
  }
  return validateClientMessage(parsed);
}

async function assertLaunchFiles(spec) {
  try {
    await Promise.all([access(spec.setenvPath), access(spec.menuPath)]);
  } catch (error) {
    throw new Error("固定终端入口缺失：需要 _internal/setenv.bat 和 legacy-cli/menu.bat", {
      cause: error,
    });
  }
}

function normalizeExitEvent(event) {
  return {
    type: "exit",
    exitCode: Number.isInteger(event?.exitCode) ? event.exitCode : null,
    signal: Number.isInteger(event?.signal) ? event.signal : null,
  };
}

export async function startTerminalBridge({
  port = 0,
  token = createToken(),
  repositoryRoot = REPOSITORY_ROOT,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  ptyFactory,
  WebSocketServerClass,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("端口必须是 0-65535 之间的整数");
  }
  validateToken(token);

  const launchSpec = createLaunchSpec({ repositoryRoot, cols, rows });
  await assertLaunchFiles(launchSpec);

  const wsPackage = WebSocketServerClass ? null : loadWs(launchSpec.cwd);
  const WebSocketServer = WebSocketServerClass ?? wsPackage.WebSocketServer;
  const spawnPty = ptyFactory ?? ((spec) => {
    const pty = loadNodePty(launchSpec.cwd);
    // node-pty normalizes the options object in-place on Windows.
    return pty.spawn(spec.executable, spec.args, {
      ...spec.terminal,
      env: { ...spec.terminal.env },
    });
  });

  const httpServer = createServer((_request, response) => {
    response.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end('{"ok":false,"error":"not_found"}\n');
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_INPUT_LENGTH + 1024,
    perMessageDeflate: false,
  });

  let tokenConsumed = false;
  let terminal = null;
  let activeSocket = null;
  let closing = false;
  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });

  const send = (message, callback) => {
    if (!activeSocket || activeSocket.readyState !== 1) {
      callback?.(new Error("WebSocket 未连接"));
      return false;
    }
    activeSocket.send(JSON.stringify(message), callback);
    return true;
  };

  const shutdown = async ({ killTerminal = true, reason = "bridge.close", exit = null } = {}) => {
    if (closing) return closed;
    closing = true;

    if (killTerminal && terminal) {
      try { terminal.kill(); } catch {}
    }

    if (activeSocket && (activeSocket.readyState === 0 || activeSocket.readyState === 1)) {
      try { activeSocket.close(1000, "terminal bridge closed"); } catch {}
      const socketToTerminate = activeSocket;
      const timeout = setTimeout(() => {
        try { socketToTerminate.terminate(); } catch {}
      }, 250);
      timeout.unref?.();
    }

    const closeHttp = new Promise((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });
    const closeWs = new Promise((resolve) => {
      try { webSocketServer.close(() => resolve()); } catch { resolve(); }
    });
    await Promise.all([closeHttp, closeWs]);
    const result = Object.freeze({ reason, exit });
    closedResolve(result);
    return result;
  };

  const attachTerminal = (webSocket) => {
    activeSocket = webSocket;
    try {
      terminal = spawnPty(launchSpec);
    } catch (error) {
      send({
        type: "error",
        code: "PTY_START_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
      void shutdown({ killTerminal: false, reason: "pty.start_failed" });
      return;
    }

    const processId = Number.isInteger(terminal?.pid) ? terminal.pid : null;
    terminal.onData((data) => {
      if (typeof data === "string") send({ type: "output", data });
    });
    terminal.onExit((event) => {
      const exitMessage = normalizeExitEvent(event);
      send(exitMessage);
      const timeout = setTimeout(() => {
        void shutdown({ killTerminal: false, reason: "terminal.exit", exit: exitMessage });
      }, 25);
      timeout.unref?.();
    });

    webSocket.on("message", (raw, isBinary) => {
      try {
        const message = parseJsonMessage(raw, isBinary);
        if (message.type === "input") {
          terminal.write(message.data);
        } else if (message.type === "resize") {
          terminal.resize(message.cols, message.rows);
        } else if (message.type === "close") {
          terminal.kill();
          const timeout = setTimeout(() => {
            const exitMessage = normalizeExitEvent(null);
            send(exitMessage);
            void shutdown({ killTerminal: false, reason: "client.close", exit: exitMessage });
          }, 2_000);
          timeout.unref?.();
        }
      } catch (error) {
        send({
          type: "error",
          code: "PROTOCOL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    webSocket.once("error", () => {
      // The close event owns cleanup so it cannot run twice.
    });
    webSocket.once("close", () => {
      void shutdown({ killTerminal: true, reason: "websocket.close" });
    });
    send({ type: "ready", pid: processId, cols, rows });
  };

  httpServer.on("upgrade", (request, socket, head) => {
    if (!isLoopbackSocket(socket)) return rejectUpgrade(socket, 403, "Forbidden");

    let url;
    try {
      url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (url.pathname !== TERMINAL_PATH) return rejectUpgrade(socket, 404, "Not Found");
    if (tokenConsumed) return rejectUpgrade(socket, 409, "Conflict");
    const tokens = url.searchParams.getAll("token");
    if (tokens.length !== 1 || !tokensEqual(token, tokens[0])) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    tokenConsumed = true;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
      attachTerminal(webSocket);
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await shutdown({ killTerminal: false, reason: "listen.invalid_address" });
    throw new Error("无法确定终端桥接端口");
  }

  const ready = Object.freeze({
    protocol: PROTOCOL_VERSION,
    host: LOOPBACK_HOST,
    port: address.port,
    path: TERMINAL_PATH,
    token,
    pid: process.pid,
  });

  return Object.freeze({
    ready,
    launchSpec,
    closed,
    close: (reason = "bridge.close") => shutdown({ reason }),
  });
}
