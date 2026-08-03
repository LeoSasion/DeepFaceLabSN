import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildCommand,
  formatCommand,
  getCommandDefinition,
  prepareCommand,
} from "./command-registry.mjs";
import { OutputParser } from "./output-parser.mjs";
import {
  PATHS,
  ensureRuntimeDirectories,
  jobDirectory,
  pathExists,
  readJson,
  writeJsonAtomic,
} from "./paths.mjs";
import { createPtyRunner } from "./pty-runner.mjs";
import { TrainingEvaluationManager } from "./training-evaluation-manager.mjs";

const ACTIVE_STATES = new Set(["queued", "starting", "running", "waiting_input", "stopping"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "orphaned"]);
const ALLOWED_CONTROL_OPERATIONS = new Set([
  "save",
  "backup",
  "preview",
  "evaluate",
  "close",
  "force-kill",
]);
const MAX_EVENTS_IN_MEMORY = 1000;
const MAX_INPUT_LENGTH = 8192;
const SAFE_STOP_GRACE_MS = 12_000;

export class JobError extends Error {
  constructor(message, code = "JOB_ERROR", status = 400, details) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function createJobId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function publicJob(job) {
  return {
    id: job.id,
    commandId: job.commandId,
    label: job.label,
    shortLabel: job.shortLabel,
    profile: job.profile,
    category: job.category,
    launchMode: job.launchMode,
    parameters: job.parameters,
    controls: job.controls,
    locks: job.locks,
    state: job.state,
    pid: job.pid,
    exitCode: job.exitCode,
    signal: job.signal,
    sequence: job.sequence,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    stopReason: job.stopReason,
    commandLine: job.commandLine,
    error: job.error,
    latestPrompt: job.latestPrompt,
    latestMetric: job.latestMetric,
    latestProgress: job.latestProgress,
    previewVersion: job.previewVersion,
    latestEvaluationSnapshotId: job.latestEvaluationSnapshotId,
    evaluation: job.evaluation,
    paths: {
      jobDirectory: job.directory,
      events: job.eventsFile,
      preview: job.previewFile,
    },
  };
}

function metadataFromJob(job) {
  return publicJob(job);
}

export class JobManager extends EventEmitter {
  constructor({
    runnerFactory = createPtyRunner,
    trainingEvaluationManager = new TrainingEvaluationManager(),
    now = () => new Date(),
  } = {}) {
    super();
    this.runnerFactory = runnerFactory;
    this.trainingEvaluationManager = trainingEvaluationManager;
    this.now = now;
    this.jobs = new Map();
    this.locks = new Map();
  }

  async initialize() {
    await Promise.all([
      ensureRuntimeDirectories(),
      this.trainingEvaluationManager.initialize(),
    ]);
    const entries = await readdir(PATHS.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = jobDirectory(entry.name);
      const metadataFile = path.join(directory, "metadata.json");
      if (!(await pathExists(metadataFile))) continue;
      try {
        const metadata = await readJson(metadataFile);
        const job = {
          ...metadata,
          directory,
          metadataFile,
          eventsFile: path.join(directory, "events.ndjson"),
          controlFile: path.join(directory, "control.jsonl"),
          previewFile: path.join(directory, "preview.png"),
          runner: null,
          parser: new OutputParser(),
          events: [],
          writeChain: Promise.resolve(),
          metadataWriteChain: Promise.resolve(),
          previewTimer: null,
          stopTimer: null,
          artifactPollPending: false,
          evaluationSnapshotIds: new Set(metadata.evaluation?.existingSnapshotIds ?? []),
        };
        if (ACTIVE_STATES.has(job.state)) {
          job.state = "orphaned";
          job.error = "本地服务曾重启，无法重新取得原 ConPTY 的控制权";
          job.endedAt = this.now().toISOString();
          await writeJsonAtomic(metadataFile, metadataFromJob(job));
        }
        this.jobs.set(job.id, job);
      } catch (error) {
        this.emit("warning", { message: `无法恢复任务 ${entry.name}`, error });
      }
    }
    return this;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicJob);
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobError("任务不存在", "JOB_NOT_FOUND", 404);
    return publicJob(job);
  }

  getInternal(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobError("任务不存在", "JOB_NOT_FOUND", 404);
    return job;
  }

  async start(commandId, options = {}) {
    if (!getCommandDefinition(commandId)) {
      throw new JobError("不支持的命令", "COMMAND_NOT_ALLOWED", 400);
    }

    const { definition, launchMode, parameters, preflight } = await prepareCommand(commandId, {
      launchMode: options.launchMode,
      parameters: options.parameters,
      trainingEvaluationManager: this.trainingEvaluationManager,
    });
    const id = createJobId();
    this.acquireLocks(id, definition.locks);
    const directory = jobDirectory(id);
    const context = {
      jobId: id,
      jobDirectory: directory,
      controlFile: path.join(directory, "control.jsonl"),
      previewFile: path.join(directory, "preview.png"),
      launchMode,
      parameters,
      preflight,
    };
    let launch;
    try {
      await mkdir(directory, { recursive: true });
      ({ launch } = buildCommand(definition, context));
    } catch (error) {
      this.releaseLocks({ id, locks: definition.locks });
      throw error;
    }

    const createdAt = this.now().toISOString();
    const job = {
      id,
      commandId,
      label: definition.label,
      shortLabel: definition.shortLabel,
      profile: definition.profile,
      category: definition.category,
      launchMode,
      parameters,
      controls: definition.controls.filter((operation) => (
        operation !== "evaluate" || launch.evaluation?.enabled
      )),
      locks: [...definition.locks],
      state: "starting",
      pid: null,
      exitCode: null,
      signal: null,
      sequence: 0,
      createdAt,
      startedAt: null,
      endedAt: null,
      stopReason: null,
      commandLine: formatCommand(launch.executable, launch.args),
      error: null,
      latestPrompt: null,
      latestMetric: null,
      latestProgress: null,
      previewVersion: null,
      latestEvaluationSnapshotId: null,
      evaluation: launch.evaluation ?? null,
      directory,
      metadataFile: path.join(directory, "metadata.json"),
      eventsFile: path.join(directory, "events.ndjson"),
      controlFile: context.controlFile,
      previewFile: context.previewFile,
      runner: null,
      parser: new OutputParser(),
      events: [],
      writeChain: Promise.resolve(),
      metadataWriteChain: Promise.resolve(),
      previewTimer: null,
      stopTimer: null,
      artifactPollPending: false,
      evaluationSnapshotIds: new Set(launch.evaluation?.existingSnapshotIds ?? []),
    };
    this.jobs.set(id, job);
    try {
      await this.persist(job);
    } catch (error) {
      this.jobs.delete(id);
      this.releaseLocks(job);
      throw new JobError("无法创建任务元数据", "JOB_PERSIST_FAILED", 500);
    }
    this.record(job, "job.state", { state: "starting" });
    this.record(job, "terminal.output", {
      data: `\u001b[38;2;44;227;159m[WEB]\u001b[0m ${definition.label}\r\n`,
    });
    this.record(job, "terminal.output", {
      data: `\u001b[38;2;126;145;136m[CMD]\u001b[0m ${job.commandLine}\r\n\r\n`,
    });

    try {
      const runner = this.runnerFactory({
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        cols: Number.isInteger(options.cols) ? Math.min(Math.max(options.cols, 40), 300) : 120,
        rows: Number.isInteger(options.rows) ? Math.min(Math.max(options.rows, 12), 100) : 30,
      });
      job.runner = runner;
      job.pid = runner.pid ?? null;
      job.startedAt = this.now().toISOString();
      job.state = "running";
      runner.onData((data) => this.handleOutput(job, data));
      runner.onExit(({ exitCode, signal }) => {
        void this.handleExit(job, exitCode, signal);
      });
      if (job.category === "training") this.startPreviewWatcher(job);
      this.record(job, "job.state", { state: "running", pid: job.pid });
      await this.persist(job);
      return publicJob(job);
    } catch (error) {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.endedAt = this.now().toISOString();
      const runner = job.runner;
      job.runner = null;
      runner?.kill?.();
      this.releaseLocks(job);
      this.record(job, "job.state", { state: "failed", error: job.error });
      await this.persist(job);
      throw new JobError(`无法启动任务：${job.error}`, "PROCESS_START_FAILED", 500);
    }
  }

  handleOutput(job, data) {
    if (!data) return;
    this.record(job, "terminal.output", { data: String(data).slice(0, 65536) });
    for (const parsed of job.parser.push(data)) {
      if (parsed.type === "terminal.prompt") {
        job.latestPrompt = parsed.payload.prompt;
        if (job.state === "running") job.state = "waiting_input";
      }
      if (parsed.type === "job.metric") {
        const targetIterations = job.parameters?.targetIterations;
        const iterationTimeMs = parsed.payload.iterationTimeMs;
        parsed.payload = {
          ...parsed.payload,
          targetIterations: Number.isInteger(targetIterations) ? targetIterations : null,
          iterationsPerHour: iterationTimeMs > 0 ? 3_600_000 / iterationTimeMs : null,
          etaSeconds: (
            iterationTimeMs > 0
            && Number.isInteger(targetIterations)
            && targetIterations > parsed.payload.iteration
          )
            ? ((targetIterations - parsed.payload.iteration) * iterationTimeMs) / 1000
            : targetIterations && targetIterations <= parsed.payload.iteration ? 0 : null,
        };
        job.latestMetric = parsed.payload;
      }
      if (parsed.type === "job.progress") {
        parsed.payload = {
          ...parsed.payload,
          updatedAt: this.now().toISOString(),
        };
        job.latestProgress = parsed.payload;
      }
      if (parsed.type === "job.error") job.error = parsed.payload.message;
      this.record(job, parsed.type, parsed.payload);
    }
    void this.persist(job);
  }

  async handleExit(job, exitCode, signal) {
    if (TERMINAL_STATES.has(job.state)) return;
    job.exitCode = exitCode;
    job.signal = signal;
    job.endedAt = this.now().toISOString();
    if (exitCode === 0 && !job.error && !job.stopReason) {
      const definition = getCommandDefinition(job.commandId);
      try {
        await definition?.postflight?.();
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        this.record(job, "terminal.output", {
          data: `\r\n\u001b[38;2;255;122;122m[WEB]\u001b[0m 产物校验失败：${job.error}\r\n`,
        });
        this.record(job, "job.error", {
          message: job.error,
          code: error?.code ?? "POSTFLIGHT_FAILED",
          details: error?.details,
        });
      }
    }
    job.state = job.stopReason
      ? "cancelled"
      : exitCode === 0 && !job.error
        ? "succeeded"
        : "failed";
    if (job.previewTimer) clearInterval(job.previewTimer);
    job.previewTimer = null;
    if (job.stopTimer) clearTimeout(job.stopTimer);
    job.stopTimer = null;
    job.runner?.dispose?.();
    job.runner = null;
    this.releaseLocks(job);
    this.record(job, "job.finished", {
      state: job.state,
      exitCode,
      signal,
      stopReason: job.stopReason,
    });
    await this.persist(job);
  }

  async sendInput(jobId, input) {
    const job = this.getInternal(jobId);
    if (!job.runner || !ACTIVE_STATES.has(job.state)) {
      throw new JobError("任务当前不接受输入", "JOB_NOT_INTERACTIVE", 409);
    }
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_LENGTH) {
      throw new JobError("终端输入长度不合法", "INVALID_TERMINAL_INPUT", 400);
    }
    job.runner.write(input);
    job.latestPrompt = null;
    if (job.state === "waiting_input") {
      job.state = "running";
      this.record(job, "job.state", { state: "running" });
    }
    this.record(job, "terminal.input", { length: input.length });
    await this.persist(job);
    return publicJob(job);
  }

  resize(jobId, cols, rows) {
    const job = this.getInternal(jobId);
    if (!job.runner) return false;
    const safeCols = Math.min(Math.max(Number.parseInt(cols, 10) || 120, 40), 300);
    const safeRows = Math.min(Math.max(Number.parseInt(rows, 10) || 30, 12), 100);
    job.runner.resize(safeCols, safeRows);
    return true;
  }

  async control(jobId, operation) {
    const job = this.getInternal(jobId);
    if (!ALLOWED_CONTROL_OPERATIONS.has(operation)) {
      throw new JobError("不支持的控制操作", "CONTROL_NOT_ALLOWED", 400);
    }
    if (!job.runner || !ACTIVE_STATES.has(job.state)) {
      throw new JobError("任务已经结束，不能继续控制", "JOB_NOT_RUNNING", 409);
    }
    if (operation === "force-kill") {
      job.stopReason = "force-kill";
      job.state = "stopping";
      if (job.stopTimer) clearTimeout(job.stopTimer);
      job.stopTimer = null;
      this.record(job, "job.state", { state: "stopping", operation });
      job.runner.kill();
      await this.persist(job);
      return publicJob(job);
    }
    if (!job.controls.includes(operation)) {
      throw new JobError("该任务不支持此控制操作", "CONTROL_NOT_SUPPORTED", 409);
    }

    if (operation === "close" && job.state === "waiting_input") {
      job.stopReason = "safe-stop-before-start";
      job.state = "stopping";
      this.record(job, "job.state", {
        state: "stopping",
        operation,
        stopReason: job.stopReason,
      });
      this.record(job, "terminal.output", {
        data: "\r\n\u001b[38;2;240;199;91m[WEB]\u001b[0m 训练尚未开始，已结束当前模型创建问答；此阶段没有需要保存的模型。\r\n",
      });
      job.runner.kill();
      await this.persist(job);
      return publicJob(job);
    }

    await appendFile(
      job.controlFile,
      `${JSON.stringify({ operation, requestedAt: this.now().toISOString() })}\n`,
      "utf8",
    );
    if (operation === "close") {
      job.stopReason = "safe-stop";
      job.state = "stopping";
      this.record(job, "job.state", {
        state: "stopping",
        operation,
        stopReason: job.stopReason,
      });
      if (job.stopTimer) clearTimeout(job.stopTimer);
      job.stopTimer = setTimeout(() => {
        if (!job.runner || TERMINAL_STATES.has(job.state)) return;
        job.stopReason = "safe-stop-timeout";
        this.record(job, "terminal.output", {
          data: "\r\n\u001b[38;2;240;199;91m[WEB]\u001b[0m Trainer 在 12 秒内未响应安全停止，已自动结束进程，避免任务永久停留。\r\n",
        });
        job.runner.kill();
        void this.persist(job);
      }, SAFE_STOP_GRACE_MS);
      job.stopTimer.unref?.();
    }
    this.record(job, "job.control", { operation });
    await this.persist(job);
    return publicJob(job);
  }

  async eventsAfter(jobId, after = 0) {
    const job = this.getInternal(jobId);
    if (!(await pathExists(job.eventsFile))) return [];
    const text = await readFile(job.eventsFile, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event && event.sequence > after);
  }

  async waitForWrites(jobId) {
    const job = this.getInternal(jobId);
    await job.writeChain;
  }

  async archiveCompleted() {
    const completed = [...this.jobs.values()].filter((job) => TERMINAL_STATES.has(job.state));
    if (!completed.length) return { archived: 0, path: null };
    const archiveDirectory = path.join(
      PATHS.archiveRoot,
      "jobs",
      new Date().toISOString().replace(/\D/g, "").slice(0, 14),
    );
    await mkdir(archiveDirectory, { recursive: true });
    let archived = 0;
    for (const job of completed) {
      await Promise.all([job.writeChain, job.metadataWriteChain]);
      await rename(job.directory, path.join(archiveDirectory, job.id));
      this.jobs.delete(job.id);
      archived += 1;
    }
    return { archived, path: archiveDirectory };
  }

  acquireLocks(jobId, requestedLocks) {
    const conflicts = requestedLocks
      .map((lock) => ({ lock, owner: this.locks.get(lock) }))
      .filter(({ owner }) => owner);
    if (conflicts.length) {
      throw new JobError(
        `资源正在被任务 ${conflicts[0].owner} 使用`,
        "RESOURCE_LOCKED",
        409,
        { conflicts },
      );
    }
    for (const lock of requestedLocks) this.locks.set(lock, jobId);
  }

  releaseLocks(job) {
    for (const lock of job.locks) {
      if (this.locks.get(lock) === job.id) this.locks.delete(lock);
    }
  }

  startPreviewWatcher(job) {
    let previousMtime = 0;
    job.previewTimer = setInterval(async () => {
      if (job.artifactPollPending) return;
      job.artifactPollPending = true;
      let changed = false;
      try {
        const fileStat = await stat(job.previewFile);
        if (fileStat.mtimeMs > previousMtime) {
          previousMtime = fileStat.mtimeMs;
          job.previewVersion = Math.round(fileStat.mtimeMs);
          this.record(job, "job.artifact", {
            kind: "preview",
            version: job.previewVersion,
          });
          changed = true;
        }
      } catch {
        // Preview is optional until the first Trainer "show" message arrives.
      }
      if (job.evaluation?.enabled) {
        try {
          const result = await this.trainingEvaluationManager.listSnapshots(
            job.evaluation.modelKey,
          );
          for (const snapshot of [...result.snapshots].reverse()) {
            if (job.evaluationSnapshotIds.has(snapshot.snapshotId)) continue;
            job.evaluationSnapshotIds.add(snapshot.snapshotId);
            job.latestEvaluationSnapshotId = snapshot.snapshotId;
            this.record(job, "job.artifact", {
              kind: "training-evaluation",
              ...snapshot,
            });
            changed = true;
          }
        } catch (error) {
          this.emit("warning", { message: "无法读取训练姿态评测快照", error });
        }
      }
      try {
        if (changed) await this.persist(job);
      } catch (error) {
        this.emit("warning", { message: "无法保存训练产物状态", error });
      } finally {
        job.artifactPollPending = false;
      }
    }, 1500);
    job.previewTimer.unref?.();
  }

  async retry(jobId, options = {}) {
    const previous = this.getInternal(jobId);
    if (ACTIVE_STATES.has(previous.state)) {
      throw new JobError("运行中的任务不能重试", "JOB_STILL_RUNNING", 409);
    }
    return this.start(previous.commandId, {
      launchMode: previous.launchMode,
      parameters: previous.parameters,
      cols: options.cols,
      rows: options.rows,
    });
  }

  record(job, type, payload) {
    const event = {
      jobId: job.id,
      sequence: ++job.sequence,
      timestamp: this.now().toISOString(),
      type,
      payload,
    };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS_IN_MEMORY) {
      job.events.splice(0, job.events.length - MAX_EVENTS_IN_MEMORY);
    }
    job.writeChain = job.writeChain
      .then(() => appendFile(job.eventsFile, `${JSON.stringify(event)}\n`, "utf8"))
      .catch((error) => this.emit("warning", { message: "任务日志写入失败", error, jobId: job.id }));
    this.emit("event", event);
    return event;
  }

  async persist(job) {
    const operation = job.metadataWriteChain.then(
      () => writeJsonAtomic(job.metadataFile, metadataFromJob(job)),
    );
    job.metadataWriteChain = operation.catch((error) => {
      this.emit("warning", { message: "任务元数据写入失败", error, jobId: job.id });
    });
    return operation;
  }
}
