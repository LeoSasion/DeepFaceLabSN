import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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

function quarantineDirectory(side) {
  alignedDirectory(side);
  return assertWithin(
    PATHS.runtimeRoot,
    path.join(PATHS.runtimeRoot, "quarantine", side),
    "隔离目录",
  );
}

function decodeImageName(encodedName) {
  let name;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new AssetError("图片文件名无效", "IMAGE_NAME_INVALID");
  }
  if (!IMAGE_NAME.test(name) || path.basename(name) !== name) {
    throw new AssetError("图片文件名不在允许范围内", "IMAGE_NAME_INVALID");
  }
  return name;
}

function validateQuarantineToken(token) {
  if (!QUARANTINE_TOKEN.test(token)) {
    throw new AssetError("隔离记录无效", "QUARANTINE_TOKEN_INVALID");
  }
  return token;
}

async function lstatIfPresent(target, options) {
  try {
    return await lstat(target, options);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function verifyPlainDirectory(target, label, code = "QUARANTINE_PATH_UNSAFE") {
  const info = await lstatIfPresent(target);
  if (!info) {
    throw new AssetError(`${label}不存在`, code, 404);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AssetError(`${label}不是安全的本地目录`, code, 400);
  }
}

async function verifyAlignedDirectory(side) {
  const directory = alignedDirectory(side);
  const directoryInfo = await lstatIfPresent(directory);
  if (!directoryInfo) return null;
  const dataDirectory = path.dirname(directory);
  await verifyPlainDirectory(dataDirectory, "数据集目录", "ALIGNED_PATH_UNSAFE");
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new AssetError("aligned 目录不是安全的本地目录", "ALIGNED_PATH_UNSAFE", 400);
  }
  const [workspaceRealPath, directoryRealPath] = await Promise.all([
    realpath(PATHS.workspaceRoot),
    realpath(directory),
  ]);
  try {
    assertWithin(workspaceRealPath, directoryRealPath, "aligned 目录");
  } catch {
    throw new AssetError("aligned 目录超出工作区", "ALIGNED_PATH_UNSAFE", 400);
  }
  return directory;
}

async function resolveExistingAlignedImage(side, encodedName) {
  const target = resolveAlignedImage(side, encodedName);
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  const fileInfo = await lstatIfPresent(target);
  if (!fileInfo) {
    throw new AssetError("aligned 图片不存在", "IMAGE_MISSING", 404);
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new AssetError("aligned 图片不是安全的本地图片", "ALIGNED_PATH_UNSAFE", 400);
  }
  const [directoryRealPath, targetRealPath] = await Promise.all([
    realpath(directory),
    realpath(target),
  ]);
  try {
    assertWithin(directoryRealPath, targetRealPath, "aligned 图片");
  } catch {
    throw new AssetError("aligned 图片超出工作区", "ALIGNED_PATH_UNSAFE", 400);
  }
  return target;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openVerifiedImage(
  target,
  label,
  unsafeCode,
  { containmentRoot = path.dirname(target), boundaryRoot = PATHS.workspaceRoot } = {},
) {
  let fileHandle;
  try {
    fileHandle = await open(target, "r");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new AssetError(`${label}不存在`, "IMAGE_MISSING", 404);
    }
    throw error;
  }
  try {
    const openedInfo = await fileHandle.stat({ bigint: true });
    const [boundaryRealPath, containmentRealPath, targetRealPath] = await Promise.all([
      realpath(boundaryRoot),
      realpath(containmentRoot),
      realpath(target),
    ]);
    try {
      assertWithin(boundaryRealPath, containmentRealPath, label);
      assertWithin(containmentRealPath, targetRealPath, label);
    } catch {
      throw new AssetError(`${label}超出允许范围`, unsafeCode, 400);
    }
    // Check the path after canonicalization so an ancestor swap cannot redirect the opened handle.
    const pathInfo = await lstat(target, { bigint: true });
    if (
      !openedInfo.isFile()
      || !pathInfo.isFile()
      || pathInfo.isSymbolicLink()
      || !sameFileIdentity(openedInfo, pathInfo)
    ) {
      throw new AssetError(`${label}在读取前发生了不安全的路径变化`, unsafeCode, 400);
    }
    return { fileHandle, fileInfo: openedInfo };
  } catch (error) {
    await fileHandle.close().catch(() => {});
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new AssetError(`${label}不存在`, "IMAGE_MISSING", 404);
    }
    throw error;
  }
}

async function ensureSafeAlignedDirectory(side) {
  const directory = alignedDirectory(side);
  const dataDirectory = path.dirname(directory);
  const dataInfo = await lstatIfPresent(dataDirectory);
  if (dataInfo) {
    await verifyPlainDirectory(dataDirectory, "数据集目录", "ALIGNED_PATH_UNSAFE");
  } else {
    await mkdir(dataDirectory);
  }
  const alignedInfo = await lstatIfPresent(directory);
  if (alignedInfo) {
    await verifyPlainDirectory(directory, "aligned 目录", "ALIGNED_PATH_UNSAFE");
  } else {
    await mkdir(directory);
  }
  return verifyAlignedDirectory(side);
}

async function verifyQuarantineRoot(side) {
  const root = quarantineDirectory(side);
  if (!(await pathExists(root))) return null;
  const base = path.dirname(root);
  await verifyPlainDirectory(PATHS.runtimeRoot, "运行时目录");
  await verifyPlainDirectory(base, "隔离根目录");
  await verifyPlainDirectory(root, "数据集隔离目录");
  const [workspaceRealPath, runtimeRealPath, rootRealPath] = await Promise.all([
    realpath(PATHS.workspaceRoot),
    realpath(PATHS.runtimeRoot),
    realpath(root),
  ]);
  try {
    assertWithin(workspaceRealPath, runtimeRealPath, "运行时目录");
    assertWithin(runtimeRealPath, rootRealPath, "数据集隔离目录");
  } catch {
    throw new AssetError("隔离目录超出运行时目录", "QUARANTINE_PATH_UNSAFE", 400);
  }
  return root;
}

async function ensureQuarantineRoot(side) {
  const root = quarantineDirectory(side);
  const base = path.dirname(root);
  const runtimeInfo = await lstatIfPresent(PATHS.runtimeRoot);
  if (runtimeInfo) await verifyPlainDirectory(PATHS.runtimeRoot, "运行时目录");
  else await mkdir(PATHS.runtimeRoot);
  const baseInfo = await lstatIfPresent(base);
  if (baseInfo) await verifyPlainDirectory(base, "隔离根目录");
  else await mkdir(base);
  const rootInfo = await lstatIfPresent(root);
  if (rootInfo) await verifyPlainDirectory(root, "数据集隔离目录");
  else await mkdir(root);
  await verifyQuarantineRoot(side);
  return root;
}

async function createQuarantineTokenDirectory(side) {
  const root = await ensureQuarantineRoot(side);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = recoveryToken();
    const directory = assertWithin(root, path.join(root, token), "隔离记录目录");
    try {
      await mkdir(directory);
      return { token, directory };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new AssetError("无法创建唯一的隔离记录", "QUARANTINE_TOKEN_COLLISION", 500);
}

export function resolveAlignedImage(side, encodedName) {
  const name = decodeImageName(encodedName);
  return assertWithin(alignedDirectory(side), path.join(alignedDirectory(side), name), "aligned 图片");
}

export async function resolveQuarantinedImage(side, token, encodedName) {
  validateQuarantineToken(token);
  const name = decodeImageName(encodedName);
  const root = await verifyQuarantineRoot(side);
  if (!root) {
    throw new AssetError("隔离文件不存在", "QUARANTINE_MISSING", 404);
  }
  const tokenDirectory = assertWithin(root, path.join(root, token), "隔离记录目录");
  const target = assertWithin(tokenDirectory, path.join(tokenDirectory, name), "隔离文件");
  if (!(await pathExists(tokenDirectory)) || !(await pathExists(target))) {
    throw new AssetError("隔离文件不存在", "QUARANTINE_MISSING", 404);
  }
  await verifyPlainDirectory(tokenDirectory, "隔离记录目录");
  const fileInfo = await lstat(target);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new AssetError("隔离文件不是安全的本地图片", "QUARANTINE_PATH_UNSAFE", 400);
  }
  const [rootRealPath, tokenRealPath, targetRealPath] = await Promise.all([
    realpath(root),
    realpath(tokenDirectory),
    realpath(target),
  ]);
  try {
    assertWithin(rootRealPath, tokenRealPath, "隔离记录目录");
    assertWithin(tokenRealPath, targetRealPath, "隔离文件");
  } catch {
    throw new AssetError("隔离文件超出允许范围", "QUARANTINE_PATH_UNSAFE", 400);
  }
  return target;
}

function runAssetHelper(args, input, {
  signal,
  onProgress,
  timeoutMs = 120_000,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AssetError("操作已取消", "OPERATION_CANCELLED", 499));
      return;
    }
    const helper = path.join(PATHS.webuiRoot, "python", "dfl_asset_tool.py");
    const child = spawn(PATHS.python, [helper, ...args], {
      cwd: PATHS.currentDflRoot,
      env: buildDflEnvironment("current"),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stderrRemainder = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      child.kill();
      finish(reject, new AssetError("操作已取消", "OPERATION_CANCELLED", 499));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      child.kill();
      finish(
        reject,
        new AssetError(
          `DFL 分析超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已安全终止`,
          "HELPER_TIMEOUT",
          504,
        ),
      );
    }, timeoutMs);
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
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT) {
        child.kill();
        finish(
          reject,
          new AssetError("DFL 分析响应超过 4 MiB", "HELPER_OUTPUT_TOO_LARGE", 500),
        );
        return;
      }
      stderrRemainder += chunk.toString("utf8");
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("DFL_PROGRESS ")) {
          try {
            onProgress?.(JSON.parse(line.slice("DFL_PROGRESS ".length)));
          } catch {
            // A malformed progress update must not invalidate the analysis result.
          }
        } else if (line) {
          stderr.push(Buffer.from(`${line}\n`, "utf8"));
        }
      }
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (settled) return;
      if (stderrRemainder) {
        if (stderrRemainder.startsWith("DFL_PROGRESS ")) {
          try {
            onProgress?.(JSON.parse(stderrRemainder.slice("DFL_PROGRESS ".length)));
          } catch {
            // Ignore malformed progress while preserving the final result.
          }
        } else {
          stderr.push(Buffer.from(stderrRemainder, "utf8"));
        }
      }
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
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
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

export async function summarizeXSegLabels(side) {
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
    return {
      side,
      total: 0,
      polygonCount: 0,
      appliedMaskCount: 0,
      usableLabelCount: 0,
      invalidCount: 0,
    };
  }
  return {
    side,
    ...await runAssetHelper(["xseg-label-summary", "--directory", directory]),
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

export async function buildAlignedPoseAtlas(side, { signal, onProgress } = {}) {
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
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
  const result = await runAssetHelper(
    ["atlas", "--directory", directory],
    undefined,
    { signal, onProgress, timeoutMs: 600_000 },
  );
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
  { refresh = false, threshold = 0.86, limit = 500, signal, onProgress } = {},
) {
  const directory = await verifyAlignedDirectory(side);
  const safeThreshold = Math.min(Math.max(Number(threshold) || 0.86, 0.72), 0.98);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 2), 500);
  if (!directory) {
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
    ], undefined, { signal, onProgress, timeoutMs: 600_000 }),
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
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
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

export async function auditAlignedAssets(side, {
  refresh = false, offset = 0, limit = 120, signal, onProgress,
} = {}) {
  const directory = await verifyAlignedDirectory(side);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 500);
  if (!directory) {
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
    ], undefined, { signal, onProgress, timeoutMs: 600_000 })
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

export async function inspectAlignedPack(side, { refresh = false, signal } = {}) {
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
    return { side, present: false, status: "aligned_missing", warnings: [], cached: false };
  }
  const result = await cachedAnalysis(side, "pack", refresh, () => (
    runAssetHelper(["pack-inspect", "--directory", directory], undefined, { signal })
  ));
  return { side, ...result };
}

export async function inspectExtractionCoverage(
  side,
  { refresh = false, offset = 0, limit = 120, signal, onProgress } = {},
) {
  const directory = await verifyAlignedDirectory(side);
  const frames = path.join(PATHS.workspaceRoot, `data_${side}`);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 500);
  if (!directory || !(await pathExists(frames))) {
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
    ], undefined, { signal, onProgress, timeoutMs: 600_000 })
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
  const target = await resolveExistingAlignedImage(side, encodedName);
  return runAssetHelper(["inspect", "--file", target]);
}

export async function saveAlignedAnnotation(side, encodedName, payload) {
  const target = await resolveExistingAlignedImage(side, encodedName);
  const result = await runAssetHelper(["save", "--file", target], payload);
  invalidateAnalysis(side);
  return result;
}

export async function previewAlignedRepair(side, encodedName, payload) {
  const target = await resolveExistingAlignedImage(side, encodedName);
  const frames = path.join(PATHS.workspaceRoot, `data_${side}`);
  return runAssetHelper([
    "alignment-preview", "--file", target, "--frames", frames,
  ], { landmarks: payload?.landmarks });
}

export async function applyAlignedRepair(side, encodedName, payload) {
  const target = await resolveExistingAlignedImage(side, encodedName);
  const frames = path.join(PATHS.workspaceRoot, `data_${side}`);
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
  await ensureSafeAlignedDirectory(side);
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
  if (await pathExists(target)) {
    await resolveExistingAlignedImage(side, encodedName);
    await copyFile(target, path.join(undoDirectory, name));
  }
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

async function streamImageFile(response, target, { label, unsafeCode }) {
  const { fileHandle, fileInfo } = await openVerifiedImage(target, label, unsafeCode);
  try {
    const contentType = path.extname(target).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": Number(fileInfo.size),
      "Cache-Control": "private, max-age=30",
    });
    try {
      await pipeline(fileHandle.createReadStream({ autoClose: false }), response);
    } catch {
      // Headers may already be committed; terminate only this response and keep the runtime alive.
      if (!response.destroyed) response.destroy();
    }
  } finally {
    await fileHandle.close().catch(() => {});
  }
}

export async function streamAlignedImage(response, side, encodedName) {
  const target = await resolveExistingAlignedImage(side, encodedName);
  return streamImageFile(response, target, {
    label: "aligned 图片",
    unsafeCode: "ALIGNED_PATH_UNSAFE",
  });
}

export async function inspectQuarantinedAnnotation(side, token, encodedName) {
  const target = await resolveQuarantinedImage(side, token, encodedName);
  return runAssetHelper(["inspect", "--file", target]);
}

export async function streamQuarantinedImage(response, side, token, encodedName) {
  const target = await resolveQuarantinedImage(side, token, encodedName);
  return streamImageFile(response, target, {
    label: "隔离图片",
    unsafeCode: "QUARANTINE_PATH_UNSAFE",
  });
}

export async function streamAlignedPoster(response, side) {
  const directory = await verifyAlignedDirectory(side);
  if (!directory) {
    throw new AssetError("aligned 预览图不存在", "IMAGE_MISSING", 404);
  }
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && IMAGE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (!names.length) {
    throw new AssetError("aligned 预览图不存在", "IMAGE_MISSING", 404);
  }
  return streamAlignedImage(response, side, encodeURIComponent(names[0]));
}

export async function quarantineAlignedImage(side, encodedName) {
  const target = await resolveExistingAlignedImage(side, encodedName);
  const { token, directory } = await createQuarantineTokenDirectory(side);
  await rename(target, path.join(directory, path.basename(target)));
  invalidateAnalysis(side);
  return { side, token, name: path.basename(target), recoverable: true };
}

export async function quarantineAlignedImages(side, names) {
  if (!Array.isArray(names) || !names.length || names.length > 500) {
    throw new AssetError("批量隔离需要 1–500 个文件", "QUARANTINE_BATCH_INVALID");
  }
  const uniqueNames = [...new Set(names.map((name) => String(name)))];
  const targets = await Promise.all(uniqueNames.map((name) => (
    resolveExistingAlignedImage(side, encodeURIComponent(name))
  )));
  const { token, directory: destinationDirectory } = await createQuarantineTokenDirectory(side);
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

export async function listAlignedQuarantine(side, { offset = 0, limit = 60 } = {}) {
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const root = await verifyQuarantineRoot(side);
  if (!root) {
    return { side, total: 0, offset: safeOffset, limit: safeLimit, items: [] };
  }
  const result = await runAssetHelper([
    "quarantine-list",
    "--directory",
    root,
    "--offset",
    String(safeOffset),
    "--limit",
    String(safeLimit),
  ]);
  return {
    side,
    ...result,
    items: result.items.map((item) => ({
      ...item,
      imageUrl: (
        `/api/assets/${side}/quarantine/${encodeURIComponent(item.token)}`
        + `/${encodeURIComponent(item.name)}`
      ),
    })),
  };
}

export async function restoreAlignedImage(side, token, encodedName) {
  const destination = resolveAlignedImage(side, encodedName);
  const name = path.basename(destination);
  const source = await resolveQuarantinedImage(side, token, encodedName);
  await ensureSafeAlignedDirectory(side);
  const { fileHandle, fileInfo: sourceInfo } = await openVerifiedImage(
    source,
    "隔离图片",
    "QUARANTINE_PATH_UNSAFE",
  );
  let installed = false;
  try {
    try {
      // A hard-link install is complete-or-absent and refuses to overwrite an existing name.
      await link(source, destination);
      installed = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new AssetError("aligned 中已有同名图片，不能覆盖恢复", "RESTORE_CONFLICT", 409);
      }
      throw error;
    }
    const {
      fileHandle: destinationHandle,
      fileInfo: destinationInfo,
    } = await openVerifiedImage(destination, "恢复目标", "RESTORE_INSTALL_UNSAFE");
    try {
      if (!sameFileIdentity(sourceInfo, destinationInfo)) {
        throw new AssetError("恢复目标未能安全提交", "RESTORE_INSTALL_UNSAFE", 500);
      }
    } finally {
      await destinationHandle.close().catch(() => {});
    }
  } catch (error) {
    if (installed) await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await fileHandle.close().catch(() => {});
  }
  try {
    await unlink(source);
  } catch (error) {
    try {
      await unlink(destination);
    } catch {
      // Keep the original unlink failure; the source remains the recovery authority.
    }
    throw error;
  }
  invalidateAnalysis(side);
  return { side, token, name, restored: true };
}
