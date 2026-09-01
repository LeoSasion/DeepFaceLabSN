import os from "node:os";
import { statfs } from "node:fs/promises";

const GIB = 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 5 * GIB;
const MAX_JOB_SUMMARIES = 40;

function finiteNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bigintToSafeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function summarizeDataset(dataset = {}) {
  return {
    count: Math.max(0, finiteNumber(dataset.count)),
    bytes: Math.max(0, finiteNumber(dataset.bytes)),
    modifiedAt: dataset.modifiedAt ?? null,
  };
}

function summarizeMaterial(material) {
  if (!material) return null;
  return {
    extension: material.extension ?? null,
    bytes: Math.max(0, finiteNumber(material.bytes)),
    durationSeconds: finiteNumber(material.durationSeconds, null),
    width: finiteNumber(material.width, null),
    height: finiteNumber(material.height, null),
    frameRate: material.frameRate ?? null,
    modifiedAt: material.modifiedAt ?? null,
  };
}

function summarizeJob(job = {}) {
  return {
    id: String(job.id ?? "").slice(0, 96),
    commandId: String(job.commandId ?? "").slice(0, 128),
    profile: job.profile ?? null,
    status: job.status ?? "unknown",
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
  };
}

export async function inspectStorage(root, {
  requiredBytes = 0,
  reserveBytes = DEFAULT_RESERVE_BYTES,
  readStatfs = statfs,
} = {}) {
  const stats = await readStatfs(root, { bigint: true });
  const blockSize = bigintToSafeNumber(stats.bsize);
  const totalBytes = bigintToSafeNumber(stats.blocks) * blockSize;
  const freeBytes = bigintToSafeNumber(stats.bavail ?? stats.bfree) * blockSize;
  const requestedBytes = Math.max(0, finiteNumber(requiredBytes));
  const resolvedReserveBytes = Math.max(0, finiteNumber(reserveBytes, DEFAULT_RESERVE_BYTES));
  const usableBytes = Math.max(0, freeBytes - resolvedReserveBytes);
  return {
    totalBytes,
    freeBytes,
    reserveBytes: resolvedReserveBytes,
    usableBytes,
    requiredBytes: requestedBytes,
    ready: usableBytes >= requestedBytes,
    shortfallBytes: Math.max(0, requestedBytes - usableBytes),
    sampledAt: new Date().toISOString(),
  };
}

export function buildDiagnosticSnapshot({
  version,
  workspace,
  telemetry,
  storage,
  jobs = [],
  runtime = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const datasets = workspace?.datasets ?? {};
  return {
    schemaVersion: 1,
    generatedAt,
    product: {
      name: "DeepFaceLabSN",
      version: version ?? "unknown",
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      windowsRelease: os.release(),
    },
    runtime: {
      profile: runtime.profile ?? null,
      pythonAvailable: Boolean(runtime.pythonAvailable),
      currentAvailable: Boolean(runtime.currentAvailable),
      legacyAvailable: Boolean(runtime.legacyAvailable),
      workspaceAvailable: Boolean(runtime.workspaceAvailable),
    },
    workspace: {
      projectId: workspace?.projectId ?? null,
      readiness: { ...(workspace?.readiness ?? {}) },
      materials: {
        src: summarizeMaterial(workspace?.materials?.src),
        dst: summarizeMaterial(workspace?.materials?.dst),
      },
      datasets: Object.fromEntries(
        Object.entries(datasets).map(([key, value]) => [key, summarizeDataset(value)]),
      ),
      modelCount: Array.isArray(workspace?.models) ? workspace.models.length : 0,
      outputCount: Array.isArray(workspace?.outputs) ? workspace.outputs.length : 0,
    },
    telemetry: telemetry
      ? {
          available: Boolean(telemetry.available),
          sampledAt: telemetry.sampledAt ?? null,
          error: telemetry.error ?? null,
          gpus: Array.isArray(telemetry.gpus)
            ? telemetry.gpus.map((gpu) => ({
                index: gpu.index,
                name: gpu.name,
                utilizationPercent: gpu.utilizationPercent,
                memoryUsedMiB: gpu.memoryUsedMiB,
                memoryTotalMiB: gpu.memoryTotalMiB,
                temperatureC: gpu.temperatureC,
                powerDrawW: gpu.powerDrawW,
                powerLimitW: gpu.powerLimitW,
                fanPercent: gpu.fanPercent,
              }))
            : [],
        }
      : null,
    storage: storage ?? null,
    jobs: jobs.slice(-MAX_JOB_SUMMARIES).map(summarizeJob),
  };
}

export const DIAGNOSTIC_DEFAULT_RESERVE_BYTES = DEFAULT_RESERVE_BYTES;
