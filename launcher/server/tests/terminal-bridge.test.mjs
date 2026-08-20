import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOOPBACK_HOST,
  PROTOCOL_VERSION,
  REPOSITORY_ROOT,
  TERMINAL_PATH,
  createLaunchSpec,
  parseCliArguments,
  startTerminalBridge,
  validateClientMessage,
} from "../terminal-bridge.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const requireFromWebui = createRequire(path.join(testDirectory, "..", "..", "..", "webui", "package.json"));
const { WebSocket } = requireFromWebui("ws");

const TEST_TOKEN = "contract-test-token-0123456789";

class FakePty {
  constructor() {
    this.pid = 4242;
    this.writes = [];
    this.resizes = [];
    this.killCount = 0;
    this.dataListeners = new Set();
    this.exitListeners = new Set();
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data) { this.writes.push(data); }

  resize(cols, rows) { this.resizes.push([cols, rows]); }

  kill() { this.killCount += 1; }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event) {
    for (const listener of this.exitListeners) listener(event);
  }
}

const socketMessages = new WeakMap();

function trackMessages(socket) {
  const state = { queue: [], waiters: new Set() };
  socketMessages.set(socket, state);
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    for (const waiter of state.waiters) {
      if (!waiter.predicate(message)) continue;
      state.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    state.queue.push(message);
  });
  return socket;
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = trackMessages(new WebSocket(url));
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextJsonMessage(socket, predicate = () => true, timeoutMs = 2_000) {
  const state = socketMessages.get(socket);
  if (!state) throw new Error("WebSocket 未启用消息跟踪");
  const queuedIndex = state.queue.findIndex(predicate);
  if (queuedIndex >= 0) {
    const [message] = state.queue.splice(queuedIndex, 1);
    return Promise.resolve(message);
  }
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timeout: null };
    const timeout = setTimeout(() => {
      state.waiters.delete(waiter);
      reject(new Error("等待 WebSocket 消息超时"));
    }, timeoutMs);
    waiter.timeout = timeout;
    state.waiters.add(waiter);
  });
}

function rejectedUpgradeStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode;
      response.resume();
      socket.terminate();
      resolve(statusCode);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("连接不应成功"));
    });
    socket.once("error", () => {
      // ws may emit an error after the HTTP response; unexpected-response owns the assertion.
    });
  });
}

test("CLI contract accepts port, one-time token, and an absolute project root", () => {
  assert.deepEqual(
    parseCliArguments(["--port", "4179", `--token=${TEST_TOKEN}`]),
    { port: 4179, token: TEST_TOKEN },
  );
  assert.deepEqual(
    parseCliArguments([], { tokenFactory: () => TEST_TOKEN }),
    { port: 0, token: TEST_TOKEN },
  );
  assert.deepEqual(
    parseCliArguments(["--project-root", REPOSITORY_ROOT], { tokenFactory: () => TEST_TOKEN }),
    { port: 0, token: TEST_TOKEN, repositoryRoot: REPOSITORY_ROOT },
  );

  assert.throws(() => parseCliArguments(["--host", "0.0.0.0"]), /不支持的参数/u);
  assert.throws(() => parseCliArguments(["--executable", "powershell.exe"]), /不支持的参数/u);
  assert.throws(() => parseCliArguments(["--args=whoami"]), /不支持的参数/u);
  assert.throws(() => parseCliArguments(["--port", "65536"]), /端口/u);
  assert.throws(() => parseCliArguments(["--token", "short"]), /token/u);
  assert.throws(() => parseCliArguments(["--project-root", "relative-project"]), /绝对路径/u);
});

test("launch contract is fixed to setenv then legacy menu", () => {
  const spec = createLaunchSpec({
    environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SAFE_VALUE: "preserved" },
  });

  assert.equal(spec.cwd, REPOSITORY_ROOT);
  assert.equal(spec.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(
    spec.args,
    '/d /q /s /c "call _internal\\setenv.bat && call legacy-cli\\menu.bat"',
  );
  assert.equal(spec.terminal.cwd, REPOSITORY_ROOT);
  assert.equal(spec.terminal.useConpty, true);
  assert.equal(spec.terminal.env.SAFE_VALUE, "preserved");
  assert.equal(Object.hasOwn(spec, "clientExecutable"), false);
});

test("terminal message contract rejects executable and argument injection", () => {
  assert.deepEqual(validateClientMessage({ type: "input", data: "1" }), { type: "input", data: "1" });
  assert.deepEqual(
    validateClientMessage({ type: "resize", cols: 132, rows: 42 }),
    { type: "resize", cols: 132, rows: 42 },
  );
  assert.deepEqual(validateClientMessage({ type: "close" }), { type: "close" });
  assert.throws(
    () => validateClientMessage({ type: "input", data: "1", executable: "cmd.exe" }),
    /字段不受支持/u,
  );
  assert.throws(() => validateClientMessage({ type: "spawn", args: ["whoami"] }), /类型不受支持/u);
});

test("CLI prints a machine-readable READY record as its first stdout line", async (t) => {
  const entry = path.join(REPOSITORY_ROOT, "launcher", "server", "index.mjs");
  const child = spawn(
    process.execPath,
    [entry, "--project-root", REPOSITORY_ROOT, "--port", "0", "--token", TEST_TOKEN],
    {
    cwd: REPOSITORY_ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });

  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  const firstLine = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`READY 超时：${stderr}`)), 3_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`bridge 提前退出 (${code})：${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(stdout.slice(0, newline).replace(/\r$/u, ""));
    });
  });

  assert.match(firstLine, /^READY \{.*\}$/u);
  const record = JSON.parse(firstLine.slice("READY ".length));
  assert.equal(record.protocol, PROTOCOL_VERSION);
  assert.equal(record.host, LOOPBACK_HOST);
  assert.equal(record.path, TERMINAL_PATH);
  assert.equal(record.token, TEST_TOKEN);
  assert.ok(record.port > 0);

  child.kill();
  await once(child, "exit");
});

test("loopback bridge consumes token once and forwards xterm events", async (t) => {
  const fakePty = new FakePty();
  let receivedSpec;
  const bridge = await startTerminalBridge({
    port: 0,
    token: TEST_TOKEN,
    ptyFactory: (spec) => {
      receivedSpec = spec;
      return fakePty;
    },
  });
  t.after(async () => { await bridge.close("test.cleanup"); });

  assert.equal(bridge.ready.protocol, PROTOCOL_VERSION);
  assert.equal(bridge.ready.host, LOOPBACK_HOST);
  assert.equal(bridge.ready.path, TERMINAL_PATH);
  assert.ok(bridge.ready.port > 0);
  assert.equal(bridge.ready.token, TEST_TOKEN);

  const baseUrl = `ws://${LOOPBACK_HOST}:${bridge.ready.port}${TERMINAL_PATH}`;
  assert.equal(await rejectedUpgradeStatus(`${baseUrl}?token=wrong-token-value-12345`), 401);

  const socket = await openWebSocket(`${baseUrl}?token=${encodeURIComponent(TEST_TOKEN)}`);
  const terminalReady = await nextJsonMessage(socket, (message) => message.type === "ready");
  assert.deepEqual(terminalReady, { type: "ready", pid: 4242, cols: 118, rows: 38 });
  assert.equal(receivedSpec.menuPath, path.join(REPOSITORY_ROOT, "legacy-cli", "menu.bat"));
  assert.equal(await rejectedUpgradeStatus(`${baseUrl}?token=${encodeURIComponent(TEST_TOKEN)}`), 409);

  socket.send(JSON.stringify({ type: "input", data: "5" }));
  socket.send(JSON.stringify({ type: "resize", cols: 140, rows: 45 }));
  socket.send(JSON.stringify({ type: "input", data: "x", executable: "powershell.exe" }));

  const protocolError = await nextJsonMessage(socket, (message) => message.type === "error");
  assert.equal(protocolError.code, "PROTOCOL_ERROR");
  assert.match(protocolError.message, /字段不受支持/u);
  assert.deepEqual(fakePty.writes, ["5"]);
  assert.deepEqual(fakePty.resizes, [[140, 45]]);

  const outputPromise = nextJsonMessage(socket, (message) => message.type === "output");
  fakePty.emitData("传统命令控制台\r\n");
  assert.deepEqual(await outputPromise, { type: "output", data: "传统命令控制台\r\n" });

  const exitPromise = nextJsonMessage(socket, (message) => message.type === "exit");
  fakePty.emitExit({ exitCode: 0, signal: 0 });
  assert.deepEqual(await exitPromise, { type: "exit", exitCode: 0, signal: 0 });
  const closed = await bridge.closed;
  assert.equal(closed.reason, "terminal.exit");
  assert.equal(fakePty.killCount, 0);
});
