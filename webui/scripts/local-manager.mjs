import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const webuiRoot = path.resolve(path.dirname(scriptPath), "..");
const runtimeRoot = path.join(webuiRoot, ".runtime");
const logsRoot = path.join(runtimeRoot, "logs");
const pidPath = path.join(runtimeRoot, "local-manager.pid");
const statusPath = path.join(runtimeRoot, "local-manager.status.json");
const stopRequestPath = path.join(runtimeRoot, "local-manager.stop");
const viteEntry = path.join(webuiRoot, "node_modules", "vite", "bin", "vite.js");
const serverEntry = path.join(webuiRoot, "server", "index.mjs");
const clientIndex = path.join(webuiRoot, "dist", "client", "index.html");
const appOrigin = "http://127.0.0.1:4173";
const runtimeOrigin = "http://127.0.0.1:4174";
const managedPorts = [4173, 4174];
const command = process.argv[2] ?? "start";

mkdirSync(logsRoot, { recursive: true });

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "");
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function readManagerPid() {
  try {
    const value = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A manager launched by an elevated terminal is still alive when a normal
    // desktop BAT receives EPERM while probing it. Stop requests use a shared
    // file, so status/control do not require matching elevation.
    if (error?.code === "EPERM") return true;
    return false;
  }
}

async function fetchOk(url, timeoutMs = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function getLocalStatus() {
  const pid = readManagerPid();
  const [webOnline, runtimeOnline] = await Promise.all([
    fetchOk(appOrigin),
    fetchOk(`${runtimeOrigin}/api/health`),
  ]);
  let details = null;
  try {
    details = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    // Status is optional while a supervisor is starting.
  }
  return {
    pid,
    managerAlive: isProcessAlive(pid),
    webOnline,
    runtimeOnline,
    managed: Boolean(pid && isProcessAlive(pid)),
    details,
  };
}

function printStatus(status) {
  const state = status.webOnline && status.runtimeOnline
    ? "在线"
    : status.webOnline || status.runtimeOnline
      ? "部分在线"
      : "离线";
  console.log(`[WebUI] ${state}`);
  console.log(`  Web:     ${status.webOnline ? "在线" : "离线"}  ${appOrigin}`);
  console.log(`  Runtime: ${status.runtimeOnline ? "在线" : "离线"}  ${runtimeOrigin}`);
  console.log(`  管理器:  ${status.managerAlive ? `运行中（PID ${status.pid}）` : "未运行"}`);
  if (status.details?.logFile) console.log(`  日志:    ${status.details.logFile}`);
}

function newestSourceMtime() {
  const roots = [
    path.join(webuiRoot, "src"),
    path.join(webuiRoot, "public"),
  ];
  const files = [
    path.join(webuiRoot, "index.html"),
    path.join(webuiRoot, "vite.config.mjs"),
    path.join(webuiRoot, "package.json"),
    path.join(webuiRoot, "pnpm-lock.yaml"),
  ];
  let newest = 0;
  const visit = (target) => {
    if (!existsSync(target)) return;
    const stat = statSync(target);
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      visit(path.join(target, entry.name));
    }
  };
  roots.forEach(visit);
  files.forEach(visit);
  return newest;
}

function ensureClientBuild() {
  const buildMtime = existsSync(clientIndex) ? statSync(clientIndex).mtimeMs : 0;
  if (buildMtime >= newestSourceMtime()) return;

  console.log("[WebUI] 检测到前端源码更新，正在构建生产界面…");
  const result = spawnSync(
    process.execPath,
    [viteEntry, "build", "--configLoader", "runner"],
    {
      cwd: webuiRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(`前端构建失败（退出码 ${result.status ?? "unknown"}）`);
  }
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function assertPortsAvailable() {
  const results = await Promise.all(managedPorts.map(async (port) => ({
    port,
    available: await canBind(port),
  })));
  const occupied = results.filter((item) => !item.available).map((item) => item.port);
  if (occupied.length) {
    throw new Error(
      `端口 ${occupied.join("、")} 已被其他进程占用。为保护现有任务，管理器不会自动结束未知进程。`,
    );
  }
}

async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getLocalStatus();
    if (status.webOnline && status.runtimeOnline) return status;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("WebUI 启动超时，请查看 .runtime/logs 下的最新日志");
}

async function startManager() {
  const existing = await getLocalStatus();
  if (existing.webOnline && existing.runtimeOnline) {
    printStatus(existing);
    if (!existing.managerAlive) {
      console.log("[WebUI] 检测到未受管理的兼容服务；未重复启动。");
    }
    return;
  }
  if (existing.managerAlive) {
    throw new Error(`管理器 PID ${existing.pid} 仍在运行，但服务未就绪；请先选择“重启”。`);
  }

  await assertPortsAvailable();
  ensureClientBuild();
  if (existsSync(stopRequestPath)) unlinkSync(stopRequestPath);

  const logFile = path.join(logsRoot, `local-manager-${timestamp()}.log`);
  const logHandle = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [scriptPath, "supervise"],
    {
      cwd: webuiRoot,
      detached: true,
      env: {
        ...process.env,
        DFL_WEBUI_MANAGER_LOG: logFile,
      },
      stdio: ["ignore", logHandle, logHandle],
      windowsHide: true,
    },
  );
  child.unref();
  closeSync(logHandle);

  const ready = await waitForReady();
  printStatus(ready);
}

async function requestStop() {
  const current = await getLocalStatus();
  if (!current.managerAlive) {
    if (current.webOnline || current.runtimeOnline) {
      throw new Error("检测到未受当前管理器控制的服务，请先确认其来源后再结束。");
    }
    console.log("[WebUI] 已处于停止状态。");
    return;
  }

  writeFileSync(stopRequestPath, `${Date.now()}\n`, "utf8");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isProcessAlive(current.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (isProcessAlive(current.pid)) {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(current.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    if (result.status !== 0 && isProcessAlive(current.pid)) {
      throw new Error(`无法结束管理器 PID ${current.pid}`);
    }
  }
  console.log("[WebUI] 已停止。");
}

function runSupervisor() {
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  const logFile = process.env.DFL_WEBUI_MANAGER_LOG ?? null;
  const startedAt = new Date().toISOString();
  let stopping = false;
  let statusTimer;
  let stopPollTimer;

  const services = [
    {
      id: "runtime",
      label: "Runtime",
      args: [serverEntry],
      child: null,
      restarts: 0,
      failures: [],
      resetTimer: null,
      restartTimer: null,
      state: "starting",
    },
    {
      id: "web",
      label: "Web",
      args: [
        viteEntry,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        "4173",
        "--strictPort",
        "--configLoader",
        "runner",
      ],
      child: null,
      restarts: 0,
      failures: [],
      resetTimer: null,
      restartTimer: null,
      state: "starting",
    },
  ];

  const persistStatus = () => {
    writeJsonAtomic(statusPath, {
      supervisorPid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      state: stopping ? "stopping" : "running",
      logFile,
      urls: {
        web: appOrigin,
        runtime: runtimeOrigin,
      },
      services: Object.fromEntries(services.map((service) => [
        service.id,
        {
          pid: service.child?.pid ?? null,
          state: service.state,
          restarts: service.restarts,
        },
      ])),
    });
  };

  const shutdown = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(statusTimer);
    clearInterval(stopPollTimer);
    for (const service of services) {
      clearTimeout(service.resetTimer);
      clearTimeout(service.restartTimer);
      if (service.child && !service.child.killed) service.child.kill();
      service.state = "stopped";
    }
    persistStatus();
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath);
      if (existsSync(stopRequestPath)) unlinkSync(stopRequestPath);
    } catch {
      // The next start validates stale files against the live PID.
    }
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 250).unref();
  };

  const launch = (service) => {
    if (stopping) return;
    service.state = service.restarts ? "restarting" : "starting";
    service.child = spawn(process.execPath, service.args, {
      cwd: webuiRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    console.log(
      `[local-manager] ${service.label} started (PID ${service.child.pid}, restart ${service.restarts})`,
    );
    service.state = "running";
    clearTimeout(service.resetTimer);
    service.resetTimer = setTimeout(() => {
      service.failures = [];
    }, 30000);
    service.child.once("error", (error) => {
      console.error(`[local-manager] ${service.label} error`, error);
    });
    service.child.once("exit", (code, signal) => {
      if (stopping) return;
      service.state = "crashed";
      const now = Date.now();
      service.failures = service.failures.filter((time) => now - time < 60000);
      service.failures.push(now);
      console.error(
        `[local-manager] ${service.label} exited (${signal ?? code ?? "unknown"})`,
      );
      if (service.failures.length > 5) {
        console.error(
          `[local-manager] ${service.label} crashed too often; stopping the local manager`,
        );
        shutdown(1);
        return;
      }
      service.restarts += 1;
      const delay = Math.min(500 * (2 ** (service.failures.length - 1)), 8000);
      service.restartTimer = setTimeout(() => launch(service), delay);
    });
  };

  services.forEach(launch);
  persistStatus();
  statusTimer = setInterval(persistStatus, 2000);
  stopPollTimer = setInterval(() => {
    if (existsSync(stopRequestPath)) shutdown(0);
  }, 500);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (error) => {
    console.error("[local-manager] uncaught exception", error);
    shutdown(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error("[local-manager] unhandled rejection", error);
    shutdown(1);
  });
}

async function main() {
  if (command === "supervise") {
    runSupervisor();
    return;
  }
  if (command === "start") {
    await startManager();
    return;
  }
  if (command === "stop") {
    await requestStop();
    return;
  }
  if (command === "restart") {
    await requestStop();
    await startManager();
    return;
  }
  if (command === "status") {
    const status = await getLocalStatus();
    printStatus(status);
    process.exitCode = status.webOnline && status.runtimeOnline ? 0 : 1;
    return;
  }
  throw new Error(`未知操作：${command}`);
}

main().catch((error) => {
  console.error(`[WebUI] ${error.message}`);
  process.exitCode = 1;
});
