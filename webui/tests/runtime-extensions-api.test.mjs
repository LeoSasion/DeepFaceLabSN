import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeServer, SUPPORTED_OPERATION_KINDS } from "../server/app-server.mjs";
import { OperationManager } from "../server/operation-manager.mjs";

class ApiJobManager extends EventEmitter {
  async initialize() {}

  list() {
    return [];
  }

  activeJobs() {
    return [];
  }

  async flushAll() {}
}

async function jsonRequest(baseUrl, pathname, { method = "GET", cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? null,
    body: await response.json(),
  };
}

test("runtime exposes fixed operations, system snapshots, material recovery, and preflight resources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-runtime-extensions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationManager = new OperationManager({ root: path.join(root, "operations") });
  const server = new RuntimeServer({
    jobManager: new ApiJobManager(),
    operationManager,
    trainingEvaluationManager: { initialize: async () => {} },
    commandPreparer: async (commandId, options) => ({
      launchMode: options.launchMode ?? "guided",
      parameters: options.parameters ?? {},
      definition: { profile: "legacy", stage: "train", locks: ["model"] },
      preflight: {
        resources: {
          available: true,
          mode: "gpu",
          recommendation: { resolution: 160, batchSize: 4 },
        },
        evaluation: null,
      },
      commandId,
    }),
  });
  t.after(() => server.stop());

  let requiredBytesSeen = null;
  server.inspectSystemStorage = async (requiredBytes) => {
    requiredBytesSeen = requiredBytes;
    return { requiredBytes, ready: true, usableBytes: 10_000 };
  };
  server.buildSystemDiagnostic = async () => ({
    schemaVersion: 1,
    product: { name: "DeepFaceLabSN", version: "test" },
    workspace: { projectId: "default" },
    jobs: [],
  });
  server.listMaterialArchives = async (side) => [{ side, token: "20260831123456-0123456789" }];
  let restored = null;
  server.restoreMaterialArchive = async (side, token) => {
    restored = { side, token };
    return { side, token, undoToken: null };
  };

  assert.deepEqual(SUPPORTED_OPERATION_KINDS, [
    "asset-audit",
    "pose-atlas",
    "similarity",
    "pack",
    "coverage",
    "detect-scenes",
  ]);
  assert.throws(
    () => server.operationSpec({ kind: "arbitrary-command", side: "src" }),
    (error) => error.code === "OPERATION_KIND_NOT_ALLOWED",
  );
  assert.equal(server.operationSpec({ kind: "detect-scenes", side: "dst" }).cancellable, false);

  const address = await server.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await jsonRequest(baseUrl, "/api/health");
  assert.equal(health.status, 200);
  assert.ok(health.cookie);

  const invalidOperation = await jsonRequest(baseUrl, "/api/operations", {
    method: "POST",
    cookie: health.cookie,
    body: { kind: "shell", side: "src" },
  });
  assert.equal(invalidOperation.status, 400);
  assert.equal(invalidOperation.body.error.code, "OPERATION_KIND_NOT_ALLOWED");

  server.operationSpec = (body) => ({
    kind: body.kind,
    side: body.side,
    label: "API cancellation test",
    stage: "分析素材质量",
    cancellable: true,
    run: ({ signal, onProgress }) => new Promise((resolve, reject) => {
      onProgress({
        stage: "audit-samples",
        current: 3,
        total: 10,
        percent: 30,
        detail: "sample-0003.jpg",
      });
      const timer = setTimeout(() => resolve({ completed: true }), 5_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    }),
  });
  const started = await jsonRequest(baseUrl, "/api/operations", {
    method: "POST",
    cookie: health.cookie,
    body: { kind: "asset-audit", side: "src" },
  });
  assert.equal(started.status, 202);
  assert.match(started.body.data.id, /^op-/);
  const operationId = started.body.data.id;
  let progress = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    progress = await jsonRequest(baseUrl, `/api/operations/${operationId}`);
    if (progress.body.data.current === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(progress.body.data.stage, "分析素材质量");
  assert.equal(progress.body.data.current, 3);
  assert.equal(progress.body.data.total, 10);
  assert.equal(progress.body.data.percent, 30);
  assert.equal(progress.body.data.detail, "sample-0003.jpg");
  const cancelled = await jsonRequest(baseUrl, `/api/operations/${operationId}/cancel`, {
    method: "POST",
    cookie: health.cookie,
  });
  assert.equal(cancelled.status, 200);
  await operationManager.wait(operationId);
  const operation = await jsonRequest(baseUrl, `/api/operations/${operationId}`);
  assert.equal(operation.body.data.status, "cancelled");
  const operations = await jsonRequest(baseUrl, "/api/operations");
  assert.equal(operations.body.data.length, 1);
  assert.equal(Object.hasOwn(operations.body.data[0], "controller"), false);

  const storage = await jsonRequest(baseUrl, "/api/system/storage?requiredBytes=4096");
  assert.equal(storage.status, 200);
  assert.equal(requiredBytesSeen, 4096);
  const invalidStorage = await jsonRequest(baseUrl, "/api/system/storage?requiredBytes=-1");
  assert.equal(invalidStorage.status, 400);
  assert.equal(invalidStorage.body.error.code, "REQUIRED_BYTES_INVALID");
  const diagnostics = await jsonRequest(baseUrl, "/api/system/diagnostics");
  assert.equal(diagnostics.body.data.schemaVersion, 1);

  const archives = await jsonRequest(baseUrl, "/api/workspace/material-archives/src");
  assert.equal(archives.body.data[0].side, "src");
  const restore = await jsonRequest(
    baseUrl,
    "/api/workspace/material-archives/src/20260831123456-0123456789/restore",
    { method: "POST", cookie: health.cookie },
  );
  assert.equal(restore.status, 200);
  assert.deepEqual(restored, { side: "src", token: "20260831123456-0123456789" });

  const preflight = await jsonRequest(baseUrl, "/api/commands/saehd.train/preflight", {
    method: "POST",
    cookie: health.cookie,
    body: { launchMode: "guided", parameters: { resolution: 160 } },
  });
  assert.equal(preflight.status, 200);
  assert.deepEqual(preflight.body.data.resources.recommendation, { resolution: 160, batchSize: 4 });
});
