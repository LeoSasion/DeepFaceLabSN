import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  buildAlignedPoseAtlas,
  inspectAlignedAnnotation,
  listAlignedAssets,
  listAlignedQuarantine,
  quarantineAlignedImage,
  restoreAlignedImage,
  saveAlignedAnnotation,
  streamAlignedImage,
} from "./asset-manager.mjs";
import { listCommands, prepareCommand } from "./command-registry.mjs";
import { describeEnvironment } from "./environment.mjs";
import { DisabledExternalWindowAdapter } from "./external-window-adapter.mjs";
import { JobManager } from "./job-manager.mjs";
import { PATHS, pathExists } from "./paths.mjs";
import { getGpuTelemetry } from "./telemetry.mjs";
import {
  importWorkspaceVideo,
  inspectWorkspace,
  resolveWorkspaceArtifact,
} from "./workspace-manager.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = "dfl_web_session";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://terminal.local:4173",
]);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? "本地服务发生错误" : error?.message ?? "请求失败";
  sendJson(response, status, {
    ok: false,
    error: {
      code: error?.code ?? "INTERNAL_ERROR",
      message,
      ...(error?.details ? { details: error.details } : {}),
    },
  });
}

async function sendVideoArtifact(request, response, target) {
  if (!(await pathExists(target))) {
    return sendJson(response, 404, {
      ok: false,
      error: { code: "ARTIFACT_MISSING", message: "输出文件尚未生成" },
    });
  }
  const fileStat = await stat(target);
  const contentType = path.extname(target).toLowerCase() === ".avi"
    ? "video/x-msvideo"
    : path.extname(target).toLowerCase() === ".mov"
      ? "video/quicktime"
      : "video/mp4";
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileStat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    return createReadStream(target).pipe(response);
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), fileStat.size - 1) : fileStat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= fileStat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    return response.end();
  }
  response.writeHead(206, {
    "Content-Type": contentType,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  return createReadStream(target, { start, end }).pipe(response);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        return separator === -1
          ? [decodeURIComponent(item), ""]
          : [decodeURIComponent(item.slice(0, separator)), decodeURIComponent(item.slice(separator + 1))];
      }),
  );
}

function safeTokenEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求体过大");
      error.code = "REQUEST_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("JSON 请求体无效");
    error.code = "INVALID_JSON";
    error.status = 400;
    throw error;
  }
}

function isWriteRequest(request) {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
}

export class RuntimeServer {
  constructor({
    jobManager = new JobManager(),
    externalWindowAdapter = new DisabledExternalWindowAdapter(),
    staticRoot = PATHS.staticRoot,
    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  } = {}) {
    this.jobManager = jobManager;
    this.externalWindowAdapter = externalWindowAdapter;
    this.staticRoot = staticRoot;
    this.allowedOrigins = new Set(allowedOrigins);
    this.sessionToken = randomBytes(32).toString("hex");
    this.httpServer = null;
    this.webSocketServer = null;
  }

  async start({ host = "127.0.0.1", port = 4174 } = {}) {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error("本地运行时只允许监听 loopback 地址");
    }
    await this.jobManager.initialize();
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.httpServer = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
    const address = this.address();
    if (address) {
      for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
        this.allowedOrigins.add(`http://${hostname}:${address.port}`);
      }
    }
    return address;
  }

  address() {
    const address = this.httpServer?.address();
    return typeof address === "object" && address
      ? { host: address.address, port: address.port }
      : null;
  }

  async stop() {
    for (const client of this.webSocketServer?.clients ?? []) client.close(1001, "服务停止");
    await new Promise((resolve) => {
      if (!this.httpServer?.listening) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.webSocketServer?.close();
  }

  requestHasSession(request) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return safeTokenEqual(token, this.sessionToken);
  }

  async handleRequest(request, response) {
    try {
      if (!isAllowedOrigin(request.headers.origin, this.allowedOrigins)) {
        return sendJson(response, 403, {
          ok: false,
          error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不是本机 Web 管理器" },
        });
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { Allow: "GET,HEAD,POST,PUT,OPTIONS" });
        return response.end();
      }

      const baseUrl = `http://${request.headers.host ?? "127.0.0.1"}`;
      const url = new URL(request.url ?? "/", baseUrl);
      if (url.pathname.startsWith("/api/")) {
        if (isWriteRequest(request) && !this.requestHasSession(request)) {
          return sendJson(response, 403, {
            ok: false,
            error: { code: "SESSION_REQUIRED", message: "本地服务会话已失效，请刷新页面" },
          });
        }
        return await this.handleApi(request, response, url);
      }
      return await this.serveStatic(request, response, url);
    } catch (error) {
      return sendError(response, error);
    }
  }

  async handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/health") {
      const [pythonAvailable, currentAvailable, legacyAvailable, workspaceAvailable] =
        await Promise.all([
          pathExists(PATHS.python),
          pathExists(PATHS.currentMain),
          pathExists(PATHS.legacyMain),
          pathExists(PATHS.workspaceRoot),
        ]);
      return sendJson(
        response,
        200,
        {
          ok: true,
          data: {
            service: "DeepFaceLabSN Local Runtime",
            version: "0.1.0",
            loopbackOnly: true,
            runtime: {
              pythonAvailable,
              currentAvailable,
              legacyAvailable,
              workspaceAvailable,
              current: describeEnvironment("current"),
              legacy: describeEnvironment("legacy"),
            },
            capabilities: {
              pty: true,
              websocket: true,
              trainerBridge: true,
              persistentLogs: true,
              externalWindows: this.externalWindowAdapter.capabilities(),
            },
          },
        },
        {
          "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(this.sessionToken)}; Path=/; HttpOnly; SameSite=Strict`,
        },
      );
    }

    if (request.method === "GET" && url.pathname === "/api/commands") {
      return sendJson(response, 200, { ok: true, data: listCommands() });
    }
    if (request.method === "GET" && url.pathname === "/api/telemetry") {
      return sendJson(response, 200, { ok: true, data: await getGpuTelemetry() });
    }
    if (request.method === "GET" && url.pathname === "/api/workspace") {
      return sendJson(response, 200, { ok: true, data: await inspectWorkspace() });
    }
    const alignedListMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/aligned$/);
    if (request.method === "GET" && alignedListMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await listAlignedAssets(alignedListMatch[1], {
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    const poseAtlasMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/pose-atlas$/);
    if (request.method === "GET" && poseAtlasMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await buildAlignedPoseAtlas(poseAtlasMatch[1]),
      });
    }
    const alignedAnnotationMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)\/annotation$/,
    );
    if (request.method === "GET" && alignedAnnotationMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await inspectAlignedAnnotation(
          alignedAnnotationMatch[1],
          alignedAnnotationMatch[2],
        ),
      });
    }
    if (request.method === "PUT" && alignedAnnotationMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await saveAlignedAnnotation(
          alignedAnnotationMatch[1],
          alignedAnnotationMatch[2],
          await readJsonBody(request),
        ),
      });
    }
    const alignedImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)$/,
    );
    if (request.method === "GET" && alignedImageMatch) {
      return streamAlignedImage(response, alignedImageMatch[1], alignedImageMatch[2]);
    }
    const quarantineListMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/quarantine$/);
    if (request.method === "GET" && quarantineListMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await listAlignedQuarantine(quarantineListMatch[1]),
      });
    }
    const quarantineImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)\/quarantine$/,
    );
    if (request.method === "POST" && quarantineImageMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await quarantineAlignedImage(
          quarantineImageMatch[1],
          quarantineImageMatch[2],
        ),
      });
    }
    const restoreImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/quarantine\/([0-9]{14}-[a-f0-9]{10})\/([^/]+)\/restore$/,
    );
    if (request.method === "POST" && restoreImageMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await restoreAlignedImage(
          restoreImageMatch[1],
          restoreImageMatch[2],
          restoreImageMatch[3],
        ),
      });
    }
    const workspaceImportMatch = url.pathname.match(/^\/api\/workspace\/import\/(src|dst)$/);
    if (request.method === "POST" && workspaceImportMatch) {
      const imported = await importWorkspaceVideo(workspaceImportMatch[1], request, {
        encodedFileName: request.headers["x-file-name"],
        replace: url.searchParams.get("replace") === "1",
      });
      return sendJson(response, 201, { ok: true, data: imported });
    }
    const workspaceArtifactMatch = url.pathname.match(
      /^\/api\/workspace\/artifacts\/(result(?:_mask)?\.(?:mp4|avi|mov))$/,
    );
    if (request.method === "GET" && workspaceArtifactMatch) {
      return sendVideoArtifact(
        request,
        response,
        resolveWorkspaceArtifact(workspaceArtifactMatch[1]),
      );
    }
    const commandPreflightMatch = url.pathname.match(
      /^\/api\/commands\/([a-z0-9._-]+)\/preflight$/i,
    );
    if (request.method === "POST" && commandPreflightMatch) {
      const body = await readJsonBody(request);
      const commandId = decodeURIComponent(commandPreflightMatch[1]);
      const prepared = await prepareCommand(commandId, {
        launchMode: body.launchMode,
        parameters: body.parameters,
      });
      return sendJson(response, 200, {
        ok: true,
        data: {
          commandId,
          launchMode: prepared.launchMode,
          parameters: prepared.parameters,
          profile: prepared.definition.profile,
          stage: prepared.definition.stage,
          locks: prepared.definition.locks,
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      return sendJson(response, 200, { ok: true, data: this.jobManager.list() });
    }
    if (request.method === "POST" && url.pathname === "/api/jobs/archive-completed") {
      return sendJson(response, 200, {
        ok: true,
        data: await this.jobManager.archiveCompleted(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readJsonBody(request);
      const job = await this.jobManager.start(body.commandId, {
        cols: body.cols,
        rows: body.rows,
        launchMode: body.launchMode,
        parameters: body.parameters,
      });
      return sendJson(response, 201, { ok: true, data: job });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && jobMatch) {
      return sendJson(response, 200, { ok: true, data: this.jobManager.get(jobMatch[1]) });
    }

    const eventMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/events$/i);
    if (request.method === "GET" && eventMatch) {
      const after = Math.max(Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0, 0);
      const events = await this.jobManager.eventsAfter(eventMatch[1], after);
      return sendJson(response, 200, { ok: true, data: events });
    }

    const inputMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/input$/i);
    if (request.method === "POST" && inputMatch) {
      const body = await readJsonBody(request);
      const job = await this.jobManager.sendInput(inputMatch[1], body.input);
      return sendJson(response, 200, { ok: true, data: job });
    }

    const controlMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/control$/i);
    if (request.method === "POST" && controlMatch) {
      const body = await readJsonBody(request);
      const job = await this.jobManager.control(controlMatch[1], body.operation);
      return sendJson(response, 200, { ok: true, data: job });
    }

    const retryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/retry$/i);
    if (request.method === "POST" && retryMatch) {
      const body = await readJsonBody(request);
      const job = await this.jobManager.retry(retryMatch[1], {
        cols: body.cols,
        rows: body.rows,
      });
      return sendJson(response, 201, { ok: true, data: job });
    }

    const previewMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/preview$/i);
    if (request.method === "GET" && previewMatch) {
      const job = this.jobManager.getInternal(previewMatch[1]);
      if (!(await pathExists(job.previewFile))) {
        return sendJson(response, 404, {
          ok: false,
          error: { code: "PREVIEW_NOT_READY", message: "训练预览尚未生成" },
        });
      }
      const [content, fileStat] = await Promise.all([readFile(job.previewFile), stat(job.previewFile)]);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": content.length,
        "Cache-Control": "no-cache",
        ETag: `"${Math.round(fileStat.mtimeMs)}-${fileStat.size}"`,
      });
      return response.end(content);
    }

    return sendJson(response, 404, {
      ok: false,
      error: { code: "API_NOT_FOUND", message: "接口不存在" },
    });
  }

  async serveStatic(request, response, url) {
    if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
      return sendJson(response, 405, {
        ok: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "方法不允许" },
      });
    }
    if (!(await pathExists(this.staticRoot))) {
      return sendJson(response, 404, {
        ok: false,
        error: { code: "STATIC_BUILD_MISSING", message: "前端尚未构建" },
      });
    }
    const requested = decodeURIComponent(url.pathname);
    const normalized = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
    let filePath = path.resolve(this.staticRoot, normalized);
    const staticRoot = path.resolve(this.staticRoot).toLocaleLowerCase("en-US");
    if (!filePath.toLocaleLowerCase("en-US").startsWith(`${staticRoot}${path.sep}`)) {
      return sendJson(response, 403, {
        ok: false,
        error: { code: "PATH_NOT_ALLOWED", message: "静态资源路径不允许" },
      });
    }
    if (!(await pathExists(filePath)) || (await stat(filePath)).isDirectory()) {
      filePath = path.join(this.staticRoot, "index.html");
    }
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (request.method === "HEAD") return response.end();
    return response.end(content);
  }

  async handleUpgrade(request, socket, head) {
    try {
      if (
        !isAllowedOrigin(request.headers.origin, this.allowedOrigins)
        || !this.requestHasSession(request)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      const jobId = url.searchParams.get("jobId");
      if (!jobId) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      this.jobManager.get(jobId);
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void this.attachWebSocket(webSocket, jobId, url);
      });
    } catch {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  async attachWebSocket(webSocket, jobId, url) {
    const after = Math.max(Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0, 0);
    const send = (value) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(value));
    };
    const listener = (event) => {
      if (event.jobId === jobId) send(event);
    };
    this.jobManager.on("event", listener);
    webSocket.once("close", () => this.jobManager.off("event", listener));
    webSocket.on("message", (raw) => {
      void (async () => {
        try {
          const message = JSON.parse(raw.toString("utf8"));
          if (message.type === "terminal.input") {
            await this.jobManager.sendInput(jobId, message.input);
          } else if (message.type === "terminal.resize") {
            this.jobManager.resize(jobId, message.cols, message.rows);
          } else if (message.type === "job.control") {
            await this.jobManager.control(jobId, message.operation);
          } else {
            throw new Error("不支持的 WebSocket 消息");
          }
        } catch (error) {
          send({
            jobId,
            sequence: 0,
            timestamp: new Date().toISOString(),
            type: "protocol.error",
            payload: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      })();
    });
    send({ type: "snapshot", payload: this.jobManager.get(jobId) });
    for (const event of await this.jobManager.eventsAfter(jobId, after)) send(event);
  }
}
