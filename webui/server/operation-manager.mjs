import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PATHS, assertWithin, pathExists } from "./paths.mjs";

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const ACTIVE_STATES = new Set(["queued", "running", "cancelling"]);
const MAX_RECORDS = 100;

function operationId() {
  return `op-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
}

function publicOperation(operation, { includeResult = true } = {}) {
  const {
    controller: _controller,
    promise: _promise,
    result: operationResult,
    ...result
  } = operation;
  return includeResult ? { ...result, result: operationResult } : { ...result };
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function normalizeProgress(update = {}, operation) {
  const hasCurrent = Object.hasOwn(update, "current");
  const hasTotal = Object.hasOwn(update, "total");
  const hasPercent = Object.hasOwn(update, "percent");
  const parsedCurrent = update.current == null ? null : Number(update.current);
  const parsedTotal = update.total == null ? null : Number(update.total);
  const parsedPercent = update.percent == null ? null : Number(update.percent);
  const current = hasCurrent
    ? Number.isFinite(parsedCurrent) ? Math.max(0, parsedCurrent) : null
    : operation.current;
  const total = hasTotal
    ? Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null
    : operation.total;
  const percent = hasPercent
    ? clampPercent(Number.isFinite(parsedPercent) ? parsedPercent : null)
    : (hasCurrent || hasTotal) && current != null && total != null
      ? clampPercent((current / total) * 100)
      : operation.percent;
  const elapsedSeconds = Math.max(0, (Date.now() - new Date(operation.startedAt ?? operation.createdAt).getTime()) / 1000);
  const hasEta = Object.hasOwn(update, "etaSeconds");
  const parsedEta = update.etaSeconds == null ? null : Number(update.etaSeconds);
  const etaSeconds = hasEta
    ? Number.isFinite(parsedEta) ? Math.max(0, parsedEta) : null
    : hasCurrent || hasTotal || hasPercent
      ? percent != null && percent > 0 && percent < 100
        ? Math.round(elapsedSeconds * ((100 - percent) / percent))
        : null
      : operation.etaSeconds;
  return {
    stage: typeof update.stage === "string" ? update.stage.slice(0, 120) : operation.stage,
    detail: typeof update.detail === "string" ? update.detail.slice(0, 300) : operation.detail,
    current,
    total,
    percent,
    etaSeconds,
  };
}

export class OperationManager {
  constructor({
    root = path.join(PATHS.runtimeRoot, "operations"),
    onUpdate = () => {},
  } = {}) {
    this.root = root;
    this.boundary = path.resolve(root).startsWith(`${path.resolve(PATHS.runtimeRoot)}${path.sep}`)
      ? PATHS.runtimeRoot
      : root;
    this.onUpdate = onUpdate;
    this.operations = new Map();
    this.persistChains = new Map();
  }

  recordPath(id) {
    return assertWithin(this.root, path.join(this.root, `${id}.json`), "操作记录");
  }

  async ensureRoot() {
    await mkdir(this.root, { recursive: true });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("后台操作目录不安全");
    }
    const [boundaryRealPath, rootRealPath] = await Promise.all([
      realpath(this.boundary),
      realpath(this.root),
    ]);
    assertWithin(boundaryRealPath, rootRealPath, "后台操作目录");
  }

  async persist(operation) {
    const snapshot = publicOperation(operation);
    const previous = this.persistChains.get(operation.id) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(async () => {
      await this.ensureRoot();
      const target = this.recordPath(operation.id);
      const temporary = `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.persistChains.set(operation.id, queued);
    try {
      await queued;
    } finally {
      if (this.persistChains.get(operation.id) === queued) {
        this.persistChains.delete(operation.id);
      }
    }
  }

  async initialize() {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^op-[a-z0-9-]+\.json$/i.test(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.root, entry.name), "utf8"));
        if (!record?.id) continue;
        if (ACTIVE_STATES.has(record.status)) {
          record.status = "interrupted";
          record.finishedAt = new Date().toISOString();
          record.error = { code: "OPERATION_INTERRUPTED", message: "本地服务重启，操作结果需要重新确认" };
        }
        records.push(record);
      } catch {
        // A corrupt diagnostic record must not prevent the local runtime from starting.
      }
    }
    const ordered = records.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    const retained = ordered.slice(-MAX_RECORDS);
    retained.forEach((record) => this.operations.set(record.id, record));
    await Promise.all(ordered.slice(0, -MAX_RECORDS).map((record) => (
      unlink(this.recordPath(record.id)).catch(() => {})
    )));
    await Promise.all(retained.filter((record) => record.status === "interrupted").map((record) => this.persist(record)));
  }

  list() {
    return [...this.operations.values()]
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map((operation) => publicOperation(operation, { includeResult: false }));
  }

  get(id) {
    const operation = this.operations.get(id);
    return operation ? publicOperation(operation) : null;
  }

  async start(kind, runner, { label = kind, cancellable = true, detail = null } = {}) {
    if (typeof runner !== "function") throw new TypeError("operation runner must be a function");
    const id = operationId();
    const controller = new AbortController();
    const operation = {
      id,
      kind: String(kind).slice(0, 96),
      label: String(label).slice(0, 160),
      detail,
      stage: "等待开始",
      status: "queued",
      cancellable: Boolean(cancellable),
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      current: null,
      total: null,
      percent: null,
      etaSeconds: null,
      result: null,
      error: null,
      controller,
      promise: null,
    };
    this.operations.set(id, operation);
    await this.persist(operation);
    this.onUpdate(publicOperation(operation));

    const report = async (update) => {
      if (TERMINAL_STATES.has(operation.status)) return;
      Object.assign(operation, normalizeProgress(update, operation));
      await this.persist(operation);
      this.onUpdate(publicOperation(operation));
    };

    operation.promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) {
        operation.status = "cancelled";
        operation.startedAt = new Date().toISOString();
        operation.finishedAt = operation.startedAt;
        operation.stage = "已取消";
        operation.etaSeconds = 0;
        await this.persist(operation);
        this.onUpdate(publicOperation(operation));
        return publicOperation(operation);
      }
      operation.status = "running";
      operation.startedAt = new Date().toISOString();
      operation.stage = "正在处理";
      await this.persist(operation);
      this.onUpdate(publicOperation(operation));
      try {
        if (controller.signal.aborted) {
          throw new DOMException("cancelled", "AbortError");
        }
        const result = await runner({ signal: controller.signal, report, operationId: id });
        if (controller.signal.aborted) {
          operation.status = "cancelled";
          operation.error = null;
        } else {
          operation.status = "succeeded";
          operation.percent = 100;
          operation.result = result ?? null;
        }
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          operation.status = "cancelled";
          operation.error = null;
        } else {
          operation.status = "failed";
          operation.error = {
            code: error?.code ?? "OPERATION_FAILED",
            message: error instanceof Error ? error.message : "操作失败",
          };
        }
      } finally {
        operation.finishedAt = new Date().toISOString();
        operation.etaSeconds = 0;
        await this.persist(operation);
        this.onUpdate(publicOperation(operation));
      }
      return publicOperation(operation);
    });
    return publicOperation(operation);
  }

  async cancel(id) {
    const operation = this.operations.get(id);
    if (!operation) return null;
    if (!operation.cancellable || TERMINAL_STATES.has(operation.status)) return publicOperation(operation);
    operation.status = "cancelling";
    operation.stage = "正在取消";
    operation.controller?.abort();
    await this.persist(operation);
    this.onUpdate(publicOperation(operation));
    return publicOperation(operation);
  }

  async wait(id) {
    const operation = this.operations.get(id);
    if (!operation) return null;
    if (operation.promise) await operation.promise;
    return publicOperation(operation);
  }
}

export function operationRecordExists(root, id) {
  return pathExists(path.join(root, `${id}.json`));
}
