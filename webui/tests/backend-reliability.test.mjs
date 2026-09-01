import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LARGE_UPLOAD_REQUEST_TIMEOUT_MS,
  PROJECT_RESTART_RETRY_MS,
  RuntimeServer,
} from "../server/app-server.mjs";
import { JobManager } from "../server/job-manager.mjs";
import { ProjectManager } from "../server/project-manager.mjs";
import {
  classifyServiceExit,
  PLANNED_RESTART_EXIT_CODE,
} from "../scripts/local-manager.mjs";

function createStoredJob(directory, overrides = {}) {
  return {
    id: "job-reliability",
    commandId: "test.command",
    label: "Reliability test",
    shortLabel: "Test",
    profile: "current",
    category: "test",
    launchMode: "guided",
    parameters: {},
    controls: [],
    locks: [],
    state: "running",
    pid: 123,
    exitCode: null,
    signal: null,
    sequence: 0,
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    stopReason: null,
    commandLine: "test",
    error: null,
    latestPrompt: null,
    latestMetric: null,
    latestProgress: null,
    previewVersion: null,
    latestEvaluationSnapshotId: null,
    evaluation: null,
    directory,
    metadataFile: path.join(directory, "metadata.json"),
    eventsFile: path.join(directory, "events.ndjson"),
    controlFile: path.join(directory, "control.jsonl"),
    previewFile: path.join(directory, "preview.png"),
    runner: null,
    parser: null,
    events: [],
    writeChain: Promise.resolve(),
    metadataWriteChain: Promise.resolve(),
    metadataTimer: null,
    metadataScheduledPromise: null,
    metadataScheduledResolve: null,
    metadataScheduledReject: null,
    currentEventBytes: 0,
    eventSegmentIndex: 0,
    previewTimer: null,
    stopTimer: null,
    artifactPollPending: false,
    evaluationSnapshotIds: new Set(),
    ...overrides,
  };
}

test("planned exit 75 restarts immediately without increasing crash history", () => {
  const now = 10_000;
  const failures = [8_000, 9_000];
  const planned = classifyServiceExit({
    code: PLANNED_RESTART_EXIT_CODE,
    signal: null,
    failures,
    now,
  });
  assert.equal(planned.plannedRestart, true);
  assert.equal(planned.delay, 0);
  assert.equal(planned.shouldStopSupervisor, false);
  assert.deepEqual(planned.failures, failures);

  const crashed = classifyServiceExit({ code: 1, signal: null, failures, now });
  assert.equal(crashed.plannedRestart, false);
  assert.equal(crashed.delay, 2000);
  assert.deepEqual(crashed.failures, [...failures, now]);
});

test("project registry serializes concurrent creates and commits one unique record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-project-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    registryRoot: path.join(root, "registry"),
    registryFile: path.join(root, "registry", "projects.json"),
    managedRoot: path.join(root, "workspaces"),
    legacyWorkspace: path.join(root, "legacy"),
  };
  await mkdir(options.legacyWorkspace, { recursive: true });
  const first = new ProjectManager(options);
  const second = new ProjectManager(options);
  const results = await Promise.allSettled([
    first.create({ name: "Concurrent project", id: "concurrent-project" }),
    second.create({ name: "Concurrent project", id: "concurrent-project" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "PROJECT_EXISTS");
  const listed = await first.list();
  assert.equal(listed.projects.filter((project) => project.id === "concurrent-project").length, 1);
});

test("job logs rotate and reconnect reads remain bounded to the newest events", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-job-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new JobManager({
    eventSegmentBytes: 1024,
    eventReadLimit: 5,
    eventReadBytes: 2048,
    metadataWriter: async () => {},
  });
  const job = createStoredJob(root);
  manager.jobs.set(job.id, job);
  for (let index = 1; index <= 20; index += 1) {
    manager.record(job, "terminal.output", {
      index,
      data: `${String(index).padStart(2, "0")}:${"x".repeat(280)}`,
    });
  }
  await manager.waitForWrites(job.id);
  const files = await readdir(root);
  assert.ok(files.some((name) => /^events\.\d{6}\.ndjson$/.test(name)));
  const events = await manager.eventsAfter(job.id, 0);
  assert.deepEqual(events.map((event) => event.sequence), [16, 17, 18, 19, 20]);
  assert.deepEqual(events.map((event) => event.payload.index), [16, 17, 18, 19, 20]);
});

test("metadata writes coalesce during output bursts and force-flush terminal state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-job-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writes = [];
  const manager = new JobManager({
    metadataFlushMs: 30,
    metadataWriter: async (_target, value) => {
      writes.push({ state: value.state, sequence: value.sequence });
    },
  });
  const job = createStoredJob(root);
  manager.jobs.set(job.id, job);
  job.sequence = 1;
  await Promise.all(Array.from({ length: 8 }, () => manager.persist(job)));
  assert.equal(writes.length, 1);
  job.state = "succeeded";
  job.sequence = 2;
  await manager.persist(job, { force: true });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.at(-1), { state: "succeeded", sequence: 2 });
});

class StubJobManager extends EventEmitter {
  constructor(jobs = []) {
    super();
    this.jobs = jobs;
    this.flushCount = 0;
  }

  async initialize() {}

  list() {
    return this.jobs;
  }

  activeJobs() {
    return this.jobs.filter((job) => ["queued", "starting", "running", "waiting_input", "stopping"].includes(job.state));
  }

  async flushAll() {
    this.flushCount += 1;
  }
}

const stubOperationManager = () => ({
  initialize: async () => {},
  list: () => [],
  get: () => null,
  cancel: async () => null,
});

test("runtime grants loopback video imports a long request window", async (t) => {
  const jobManager = new StubJobManager();
  const server = new RuntimeServer({
    jobManager,
    operationManager: stubOperationManager(),
    trainingEvaluationManager: { initialize: async () => {} },
  });
  t.after(() => server.stop());
  await server.start({ host: "127.0.0.1", port: 0 });
  assert.equal(server.httpServer.requestTimeout, LARGE_UPLOAD_REQUEST_TIMEOUT_MS);
  assert.ok(server.httpServer.requestTimeout > 5 * 60 * 1000);
});

test("planned runtime restart refuses to abandon active jobs", async () => {
  const activeManager = new StubJobManager([{ id: "active-1", state: "running" }]);
  const activeServer = new RuntimeServer({ jobManager: activeManager });
  await assert.rejects(
    () => activeServer.stop({ plannedRestart: true }),
    (error) => error.code === "RUNTIME_RESTART_JOB_BUSY" && error.details.jobIds[0] === "active-1",
  );

  let exitCode = null;
  const idleManager = new StubJobManager();
  const idleServer = new RuntimeServer({
    jobManager: idleManager,
    requestProcessExit: (code) => {
      exitCode = code;
    },
  });
  idleServer.scheduleProjectRestart({ restartRequired: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(exitCode, PLANNED_RESTART_EXIT_CODE);
  assert.equal(idleManager.flushCount, 1);
});

test("scheduled project restart waits for active work and retries without warning spam", async () => {
  const jobs = new StubJobManager([{ id: "active-1", state: "running" }]);
  let warnings = 0;
  jobs.on("warning", () => {
    warnings += 1;
  });
  let exitCode = null;
  const server = new RuntimeServer({
    jobManager: jobs,
    operationManager: stubOperationManager(),
    projectRestartRetryMs: 500,
    requestProcessExit: (code) => {
      exitCode = code;
    },
  });
  server.scheduleProjectRestart({ restartRequired: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(exitCode, null);
  assert.equal(server.projectRestartPending, true);
  assert.equal(warnings, 1);

  jobs.jobs[0].state = "succeeded";
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(exitCode, PLANNED_RESTART_EXIT_CODE);
  assert.equal(jobs.flushCount, 1);
  assert.equal(warnings, 1);
  assert.ok(PROJECT_RESTART_RETRY_MS >= 1_000);
});

test("planned runtime restart refuses to interrupt background operations", async () => {
  const operationManager = {
    ...stubOperationManager(),
    list: () => [{ id: "op-active", status: "running" }],
  };
  const server = new RuntimeServer({
    jobManager: new StubJobManager(),
    operationManager,
  });
  await assert.rejects(
    () => server.stop({ plannedRestart: true }),
    (error) => error.code === "RUNTIME_RESTART_OPERATION_BUSY"
      && error.details.operationIds[0] === "op-active",
  );
});
