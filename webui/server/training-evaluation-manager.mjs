import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAlignedPoseProbe } from "./asset-manager.mjs";
import { PATHS, assertWithin, pathExists } from "./paths.mjs";

const MANIFEST_SCHEMA_VERSION = 1;
const INDEX_SCHEMA_VERSION = 1;
const MODEL_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MANIFEST_ID = /^[a-f0-9]{24}$/;
const SNAPSHOT_ID = /^iter-\d{8,12}-[a-f0-9]{8,32}$/;
const SAMPLE_ID = /^(src|dst)-p-?\d+-y-?\d+-\d{2}$/;
const POSE_CELL_ID = /^p-?\d+-y-?\d+$/;
const IMAGE_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,220}\.(?:jpe?g|png)$/i;
const MAX_PROBE_SAMPLES_PER_SIDE = 180;
const SNAPSHOT_VARIANTS = new Set([
  "input",
  "reconstruction",
  "swap",
  "target-mask",
  "predicted-mask",
]);
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export class TrainingEvaluationError extends Error {
  constructor(message, code = "TRAINING_EVALUATION_ERROR", status = 400, details) {
    super(message);
    this.name = "TrainingEvaluationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value, length = 24) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, length);
}

function assertModelKey(modelKey) {
  if (!MODEL_KEY.test(modelKey)) {
    throw new TrainingEvaluationError("模型评测键无效", "MODEL_KEY_INVALID", 400);
  }
  return modelKey;
}

function assertManifestId(manifestId) {
  if (!MANIFEST_ID.test(manifestId)) {
    throw new TrainingEvaluationError("评测集 ID 无效", "MANIFEST_ID_INVALID", 400);
  }
  return manifestId;
}

function assertSnapshotId(snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) {
    throw new TrainingEvaluationError("评测快照 ID 无效", "SNAPSHOT_ID_INVALID", 400);
  }
  return snapshotId;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeSample(sample, side) {
  if (
    !sample
    || sample.side !== side
    || !SAMPLE_ID.test(sample.id)
    || !IMAGE_NAME.test(sample.name)
    || path.basename(sample.name) !== sample.name
    || !POSE_CELL_ID.test(sample.cellId)
    || !sample.id.startsWith(`${side}-${sample.cellId}-`)
    || !/^[a-f0-9]{16}$/.test(sample.sha256Prefix)
    || !Number.isFinite(sample.yaw)
    || !Number.isFinite(sample.pitch)
    || !Number.isInteger(sample.yawTick)
    || !Number.isInteger(sample.pitchTick)
    || !Number.isFinite(sample.sharpness)
    || sample.sharpness < 0
    || sample.sharpness > 1
    || !Number.isFinite(sample.brightness)
    || sample.brightness < 0
    || sample.brightness > 1
  ) {
    throw new TrainingEvaluationError("评测样本格式无效", "PROBE_SAMPLE_INVALID", 422);
  }
  return {
    id: sample.id,
    side,
    name: sample.name,
    sha256Prefix: sample.sha256Prefix,
    sourceFilename: sample.sourceFilename ?? null,
    cellId: sample.cellId,
    yaw: sample.yaw,
    pitch: sample.pitch,
    yawTick: sample.yawTick,
    pitchTick: sample.pitchTick,
    sharpness: sample.sharpness,
    brightness: sample.brightness,
    hasAppliedMask: Boolean(sample.hasAppliedMask),
  };
}

function validateProbe(probe, side) {
  if (
    !probe
    || probe.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || probe.side !== side
    || typeof probe.datasetFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(probe.datasetFingerprint)
    || !Array.isArray(probe.yawTicks)
    || !Array.isArray(probe.pitchTicks)
    || !Array.isArray(probe.samples)
    || probe.samples.length > MAX_PROBE_SAMPLES_PER_SIDE
  ) {
    throw new TrainingEvaluationError(`${side.toUpperCase()} 评测集无效`, "PROBE_INVALID", 422);
  }
  const samples = probe.samples.map((sample) => normalizeSample(sample, side));
  const sampleIds = new Set(samples.map((sample) => sample.id));
  if (sampleIds.size !== samples.length || probe.sampleCount !== samples.length) {
    throw new TrainingEvaluationError(`${side.toUpperCase()} 评测样本不唯一`, "PROBE_SAMPLE_DUPLICATE", 422);
  }
  if (samples.some((sample) => (
    !probe.yawTicks.includes(sample.yawTick)
    || !probe.pitchTicks.includes(sample.pitchTick)
    || sample.cellId !== `p${sample.pitchTick}-y${sample.yawTick}`
  ))) {
    throw new TrainingEvaluationError(`${side.toUpperCase()} 姿态格无效`, "PROBE_POSE_CELL_INVALID", 422);
  }
  samples.sort((left, right) => left.id.localeCompare(right.id, "en"));
  return { ...probe, samples };
}

function createEmptyIndex(modelKey) {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    modelKey,
    activeManifestId: null,
    manifestIds: [],
    snapshotIds: [],
  };
}

export function createTrainingModelKey(modelName, modelClass = "SAEHD") {
  const identity = `${String(modelName ?? "")}\0${String(modelClass ?? "")}`;
  const slug = `${String(modelName ?? "model")}-${String(modelClass ?? "SAEHD")}`
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 50) || "model";
  return `${slug}-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

export class TrainingEvaluationManager {
  constructor({
    root = PATHS.trainingEvaluationsRoot,
    archiveRoot = PATHS.trainingEvaluationsArchiveRoot,
    probeBuilder = buildAlignedPoseProbe,
    now = () => new Date(),
  } = {}) {
    this.root = path.resolve(root);
    this.archiveRoot = path.resolve(archiveRoot);
    this.probeBuilder = probeBuilder;
    this.now = now;
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = Promise.all([
        mkdir(this.root, { recursive: true }),
        mkdir(this.archiveRoot, { recursive: true }),
      ]).then(() => this).catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  modelDirectory(modelKey) {
    assertModelKey(modelKey);
    return assertWithin(this.root, path.join(this.root, modelKey), "模型评测目录");
  }

  manifestPath(modelKey, manifestId) {
    assertManifestId(manifestId);
    return assertWithin(
      this.modelDirectory(modelKey),
      path.join(this.modelDirectory(modelKey), "manifests", `${manifestId}.json`),
      "评测集文件",
    );
  }

  snapshotDirectory(modelKey, snapshotId) {
    assertSnapshotId(snapshotId);
    return assertWithin(
      this.modelDirectory(modelKey),
      path.join(this.modelDirectory(modelKey), "snapshots", snapshotId),
      "评测快照目录",
    );
  }

  archivedSnapshotDirectory(modelKey, snapshotId) {
    assertModelKey(modelKey);
    assertSnapshotId(snapshotId);
    const modelArchive = assertWithin(
      this.archiveRoot,
      path.join(this.archiveRoot, modelKey),
      "模型评测归档目录",
    );
    return assertWithin(
      modelArchive,
      path.join(modelArchive, snapshotId),
      "评测快照归档目录",
    );
  }

  async readJsonLimited(target, missingCode = "EVALUATION_NOT_FOUND") {
    try {
      const content = await readFile(target);
      if (content.length > MAX_JSON_BYTES) {
        throw new TrainingEvaluationError("评测 JSON 超过 4 MiB", "EVALUATION_JSON_TOO_LARGE", 422);
      }
      return JSON.parse(content.toString("utf8"));
    } catch (error) {
      if (error instanceof TrainingEvaluationError) throw error;
      if (error?.code === "ENOENT") {
        throw new TrainingEvaluationError("评测数据不存在", missingCode, 404);
      }
      if (error instanceof SyntaxError) {
        throw new TrainingEvaluationError("评测 JSON 已损坏", "EVALUATION_JSON_INVALID", 422);
      }
      throw error;
    }
  }

  async writeJsonAtomic(target, value) {
    assertWithin(this.root, target, "评测运行时文件");
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async readIndex(modelKey) {
    const target = path.join(this.modelDirectory(modelKey), "index.json");
    if (!(await pathExists(target))) return createEmptyIndex(modelKey);
    const index = await this.readJsonLimited(target, "EVALUATION_INDEX_NOT_FOUND");
    if (
      index?.schemaVersion !== INDEX_SCHEMA_VERSION
      || index.modelKey !== modelKey
      || !Array.isArray(index.manifestIds)
      || !Array.isArray(index.snapshotIds)
    ) {
      throw new TrainingEvaluationError("模型评测索引无效", "EVALUATION_INDEX_INVALID", 422);
    }
    return index;
  }

  async writeIndex(modelKey, index) {
    await this.writeJsonAtomic(path.join(this.modelDirectory(modelKey), "index.json"), index);
  }

  async createOrReuseManifest(modelKey, { modelName, modelClass = "SAEHD" } = {}) {
    assertModelKey(modelKey);
    if (typeof modelName !== "string" || !modelName.trim() || modelName.length > 128) {
      throw new TrainingEvaluationError("模型名称无效", "MODEL_NAME_INVALID", 400);
    }
    if (typeof modelClass !== "string" || !modelClass.trim() || modelClass.length > 32) {
      throw new TrainingEvaluationError("模型类型无效", "MODEL_CLASS_INVALID", 400);
    }
    if (createTrainingModelKey(modelName, modelClass) !== modelKey) {
      throw new TrainingEvaluationError("模型名称与评测键不匹配", "MODEL_KEY_MISMATCH", 400);
    }
    const [src, dst] = await Promise.all([
      this.probeBuilder("src"),
      this.probeBuilder("dst"),
    ]).then(([srcProbe, dstProbe]) => [
      validateProbe(srcProbe, "src"),
      validateProbe(dstProbe, "dst"),
    ]);
    if (!sameArray(src.yawTicks, dst.yawTicks) || !sameArray(src.pitchTicks, dst.pitchTicks)) {
      throw new TrainingEvaluationError("SRC/DST 姿态分箱不一致", "POSE_BINS_MISMATCH", 422);
    }
    if (!src.samples.length || !dst.samples.length) {
      throw new TrainingEvaluationError(
        "SRC 与 DST 都需要至少一个有效姿态评估样本",
        "PROBE_SAMPLES_EMPTY",
        422,
      );
    }

    const content = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      modelKey,
      modelName,
      modelClass,
      poseBins: { yaw: src.yawTicks, pitch: src.pitchTicks },
      datasets: {
        src: { fingerprint: src.datasetFingerprint, sampleCount: src.sampleCount },
        dst: { fingerprint: dst.datasetFingerprint, sampleCount: dst.sampleCount },
      },
      samples: [...src.samples, ...dst.samples],
    };
    const manifestId = digest(content);
    const target = this.manifestPath(modelKey, manifestId);
    const index = await this.readIndex(modelKey);
    if (!(await pathExists(target))) {
      await this.writeJsonAtomic(target, {
        ...content,
        manifestId,
        createdAt: this.now().toISOString(),
      });
    }
    index.activeManifestId = manifestId;
    index.manifestIds = [...new Set([...index.manifestIds, manifestId])];
    await this.writeIndex(modelKey, index);
    return this.getManifest(modelKey, manifestId);
  }

  async getManifest(modelKey, manifestId) {
    const manifest = await this.readJsonLimited(
      this.manifestPath(modelKey, manifestId),
      "MANIFEST_NOT_FOUND",
    );
    if (
      manifest?.manifestId !== manifestId
      || manifest?.modelKey !== modelKey
      || typeof manifest.createdAt !== "string"
    ) {
      throw new TrainingEvaluationError("评测集内容与索引不匹配", "MANIFEST_INVALID", 422);
    }
    return manifest;
  }

  async listManifests(modelKey) {
    const index = await this.readIndex(modelKey);
    const manifests = [];
    for (const manifestId of index.manifestIds) {
      if (!MANIFEST_ID.test(manifestId)) continue;
      try {
        manifests.push(await this.getManifest(modelKey, manifestId));
      } catch (error) {
        if (error.code !== "MANIFEST_NOT_FOUND") throw error;
      }
    }
    manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { modelKey, activeManifestId: index.activeManifestId, manifests };
  }

  async refreshSnapshotIndex(modelKey, index) {
    const snapshotsRoot = path.join(this.modelDirectory(modelKey), "snapshots");
    if (!(await pathExists(snapshotsRoot))) return index;
    const entries = await readdir(snapshotsRoot, { withFileTypes: true });
    const snapshotIds = entries
      .filter((entry) => entry.isDirectory() && SNAPSHOT_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (stableStringify(snapshotIds) !== stableStringify(index.snapshotIds)) {
      const nextIndex = { ...index, snapshotIds };
      await this.writeIndex(modelKey, nextIndex);
      return nextIndex;
    }
    return index;
  }

  async getSnapshot(modelKey, snapshotId) {
    const summary = await this.readJsonLimited(
      path.join(this.snapshotDirectory(modelKey, snapshotId), "summary.json"),
      "SNAPSHOT_NOT_FOUND",
    );
    if (
      summary?.schemaVersion !== 1
      || summary.snapshotId !== snapshotId
      || summary.modelKey !== modelKey
      || !MANIFEST_ID.test(summary.manifestId)
      || !Number.isInteger(summary.iteration)
      || summary.metricSchemaVersion !== 1
      || !summary.modelSignature
      || typeof summary.modelSignature !== "object"
      || typeof summary.createdAt !== "string"
      || !Array.isArray(summary.samples)
    ) {
      throw new TrainingEvaluationError("评测快照摘要无效", "SNAPSHOT_INVALID", 422);
    }
    await this.getManifest(modelKey, summary.manifestId);
    return summary;
  }

  async listSnapshots(modelKey) {
    const index = await this.refreshSnapshotIndex(modelKey, await this.readIndex(modelKey));
    const snapshots = [];
    for (const snapshotId of index.snapshotIds) {
      try {
        snapshots.push(await this.getSnapshot(modelKey, snapshotId));
      } catch (error) {
        if (error.code !== "SNAPSHOT_NOT_FOUND") throw error;
      }
    }
    snapshots.sort((left, right) => right.iteration - left.iteration || right.createdAt.localeCompare(left.createdAt));
    return {
      modelKey,
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        iteration: snapshot.iteration,
        manifestId: snapshot.manifestId,
        metricSchemaVersion: snapshot.metricSchemaVersion,
        createdAt: snapshot.createdAt,
        sampleCount: snapshot.samples.length,
      })),
    };
  }

  async resolveSnapshotImage(modelKey, snapshotId, sampleId, variant) {
    if (!SAMPLE_ID.test(sampleId) || !SNAPSHOT_VARIANTS.has(variant)) {
      throw new TrainingEvaluationError("评测样本图片 ID 无效", "SNAPSHOT_IMAGE_INVALID", 400);
    }
    const summary = await this.getSnapshot(modelKey, snapshotId);
    const sample = summary.samples.find((candidate) => candidate.id === sampleId);
    if (!sample || !Array.isArray(sample.variants) || !sample.variants.includes(variant)) {
      throw new TrainingEvaluationError("评测样本图片不存在", "SNAPSHOT_IMAGE_NOT_FOUND", 404);
    }
    const snapshotDirectory = this.snapshotDirectory(modelKey, snapshotId);
    return assertWithin(
      snapshotDirectory,
      path.join(snapshotDirectory, "samples", sampleId, `${variant}.webp`),
      "评测样本图片",
    );
  }

  validateSnapshotSelection(snapshotIds) {
    if (!Array.isArray(snapshotIds) || snapshotIds.length === 0 || snapshotIds.length > 12) {
      throw new TrainingEvaluationError("评测快照选择无效", "SNAPSHOT_SELECTION_INVALID", 400);
    }
    const unique = [...new Set(snapshotIds)];
    if (unique.length !== snapshotIds.length) {
      throw new TrainingEvaluationError("评测快照选择包含重复项", "SNAPSHOT_SELECTION_DUPLICATE", 400);
    }
    unique.forEach(assertSnapshotId);
    return unique;
  }

  async archiveSnapshots(modelKey, snapshotIds) {
    const selected = this.validateSnapshotSelection(snapshotIds);
    const targets = selected.map((snapshotId) => ({
      snapshotId,
      source: this.snapshotDirectory(modelKey, snapshotId),
      destination: this.archivedSnapshotDirectory(modelKey, snapshotId),
    }));
    for (const target of targets) {
      if (!(await pathExists(target.source))) {
        throw new TrainingEvaluationError("待归档评测快照不存在", "SNAPSHOT_NOT_FOUND", 404);
      }
      if (await pathExists(target.destination)) {
        throw new TrainingEvaluationError("评测快照已归档", "SNAPSHOT_ALREADY_ARCHIVED", 409);
      }
    }
    await mkdir(path.dirname(targets[0].destination), { recursive: true });
    const moved = [];
    try {
      for (const target of targets) {
        await rename(target.source, target.destination);
        moved.push(target);
      }
    } catch (error) {
      for (const target of moved.reverse()) {
        if (await pathExists(target.destination)) {
          await rename(target.destination, target.source);
        }
      }
      throw error;
    }
    await this.refreshSnapshotIndex(modelKey, await this.readIndex(modelKey));
    return { modelKey, archivedSnapshotIds: selected };
  }

  async restoreSnapshots(modelKey, snapshotIds) {
    const selected = this.validateSnapshotSelection(snapshotIds);
    const targets = selected.map((snapshotId) => ({
      snapshotId,
      source: this.archivedSnapshotDirectory(modelKey, snapshotId),
      destination: this.snapshotDirectory(modelKey, snapshotId),
    }));
    for (const target of targets) {
      if (!(await pathExists(target.source))) {
        throw new TrainingEvaluationError("待恢复评测快照不存在", "ARCHIVED_SNAPSHOT_NOT_FOUND", 404);
      }
      if (await pathExists(target.destination)) {
        throw new TrainingEvaluationError("评测快照已在线", "SNAPSHOT_ALREADY_ONLINE", 409);
      }
    }
    await mkdir(path.dirname(targets[0].destination), { recursive: true });
    const moved = [];
    try {
      for (const target of targets) {
        await rename(target.source, target.destination);
        moved.push(target);
      }
    } catch (error) {
      for (const target of moved.reverse()) {
        if (await pathExists(target.destination)) {
          await rename(target.destination, target.source);
        }
      }
      throw error;
    }
    await this.refreshSnapshotIndex(modelKey, await this.readIndex(modelKey));
    return { modelKey, restoredSnapshotIds: selected };
  }
}
