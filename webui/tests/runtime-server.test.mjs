import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { RuntimeServer } from "../server/app-server.mjs";

class FakeJobManager extends EventEmitter {
  constructor() {
    super();
    this.job = {
      id: "fake-job-1",
      commandId: "src.extract_frames",
      label: "提取 SRC 视频帧",
      state: "running",
      sequence: 0,
    };
    this.lastStart = null;
  }

  async initialize() {}
  list() { return [this.job]; }
  get(jobId) {
    if (jobId !== this.job.id) {
      const error = new Error("任务不存在");
      error.status = 404;
      throw error;
    }
    return this.job;
  }
  async start(commandId, options) {
    this.lastStart = { commandId, options };
    return { ...this.job, commandId };
  }
  async eventsAfter() { return []; }
  async sendInput() { return this.job; }
  resize() { return true; }
  async control() { return this.job; }
  async archiveCompleted() { return { archived: 1, path: "archive" }; }
}

class FakeTrainingEvaluationManager {
  async initialize() {}
  async listManifests(modelKey) {
    return { modelKey, activeManifestId: "a".repeat(24), manifests: [] };
  }
  async listSnapshots(modelKey) {
    return { modelKey, snapshots: [] };
  }
  async getSnapshot(modelKey, snapshotId) {
    return { modelKey, snapshotId, iteration: 8000, samples: [] };
  }
}

function waitForWebSocketMessage(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    webSocket.once("error", reject);
  });
}

test("runtime server issues a loopback session and protects writes/WebSocket", async (t) => {
  const jobManager = new FakeJobManager();
  const server = new RuntimeServer({
    jobManager,
    trainingEvaluationManager: new FakeTrainingEvaluationManager(),
  });
  const address = await server.start({ port: 0 });
  t.after(() => server.stop());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const origin = "http://127.0.0.1:4173";

  await assert.rejects(
    server.withWorkspaceMutation("测试修改", async () => true),
    (error) => error.code === "WORKSPACE_JOB_BUSY" && error.status === 409,
  );

  const healthResponse = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: origin },
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.data.loopbackOnly, true);
  assert.equal(health.data.capabilities.pty, true);
  const cookie = healthResponse.headers.get("set-cookie").split(";")[0];

  const forbidden = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ commandId: "src.extract_frames" }),
  });
  assert.equal(forbidden.status, 403);

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
    },
    body: JSON.stringify({
      commandId: "src.extract_frames",
      launchMode: "guided",
      parameters: { outputExt: "png", fps: 0 },
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(jobManager.lastStart.options.launchMode, "guided");
  assert.deepEqual(jobManager.lastStart.options.parameters, { outputExt: "png", fps: 0 });

  const invalidPreflight = await fetch(
    `${baseUrl}/api/commands/src.extract_frames/preflight`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({
        launchMode: "guided",
        parameters: { arbitrary: "not allowed" },
      }),
    },
  );
  assert.equal(invalidPreflight.status, 400);
  const invalidPreflightBody = await invalidPreflight.json();
  assert.equal(invalidPreflightBody.error.code, "PARAMETER_NOT_ALLOWED");

  const workspaceResponse = await fetch(`${baseUrl}/api/workspace`, {
    headers: { Origin: origin },
  });
  assert.equal(workspaceResponse.status, 200);
  const workspaceBody = await workspaceResponse.json();
  assert.ok(Object.hasOwn(workspaceBody.data.materials, "src"));

  const evaluationManifestsResponse = await fetch(
    `${baseUrl}/api/training-evaluations/web-smoke/manifests`,
    { headers: { Origin: origin } },
  );
  assert.equal(evaluationManifestsResponse.status, 200);
  assert.equal((await evaluationManifestsResponse.json()).data.modelKey, "web-smoke");
  const evaluationSnapshotsResponse = await fetch(
    `${baseUrl}/api/training-evaluations/web-smoke/snapshots`,
    { headers: { Origin: origin } },
  );
  assert.equal(evaluationSnapshotsResponse.status, 200);
  const evaluationSnapshotResponse = await fetch(
    `${baseUrl}/api/training-evaluations/web-smoke/snapshots/iter-00008000-abcdef12`,
    { headers: { Origin: origin } },
  );
  assert.equal(evaluationSnapshotResponse.status, 200);
  assert.equal((await evaluationSnapshotResponse.json()).data.iteration, 8000);

  const auditResponse = await fetch(`${baseUrl}/api/tools/assets/src/audit`, {
    headers: { Origin: origin },
  });
  assert.equal(auditResponse.status, 200);
  const auditBody = await auditResponse.json();
  assert.equal(auditBody.data.side, "src");
  assert.ok(auditBody.data.analyzedCount <= 500);
  const auditPageResponse = await fetch(`${baseUrl}/api/tools/assets/src/audit?offset=1&limit=1`, {
    headers: { Origin: origin },
  });
  assert.equal(auditPageResponse.status, 200);
  const auditPageBody = await auditPageResponse.json();
  assert.equal(auditPageBody.data.offset, 1);
  assert.equal(auditPageBody.data.items.length, 1);

  const coverageResponse = await fetch(`${baseUrl}/api/tools/assets/dst/coverage`, {
    headers: { Origin: origin },
  });
  assert.equal(coverageResponse.status, 200);
  const coverageBody = await coverageResponse.json();
  assert.equal(coverageBody.data.side, "dst");
  const coveragePageResponse = await fetch(`${baseUrl}/api/tools/assets/dst/coverage?offset=1&limit=1`, {
    headers: { Origin: origin },
  });
  assert.equal(coveragePageResponse.status, 200);
  const coveragePageBody = await coveragePageResponse.json();
  assert.equal(coveragePageBody.data.offset, 1);
  assert.equal(coveragePageBody.data.items.length, 1);

  const mergeReviewResponse = await fetch(`${baseUrl}/api/tools/merge-review?limit=3`, {
    headers: { Origin: origin },
  });
  assert.equal(mergeReviewResponse.status, 200);
  const mergeReviewBody = await mergeReviewResponse.json();
  assert.ok(mergeReviewBody.data.items.length <= 3);
  const mergeReviewPageResponse = await fetch(`${baseUrl}/api/tools/merge-review?offset=1&limit=1`, {
    headers: { Origin: origin },
  });
  assert.equal(mergeReviewPageResponse.status, 200);
  const mergeReviewPageBody = await mergeReviewPageResponse.json();
  assert.equal(mergeReviewPageBody.data.offset, 1);
  assert.equal(mergeReviewPageBody.data.items.length, 1);
  if (mergeReviewBody.data.items[0]) {
    const reviewImageResponse = await fetch(
      `${baseUrl}${mergeReviewBody.data.items[0].sourceUrl}`,
      { headers: { Origin: origin } },
    );
    assert.equal(reviewImageResponse.status, 200);
    assert.match(reviewImageResponse.headers.get("content-type"), /^image\//);
  }

  const exportResponse = await fetch(`${baseUrl}/api/tools/export-preflight`, {
    headers: { Origin: origin },
  });
  assert.equal(exportResponse.status, 200);
  const exportBody = await exportResponse.json();
  assert.equal(typeof exportBody.data.readyCount, "number");

  if (workspaceBody.data.materials.src) {
    const materialResponse = await fetch(`${baseUrl}/api/workspace/materials/src`, {
      headers: { Origin: origin, Range: "bytes=0-31" },
    });
    assert.equal(materialResponse.status, 206);
    assert.equal((await materialResponse.arrayBuffer()).byteLength, 32);
  }

  const telemetryResponse = await fetch(`${baseUrl}/api/telemetry`, {
    headers: { Origin: origin },
  });
  assert.equal(telemetryResponse.status, 200);
  const telemetryBody = await telemetryResponse.json();
  assert.ok(Array.isArray(telemetryBody.data.gpus));

  const archived = await fetch(`${baseUrl}/api/jobs/archive-completed`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
  });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).data.archived, 1);

  const webSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?jobId=fake-job-1`, {
    headers: { Cookie: cookie, Origin: origin },
  });
  t.after(() => webSocket.close());
  const snapshot = await waitForWebSocketMessage(webSocket);
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.payload.id, "fake-job-1");

  const foreignOrigin = await fetch(`${baseUrl}/api/jobs`, {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(foreignOrigin.status, 403);

  const foreignLoopbackOrigin = await fetch(`${baseUrl}/api/jobs`, {
    headers: { Origin: "http://127.0.0.1:4999" },
  });
  assert.equal(foreignLoopbackOrigin.status, 403);
});
