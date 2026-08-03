import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildDflEnvironment } from "./environment.mjs";
import { PATHS, assertWithin, pathExists } from "./paths.mjs";

const IMAGE_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,220}\.(?:jpe?g|png)$/i;
const QUARANTINE_TOKEN = /^\d{14}-[a-f0-9]{10}$/;
const MAX_HELPER_OUTPUT = 4 * 1024 * 1024;
const ANALYSIS_CACHE_TTL_MS = 30_000;
const analysisCache = new Map();

export class AssetError extends Error {
  constructor(message, code = "ASSET_ERROR", status = 400, details) {
    super(message);
    this.name = "AssetError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function alignedDirectory(side) {
  if (!["src", "dst"].includes(side)) {
    throw new AssetError("数据集类型不受支持", "SIDE_INVALID");
  }
  return path.join(PATHS.workspaceRoot, `data_${side}`, "aligned");
}

export function resolveAlignedImage(side, encodedName) {
  let name;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new AssetError("图片文件名无效", "IMAGE_NAME_INVALID");
  }
  if (!IMAGE_NAME.test(name) || path.basename(name) !== name) {
    throw new AssetError("图片文件名不在允许范围内", "IMAGE_NAME_INVALID");
  }
  return assertWithin(alignedDirectory(side), path.join(alignedDirectory(side), name), "aligned 图片");
}

function runAssetHelper(args, input) {
  return new Promise((resolve, reject) => {
    const helper = path.join(PATHS.webuiRoot, "python", "dfl_asset_tool.py");
    const child = spawn(PATHS.python, [helper, ...args], {
      cwd: PATHS.currentDflRoot,
      env: buildDflEnvironment("current"),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(
        reject,
        new AssetError("DFL 分析超过 120 秒，已安全终止", "HELPER_TIMEOUT", 504),
      );
    }, 120_000);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT) {
        child.kill();
        finish(
          reject,
          new AssetError("DFL 分析响应超过 4 MiB", "HELPER_OUTPUT_TOO_LARGE", 500),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(reject, new AssetError(
          Buffer.concat(stderr).toString("utf8").trim() || "读取 DFL 元数据失败",
          "DFL_METADATA_FAILED",
          422,
        ));
        return;
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        finish(reject, new AssetError("DFL 分析响应不是有效 JSON", "DFL_METADATA_INVALID", 500));
      }
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(input));
  });
}

export async function listAlignedAssets(side, { offset = 0, limit = 60 } = {}) {
  const directory = alignedDirectory(side);
  if (!(await pathExists(directory))) {
    return { side, total: 0, offset: 0, limit, items: [] };
  }
  const result = await runAssetHelper([
    "list",
    "--directory",
    directory,
    "--offset",
    String(Math.max(Number(offset) || 0, 0)),
    "--limit",
    String(Math.min(Math.max(Number(limit) || 60, 1), 200)),
  ]);
  return {
    side,
    ...result,
    items: result.items.map((item) => ({
      ...item,
      imageUrl: `/api/assets/${side}/aligned/${encodeURIComponent(item.name)}`,
    })),
  };
}

async function cachedAnalysis(side, key, refresh, loader) {
  const cacheKey = `${side}:${key}`;
  const cached = analysisCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.createdAt < ANALYSIS_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  const value = await loader();
  analysisCache.set(cacheKey, { createdAt: Date.now(), value });
  return { ...value, cached: false };
}

function invalidateAnalysis(side) {
  for (const key of analysisCache.keys()) {
    if (key.startsWith(`${side}:`)) analysisCache.delete(key);
  }
}

export async function buildAlignedPoseAtlas(side) {
  const directory = alignedDirectory(side);
  if (!(await pathExists(directory))) {
    return {
      side,
      total: 0,
      validCount: 0,
      invalidCount: 0,
      lowQualityCount: 0,
      meanSharpness: 0,
      coverage: 0,
      occupiedCells: 0,
      cellCount: 117,
      lowQualityThreshold: 0.24,
      yawTicks: [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90],
      pitchTicks: [60, 45, 30, 15, 0, -15, -30, -45, -60],
      cells: [],
    };
  }
  const result = await runAssetHelper(["atlas", "--directory", directory]);
  return {
    side,
    ...result,
    cells: result.cells.map((cell) => ({
      ...cell,
      samples: cell.samples.map((sample) => ({
        ...sample,
        hasDflMetadata: true,
        polygonCount: 0,
        pointCount: 0,
        imageUrl: `/api/assets/${side}/aligned/${encodeURIComponent(sample.name)}`,
      })),
    })),
  };
}

function recoveryToken() {
  return `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(5).toString("hex")}`;
}

export async function buildAlignedSimilarityGroups(
  side,
  { refresh = false, threshold = 0.86, limit = 500 } = {},
) {
  const directory = alignedDirectory(side);
  const safeThreshold = Math.min(Math.max(Number(threshold) || 0.86, 0.72), 0.98);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 2), 500);
  if (!(await pathExists(directory))) {
    return {
      side, threshold: safeThreshold, total: 0, analyzedCount: 0, invalidCount: 0,
      truncated: false, groupCount: 0, groupedCount: 0, ungroupedCount: 0,
      method: "dct-hsv-edge-v1", groups: [], cached: false,
    };
  }
  const result = await cachedAnalysis(
    side,
    `similarity:${safeThreshold.toFixed(3)}:${safeLimit}`,
    refresh,
    () => runAssetHelper([
      "similarity", "--directory", directory, "--threshold", String(safeThreshold),
      "--limit", String(safeLimit),
    ]),
  );
  return {
    side,
    ...result,
    groups: result.groups.map((group) => ({
      ...group,
      members: group.members.map((member) => ({
        ...member,
        imageUrl: `/api/assets/${side}/aligned/${encodeURIComponent(member.name)}`,
      })),
    })),
  };
}

export async function buildAlignedPoseProbe(side) {
  const directory = alignedDirectory(side);
  if (!(await pathExists(directory))) {
    return {
      schemaVersion: 1,
      side,
      datasetFingerprint: null,
      totalCount: 0,
      validCount: 0,
      invalidCount: 0,
      sampleCount: 0,
      maxSamples: 180,
      maxSamplesPerCell: 3,
      yawTicks: [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90],
      pitchTicks: [60, 45, 30, 15, 0, -15, -30, -45, -60],
      cells: [],
      samples: [],
    };
  }
  return runAssetHelper([
    "probe-manifest",
    "--directory",
    directory,
    "--side",
    side,
  ]);
}

export async function auditAlignedAssets(side, { refresh = false, offset = 0, limit = 120 } = {}) {
  const directory = alignedDirectory(side);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 500);
  if (!(await pathExists(directory))) {
    return {
      side,
      total: 0,
      offset: safeOffset,
      limit: safeLimit,
      analyzedCount: 0,
      validMetadataCount: 0,
      invalidMetadataCount: 0,
      maskedCount: 0,
      xsegSharpnessCount: 0,
      usableCount: 0,
      issueItemCount: 0,
      severeIssueCount: 0,
      uniqueSourceCount: 0,
      duplicateSourceGroupCount: 0,
      meanQualityScore: 0,
      meanSharpness: 0,
      meanFullSharpness: 0,
      issueCounts: {},
      items: [],
      cached: false,
    };
  }
  const result = await cachedAnalysis(side, `audit:${safeOffset}:${safeLimit}`, refresh, () => (
    runAssetHelper([
      "audit",
      "--directory",
      directory,
      "--offset",
      String(safeOffset),
      "--limit",
      String(safeLimit),
    ])
  ));
  return {
    side,
    ...result,
    items: result.items.map((item) => ({
      ...item,
      imageUrl: `/api/assets/${side}/aligned/${encodeURIComponent(item.name)}`,
    })),
  };
}

export async function inspectAlignedPack(side, { refresh = false } = {}) {
  const directory = alignedDirectory(side);
  if (!(await pathExists(directory))) {
    return { side, present: false, status: "aligned_missing", warnings: [], cached: false };
  }
  const result = await cachedAnalysis(side, "pack", refresh, () => (
    runAssetHelper(["pack-inspect", "--directory", directory])
  ));
  return { side, ...result };
}

export async function inspectExtractionCoverage(
  side,
  { refresh = false, offset = 0, limit = 120 } = {},
) {
  const directory = alignedDirectory(side);
  const frames = path.join(PATHS.workspaceRoot, `data_${side}`);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 500);
  if (!(await pathExists(directory)) || !(await pathExists(frames))) {
    return {
      side,
      total: 0,
      offset: safeOffset,
      limit: safeLimit,
      analyzedCount: 0,
      coveredCount: 0,
      uncoveredCount: 0,
      multiFaceCount: 0,
      orphanAlignmentCount: 0,
      items: [],
      cached: false,
    };
  }
  const result = await cachedAnalysis(side, `coverage:${safeOffset}:${safeLimit}`, refresh, () => (
    runAssetHelper([
      "coverage",
      "--frames",
      frames,
      "--directory",
      directory,
      "--offset",
      String(safeOffset),
      "--limit",
      String(safeLimit),
    ])
  ));
  return {
    side,
    ...result,
    items: result.items.map((item) => ({
      ...item,
      frameUrl: `/api/workspace/review/${side}-frame/${encodeURIComponent(item.name)}`,
      faces: item.faces.map((face) => ({
        ...face,
        alignedUrl: `/api/assets/${side}/aligned/${encodeURIComponent(face.alignedName)}`,
      })),
    })),
  };
}

export async function inspectAlignedAnnotation(side, encodedName) {
  const target = resolveAlignedImage(side, encodedName);
  if (!(await pathExists(target))) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  return runAssetHelper(["inspect", "--file", target]);
}

export async function saveAlignedAnnotation(side, encodedName, payload) {
  const target = resolveAlignedImage(side, encodedName);
  if (!(await pathExists(target))) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  const result = await runAssetHelper(["save", "--file", target], payload);
  invalidateAnalysis(side);
  return result;
}

export async function previewAlignedRepair(side, encodedName, payload) {
  const target = resolveAlignedImage(side, encodedName);
  const frames = path.join(PATHS.workspaceRoot, `data_${side}`);
  if (!(await pathExists(target))) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  return runAssetHelper([
    "alignment-preview", "--file", target, "--frames", frames,
  ], { landmarks: payload?.landmarks });
}

export async function applyAlignedRepair(side, encodedName, payload) {
  const target = resolveAlignedImage(side, encodedName);
  const frames = path.join(PATHS.workspaceRoot, `data_${side}`);
  if (!(await pathExists(target))) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  const token = recoveryToken();
  const backupDirectory = assertWithin(
    PATHS.runtimeRoot,
    path.join(PATHS.runtimeRoot, "alignment-backups", side, token),
    "对齐恢复目录",
  );
  await mkdir(backupDirectory, { recursive: true });
  const result = await runAssetHelper([
    "alignment-apply", "--file", target, "--frames", frames,
    "--backup-directory", backupDirectory,
  ], { landmarks: payload?.landmarks });
  invalidateAnalysis(side);
  return { side, token, ...result, recoverable: true };
}

export async function listAlignedRepairBackups(side) {
  alignedDirectory(side);
  const root = path.join(PATHS.runtimeRoot, "alignment-backups", side);
  if (!(await pathExists(root))) return [];
  const tokens = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const tokenEntry of tokens) {
    if (!tokenEntry.isDirectory() || !QUARANTINE_TOKEN.test(tokenEntry.name)) continue;
    const directory = path.join(root, tokenEntry.name);
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && IMAGE_NAME.test(file.name)) {
        result.push({ side, token: tokenEntry.name, name: file.name });
      }
    }
  }
  return result.sort((a, b) => b.token.localeCompare(a.token));
}

export async function restoreAlignedRepair(side, token, encodedName) {
  const target = resolveAlignedImage(side, encodedName);
  if (!QUARANTINE_TOKEN.test(token)) {
    throw new AssetError("对齐备份记录无效", "ALIGNMENT_BACKUP_INVALID");
  }
  const name = path.basename(target);
  const root = path.join(PATHS.runtimeRoot, "alignment-backups", side);
  const backup = assertWithin(root, path.join(root, token, name), "对齐备份");
  if (!(await pathExists(backup))) {
    throw new AssetError("对齐备份不存在", "ALIGNMENT_BACKUP_MISSING", 404);
  }
  const restoreToken = recoveryToken();
  const undoDirectory = path.join(PATHS.runtimeRoot, "alignment-restores", side, restoreToken);
  await mkdir(undoDirectory, { recursive: true });
  if (await pathExists(target)) await copyFile(target, path.join(undoDirectory, name));
  const temporary = `${target}.${process.pid}.${Date.now()}.restore`;
  try {
    await copyFile(backup, temporary);
    await rename(temporary, target);
  } catch (error) {
    if (await pathExists(temporary)) await unlink(temporary);
    throw error;
  }
  invalidateAnalysis(side);
  return { side, token, name, restored: true, undoToken: restoreToken };
}

export async function streamAlignedImage(response, side, encodedName) {
  const target = resolveAlignedImage(side, encodedName);
  if (!(await pathExists(target))) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  const fileStat = await stat(target);
  const contentType = path.extname(target).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileStat.size,
    "Cache-Control": "private, max-age=30",
  });
  return createReadStream(target).pipe(response);
}

export async function quarantineAlignedImage(side, encodedName) {
  const target = resolveAlignedImage(side, encodedName);
  if (!(await pathExists(target))) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  const token = recoveryToken();
  const destinationDirectory = path.join(PATHS.runtimeRoot, "quarantine", side, token);
  await mkdir(destinationDirectory, { recursive: true });
  await rename(target, path.join(destinationDirectory, path.basename(target)));
  invalidateAnalysis(side);
  return { side, token, name: path.basename(target), recoverable: true };
}

export async function quarantineAlignedImages(side, names) {
  if (!Array.isArray(names) || !names.length || names.length > 500) {
    throw new AssetError("批量隔离需要 1–500 个文件", "QUARANTINE_BATCH_INVALID");
  }
  const uniqueNames = [...new Set(names.map((name) => String(name)))];
  const targets = uniqueNames.map((name) => resolveAlignedImage(side, encodeURIComponent(name)));
  for (const target of targets) {
    if (!(await pathExists(target))) {
      throw new AssetError(`aligned 图片不存在：${path.basename(target)}`, "IMAGE_MISSING", 404);
    }
  }
  const token = recoveryToken();
  const destinationDirectory = path.join(PATHS.runtimeRoot, "quarantine", side, token);
  await mkdir(destinationDirectory, { recursive: true });
  const moved = [];
  try {
    for (const target of targets) {
      const name = path.basename(target);
      await rename(target, path.join(destinationDirectory, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved) {
      const source = path.join(destinationDirectory, name);
      if (await pathExists(source)) await rename(source, path.join(alignedDirectory(side), name));
    }
    throw error;
  }
  invalidateAnalysis(side);
  return { side, token, names: moved, count: moved.length, recoverable: true };
}

export async function listAlignedQuarantine(side) {
  alignedDirectory(side);
  const root = path.join(PATHS.runtimeRoot, "quarantine", side);
  if (!(await pathExists(root))) return [];
  const tokens = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const tokenEntry of tokens) {
    if (!tokenEntry.isDirectory() || !QUARANTINE_TOKEN.test(tokenEntry.name)) continue;
    const directory = path.join(root, tokenEntry.name);
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && IMAGE_NAME.test(file.name)) {
        result.push({ side, token: tokenEntry.name, name: file.name });
      }
    }
  }
  return result.sort((a, b) => b.token.localeCompare(a.token));
}

export async function restoreAlignedImage(side, token, encodedName) {
  const destination = resolveAlignedImage(side, encodedName);
  if (!QUARANTINE_TOKEN.test(token)) {
    throw new AssetError("隔离记录无效", "QUARANTINE_TOKEN_INVALID");
  }
  const name = path.basename(destination);
  const source = assertWithin(
    path.join(PATHS.runtimeRoot, "quarantine", side),
    path.join(PATHS.runtimeRoot, "quarantine", side, token, name),
    "隔离文件",
  );
  if (!(await pathExists(source))) {
    throw new AssetError("隔离文件不存在", "QUARANTINE_MISSING", 404);
  }
  if (await pathExists(destination)) {
    throw new AssetError("aligned 中已有同名图片，不能覆盖恢复", "RESTORE_CONFLICT", 409);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  invalidateAnalysis(side);
  return { side, token, name, restored: true };
}
