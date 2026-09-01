import { createWriteStream } from "node:fs";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { PATHS, assertWithin, pathExists } from "./paths.mjs";
import { inspectStorage } from "./system-diagnostics.mjs";

const execFileAsync = promisify(execFile);
const VIDEO_EXTENSIONS = new Set([".avi", ".mkv", ".mov", ".mp4", ".m4v", ".webm"]);
const REVIEW_IMAGE_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,220}\.(?:jpe?g|png)$/i;
const REVIEW_SLOTS = Object.freeze({
  "src-frame": path.join(PATHS.workspaceRoot, "data_src"),
  "dst-frame": path.join(PATHS.workspaceRoot, "data_dst"),
  merged: path.join(PATHS.workspaceRoot, "data_dst", "merged"),
  mask: path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
});
const MAX_VIDEO_BYTES = 100 * 1024 * 1024 * 1024;
const MATERIAL_ARCHIVE_TOKEN = /^\d{14}(?:-[a-f0-9]{10})?$/;
const ARTIFACTS = Object.freeze({
  "result.mp4": path.join(PATHS.workspaceRoot, "result.mp4"),
  "result_mask.mp4": path.join(PATHS.workspaceRoot, "result_mask.mp4"),
  "result.avi": path.join(PATHS.workspaceRoot, "result.avi"),
  "result_mask.avi": path.join(PATHS.workspaceRoot, "result_mask.avi"),
  "result.mov": path.join(PATHS.workspaceRoot, "result.mov"),
  "result_mask.mov": path.join(PATHS.workspaceRoot, "result_mask.mov"),
});

export class WorkspaceError extends Error {
  constructor(message, code = "WORKSPACE_ERROR", status = 400, details) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function directFileStats(target, accept = () => true) {
  if (!(await pathExists(target))) return { count: 0, bytes: 0, modifiedAt: null };
  const entries = await readdir(target, { withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && !entry.name.startsWith(".") && accept(entry.name),
  );
  const stats = await Promise.all(files.map((entry) => stat(path.join(target, entry.name))));
  return {
    count: files.length,
    bytes: stats.reduce((total, fileStat) => total + fileStat.size, 0),
    modifiedAt: stats.length
      ? new Date(Math.max(...stats.map((fileStat) => fileStat.mtimeMs))).toISOString()
      : null,
  };
}

async function describeFile(target) {
  if (!(await pathExists(target))) return null;
  const fileStat = await stat(target);
  if (!fileStat.isFile()) return null;
  return {
    name: path.basename(target),
    path: target,
    extension: path.extname(target).toLowerCase(),
    bytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
  };
}

async function findMaterial(side) {
  const entries = await readdir(PATHS.workspaceRoot, { withFileTypes: true });
  const prefix = `data_${side}`;
  const entry = entries
    .filter((candidate) => candidate.isFile())
    .find((candidate) => (
      candidate.name.toLowerCase().startsWith(`${prefix}.`)
      && VIDEO_EXTENSIONS.has(path.extname(candidate.name).toLowerCase())
    ));
  if (!entry) return null;
  const target = path.join(PATHS.workspaceRoot, entry.name);
  const material = await describeFile(target);
  if (!material || !(await pathExists(PATHS.ffprobe))) return material;
  try {
    const { stdout } = await execFileAsync(PATHS.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,avg_frame_rate",
      "-of",
      "json",
      target,
    ], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    return {
      ...material,
      durationSeconds: Number(probe.format?.duration) || null,
      width: Number(video?.width) || null,
      height: Number(video?.height) || null,
      frameRate: video?.avg_frame_rate ?? null,
    };
  } catch {
    return material;
  }
}

function materialArchiveToken() {
  return `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(5).toString("hex")}`;
}

function validateMaterialSide(side) {
  if (!["src", "dst"].includes(side)) {
    throw new WorkspaceError("素材类型不受支持", "SIDE_INVALID");
  }
}

function validateMaterialArchiveToken(token) {
  if (!MATERIAL_ARCHIVE_TOKEN.test(token ?? "")) {
    throw new WorkspaceError("素材归档标识无效", "MATERIAL_ARCHIVE_INVALID");
  }
  return token;
}

async function writeArchiveManifest(directory, manifest) {
  const target = path.join(directory, "manifest.json");
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function verifyMaterialArchiveDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspaceError("素材归档目录不安全", "MATERIAL_ARCHIVE_UNSAFE", 400);
  }
  const [workspaceRealPath, directoryRealPath] = await Promise.all([
    realpath(PATHS.workspaceRoot),
    realpath(directory),
  ]);
  try {
    assertWithin(workspaceRealPath, directoryRealPath, "素材归档目录");
  } catch {
    throw new WorkspaceError("素材归档目录超出工作区", "MATERIAL_ARCHIVE_UNSAFE", 400);
  }
  return directory;
}

async function ensureSafeMaterialArchiveRoot(side) {
  await verifyMaterialArchiveDirectory(PATHS.runtimeRoot);
  const segments = [
    PATHS.archiveRoot,
    path.join(PATHS.archiveRoot, "materials"),
    path.join(PATHS.archiveRoot, "materials", side),
  ];
  for (const directory of segments) {
    await mkdir(directory, { recursive: true });
    await verifyMaterialArchiveDirectory(directory);
  }
  return segments.at(-1);
}

async function archiveMaterialFile(side, material) {
  const token = materialArchiveToken();
  const archiveRoot = await ensureSafeMaterialArchiveRoot(side);
  const directory = path.join(archiveRoot, token);
  const archivedPath = path.join(directory, material.name);
  await mkdir(directory, { recursive: true });
  await verifyMaterialArchiveDirectory(directory);
  await rename(material.path, archivedPath);
  const manifest = {
    schemaVersion: 1,
    token,
    side,
    originalName: material.name,
    archivedAt: new Date().toISOString(),
    bytes: material.bytes,
  };
  try {
    await writeArchiveManifest(directory, manifest);
  } catch (error) {
    await rollbackArchivedMaterial({
      ...manifest,
      directory,
      archivedPath,
      originalPath: material.path,
    });
    throw error;
  }
  return { ...manifest, directory, archivedPath, originalPath: material.path };
}

export async function rollbackArchivedMaterial(archive, {
  renameFile = rename,
  removeDirectory = rm,
} = {}) {
  try {
    await renameFile(archive.archivedPath, archive.originalPath);
  } catch {
    throw new WorkspaceError(
      "素材回滚失败；恢复副本已保留，请停止覆盖并检查恢复历史",
      "MATERIAL_ROLLBACK_FAILED",
      500,
      { token: archive.token, side: archive.side },
    );
  }
  await removeDirectory(archive.directory, { recursive: true, force: true }).catch(() => {});
}

async function readMaterialArchive(side, token) {
  validateMaterialSide(side);
  validateMaterialArchiveToken(token);
  const modernDirectory = path.join(PATHS.archiveRoot, "materials", side, token);
  const legacyDirectory = path.join(PATHS.archiveRoot, "materials", token);
  for (const directory of [modernDirectory, legacyDirectory]) {
    if (!(await pathExists(directory))) continue;
    await verifyMaterialArchiveDirectory(directory);
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    } catch {
      // Legacy archives predate manifests; the allowlisted filename is sufficient.
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const expectedPrefix = `data_${side}.`;
    const file = entries.find((entry) => (
      entry.isFile()
      && entry.name.toLowerCase().startsWith(expectedPrefix)
      && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ));
    if (!file) continue;
    const archivedPath = path.join(directory, file.name);
    const fileStat = await stat(archivedPath);
    return {
      token,
      side,
      originalName: file.name,
      archivedAt: manifest?.archivedAt ?? fileStat.mtime.toISOString(),
      bytes: fileStat.size,
      directory,
      archivedPath,
    };
  }
  throw new WorkspaceError("素材归档不存在", "MATERIAL_ARCHIVE_MISSING", 404);
}

export async function listWorkspaceMaterialArchives(side) {
  validateMaterialSide(side);
  const root = path.join(PATHS.archiveRoot, "materials");
  if (!(await pathExists(root))) return [];
  await verifyMaterialArchiveDirectory(root);
  const candidates = [];
  const modernRoot = path.join(root, side);
  if (await pathExists(modernRoot)) {
    await verifyMaterialArchiveDirectory(modernRoot);
    const entries = await readdir(modernRoot, { withFileTypes: true });
    candidates.push(...entries
      .filter((entry) => entry.isDirectory() && MATERIAL_ARCHIVE_TOKEN.test(entry.name))
      .map((entry) => entry.name));
  }
  const legacyEntries = await readdir(root, { withFileTypes: true });
  candidates.push(...legacyEntries
    .filter((entry) => entry.isDirectory() && MATERIAL_ARCHIVE_TOKEN.test(entry.name))
    .map((entry) => entry.name));
  const unique = [...new Set(candidates)].sort().reverse().slice(0, 200);
  const records = await Promise.all(unique.map((token) => readMaterialArchive(side, token).catch(() => null)));
  return records.filter(Boolean).map(({ directory: _directory, archivedPath: _archivedPath, ...record }) => record);
}

export async function restoreWorkspaceMaterial(side, token) {
  const archive = await readMaterialArchive(side, token);
  const existing = await findMaterial(side);
  let undoArchive = null;
  if (existing) undoArchive = await archiveMaterialFile(side, existing);
  const target = path.join(PATHS.workspaceRoot, archive.originalName);
  try {
    await rename(archive.archivedPath, target);
  } catch (error) {
    if (undoArchive) {
      await rollbackArchivedMaterial(undoArchive);
    }
    throw error;
  }
  await rm(archive.directory, { recursive: true, force: true }).catch(() => {});
  return {
    side,
    token,
    restored: await describeFile(target),
    undoToken: undoArchive?.token ?? null,
  };
}

async function discoverModels() {
  const modelDirectory = path.join(PATHS.workspaceRoot, "model");
  const xsegDirectory = path.join(PATHS.workspaceRoot, "xseg_model");
  const [modelStats, saehdStats, xsegStats] = await Promise.all([
    directFileStats(modelDirectory, (name) => /_(?:SAEHD|ME|AMP|Q384|Q512)_/i.test(name)),
    directFileStats(modelDirectory, (name) => /_SAEHD_/i.test(name)),
    directFileStats(xsegDirectory, (name) => !/\.(?:bat|cmd|ps1|txt)$/i.test(name)),
  ]);
  const entries = (await pathExists(modelDirectory))
    ? await readdir(modelDirectory, { withFileTypes: true })
    : [];
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(.+)_(SAEHD|ME|AMP|Q384|Q512)_/i);
    if (!match) continue;
    const name = match[1];
    const type = match[2].toUpperCase();
    const key = `${type}:${name}`;
    const current = grouped.get(key) ?? {
      name,
      type,
      fileCount: 0,
      bytes: 0,
      modifiedAt: null,
      files: [],
    };
    const fileStat = await stat(path.join(modelDirectory, entry.name));
    current.fileCount += 1;
    current.bytes += fileStat.size;
    current.files.push(entry.name);
    current.modifiedAt = !current.modifiedAt || fileStat.mtime.toISOString() > current.modifiedAt
      ? fileStat.mtime.toISOString()
      : current.modifiedAt;
    grouped.set(key, current);
  }
  const models = [...grouped.values()].sort((a, b) => (
    (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "")
  ));
  if (xsegStats.count) {
    models.push({
      name: "xseg_model",
      type: "XSeg",
      fileCount: xsegStats.count,
      bytes: xsegStats.bytes,
      modifiedAt: xsegStats.modifiedAt,
    });
  }
  return { models, modelStats, saehdStats, xsegStats };
}

export async function inspectExportReadiness() {
  const modelInfo = await discoverModels();
  const modelDirectory = path.join(PATHS.workspaceRoot, "model");
  const entries = (await pathExists(modelDirectory))
    ? await readdir(modelDirectory, { withFileTypes: true })
    : [];
  const dfmOutputs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dfm"))
    .map(async (entry) => {
      const fileStat = await stat(path.join(modelDirectory, entry.name));
      return {
        name: entry.name,
        bytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      };
    }));
  const models = modelInfo.models
    .filter((model) => model.type !== "XSeg")
    .map((model) => {
      const dataFiles = model.files.filter((name) => /_data\.dat$/i.test(name));
      const weightFiles = model.files.filter((name) => /\.(?:npy|dat)$/i.test(name) && !/_data\.dat$/i.test(name));
      const commandId = `export.dfm_${model.type.toLowerCase()}`;
      const supported = ["SAEHD", "ME", "Q384", "Q512"].includes(model.type);
      const ready = supported && dataFiles.length > 0 && weightFiles.length > 0;
      return {
        ...model,
        files: model.files.slice().sort(),
        dataFileCount: dataFiles.length,
        weightFileCount: weightFiles.length,
        supported,
        ready,
        commandId: supported ? commandId : null,
        blockers: [
          ...(!supported ? ["model_type_not_exportable"] : []),
          ...(dataFiles.length ? [] : ["model_data_missing"]),
          ...(weightFiles.length ? [] : ["model_weights_missing"]),
        ],
      };
    });
  return {
    modelCount: models.length,
    readyCount: models.filter((model) => model.ready).length,
    outputCount: dfmOutputs.length,
    models,
    outputs: dfmOutputs,
  };
}

export async function listMergeReview({ offset = 0, limit = 120 } = {}) {
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 240);
  const directories = Object.fromEntries(await Promise.all(
    ["dst-frame", "merged", "mask"].map(async (slot) => {
      const directory = REVIEW_SLOTS[slot];
      const entries = (await pathExists(directory))
        ? await readdir(directory, { withFileTypes: true })
        : [];
      return [slot, entries
        .filter((entry) => entry.isFile() && REVIEW_IMAGE_NAME.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
    }),
  ));
  const mergedSet = new Set(directories.merged);
  const maskSet = new Set(directories.mask);
  const names = directories["dst-frame"];
  return {
    total: names.length,
    offset: safeOffset,
    limit: safeLimit,
    completeCount: names.filter((name) => mergedSet.has(name) && maskSet.has(name)).length,
    missingMergedCount: names.filter((name) => !mergedSet.has(name)).length,
    missingMaskCount: names.filter((name) => !maskSet.has(name)).length,
    items: names.slice(safeOffset, safeOffset + safeLimit).map((name) => ({
      name,
      sourceUrl: `/api/workspace/review/dst-frame/${encodeURIComponent(name)}`,
      mergedUrl: mergedSet.has(name)
        ? `/api/workspace/review/merged/${encodeURIComponent(name)}`
        : null,
      maskUrl: maskSet.has(name)
        ? `/api/workspace/review/mask/${encodeURIComponent(name)}`
        : null,
      complete: mergedSet.has(name) && maskSet.has(name),
    })),
  };
}

export function resolveReviewAsset(slot, encodedName) {
  const directory = REVIEW_SLOTS[slot];
  if (!directory) {
    throw new WorkspaceError("复核资源槽不在允许列表", "REVIEW_SLOT_INVALID", 404);
  }
  let name;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new WorkspaceError("复核资源文件名无效", "REVIEW_NAME_INVALID");
  }
  if (!REVIEW_IMAGE_NAME.test(name) || path.basename(name) !== name) {
    throw new WorkspaceError("复核资源文件名不在允许范围", "REVIEW_NAME_INVALID");
  }
  return path.join(directory, name);
}

export async function resolveWorkspaceMaterial(side) {
  if (!["src", "dst"].includes(side)) {
    throw new WorkspaceError("素材类型不受支持", "SIDE_INVALID");
  }
  const material = await findMaterial(side);
  if (!material) {
    throw new WorkspaceError("工作区素材尚未导入", "MATERIAL_MISSING", 404);
  }
  return material.path;
}

export async function inspectWorkspace() {
  const [
    srcMaterial,
    dstMaterial,
    srcFrames,
    dstFrames,
    srcFaces,
    dstFaces,
    merged,
    mergedMask,
    modelInfo,
    outputFiles,
    storage,
  ] = await Promise.all([
    findMaterial("src"),
    findMaterial("dst"),
    directFileStats(path.join(PATHS.workspaceRoot, "data_src")),
    directFileStats(path.join(PATHS.workspaceRoot, "data_dst")),
    directFileStats(path.join(PATHS.workspaceRoot, "data_src", "aligned")),
    directFileStats(path.join(PATHS.workspaceRoot, "data_dst", "aligned")),
    directFileStats(path.join(PATHS.workspaceRoot, "data_dst", "merged")),
    directFileStats(path.join(PATHS.workspaceRoot, "data_dst", "merged_mask")),
    discoverModels(),
    Promise.all(Object.values(ARTIFACTS).map(describeFile)),
    inspectStorage(PATHS.workspaceRoot).catch((error) => ({
      ready: null,
      error: error?.code ?? "STORAGE_UNAVAILABLE",
      sampledAt: new Date().toISOString(),
    })),
  ]);
  return {
    root: PATHS.workspaceRoot,
    materials: { src: srcMaterial, dst: dstMaterial },
    datasets: {
      srcFrames,
      dstFrames,
      srcFaces,
      dstFaces,
      merged,
      mergedMask,
    },
    models: modelInfo.models,
    outputs: outputFiles.filter(Boolean).map((file) => ({
      ...file,
      url: `/api/workspace/artifacts/${encodeURIComponent(file.name)}`,
    })),
    storage,
    readiness: {
      materials: Boolean(srcMaterial && dstMaterial),
      frames: srcFrames.count > 0 && dstFrames.count > 0,
      faces: srcFaces.count > 0 && dstFaces.count > 0,
      xseg: modelInfo.xsegStats.count > 0,
      model: modelInfo.modelStats.count > 0,
      saehd: modelInfo.saehdStats.count > 0,
      merged: merged.count > 0 && mergedMask.count > 0,
      encoded: outputFiles.filter(Boolean).length >= 2,
    },
  };
}

function createLimitTransform() {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_VIDEO_BYTES) {
        callback(new WorkspaceError("视频文件超过 100 GB 限制", "VIDEO_TOO_LARGE", 413));
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function importWorkspaceVideo(side, request, {
  encodedFileName,
  replace = false,
  inspectStorageFn = inspectStorage,
} = {}) {
  validateMaterialSide(side);
  let fileName;
  try {
    fileName = path.basename(decodeURIComponent(encodedFileName ?? ""));
  } catch {
    throw new WorkspaceError("视频文件名无效", "FILE_NAME_INVALID");
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension)) {
    throw new WorkspaceError(
      "只支持 MP4、MOV、AVI、MKV、M4V 或 WEBM 视频",
      "VIDEO_TYPE_NOT_ALLOWED",
    );
  }
  const declaredSize = Number(request.headers["content-length"] ?? 0);
  if (declaredSize > MAX_VIDEO_BYTES) {
    throw new WorkspaceError("视频文件超过 100 GB 限制", "VIDEO_TOO_LARGE", 413);
  }
  if (Number.isFinite(declaredSize) && declaredSize > 0) {
    const storage = await inspectStorageFn(PATHS.workspaceRoot, { requiredBytes: declaredSize });
    if (!storage.ready) {
      throw new WorkspaceError(
        "工作区可用空间不足；已保留 5 GB 安全余量，请清理磁盘后重试",
        "STORAGE_INSUFFICIENT",
        507,
        {
          requiredBytes: storage.requiredBytes,
          usableBytes: storage.usableBytes,
          shortfallBytes: storage.shortfallBytes,
          reserveBytes: storage.reserveBytes,
        },
      );
    }
  }
  const existing = await findMaterial(side);
  if (existing && !replace) {
    throw new WorkspaceError(
      `${side.toUpperCase()} 视频已存在；请确认更换后重试`,
      "MATERIAL_EXISTS",
      409,
      { existing: existing.name },
    );
  }

  const importDirectory = path.join(PATHS.runtimeRoot, "imports");
  await mkdir(importDirectory, { recursive: true });
  const temporary = path.join(
    importDirectory,
    `${side}-${Date.now()}-${randomBytes(5).toString("hex")}.upload`,
  );
  try {
    await pipeline(request, createLimitTransform(), createWriteStream(temporary, { flags: "wx" }));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }

  const archived = existing ? await archiveMaterialFile(side, existing) : null;
  const target = path.join(PATHS.workspaceRoot, `data_${side}${extension}`);
  try {
    await rename(temporary, target);
  } catch (error) {
    let rollbackError = null;
    if (archived) await rollbackArchivedMaterial(archived).catch((cause) => { rollbackError = cause; });
    await unlink(temporary).catch(() => {});
    if (rollbackError) throw rollbackError;
    throw error;
  }
  return {
    ...(await describeFile(target)),
    archiveToken: archived?.token ?? null,
  };
}

export function resolveWorkspaceArtifact(name) {
  const target = ARTIFACTS[name];
  if (!target) {
    throw new WorkspaceError("输出文件不在允许列表中", "ARTIFACT_NOT_ALLOWED", 404);
  }
  return target;
}
