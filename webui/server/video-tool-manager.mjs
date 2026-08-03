import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PATHS, assertWithin, pathExists, readJson, writeJsonAtomic } from "./paths.mjs";
import { inspectWorkspace, resolveWorkspaceMaterial } from "./workspace-manager.mjs";

const IMAGE_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,220}\.(?:jpe?g|png)$/i;
const SEGMENT_ID = /^seg-[a-f0-9]{10}$/;
const ARCHIVE_TOKEN = /^\d{14}-[a-f0-9]{10}$/;
const MAX_SEGMENTS = 100;

export class VideoToolError extends Error {
  constructor(message, code = "VIDEO_TOOL_ERROR", status = 400, details) {
    super(message);
    this.name = "VideoToolError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertSide(side) {
  if (!new Set(["src", "dst"]).has(side)) {
    throw new VideoToolError("素材类型不受支持", "SIDE_INVALID");
  }
}

function videoRoot() {
  return path.join(PATHS.runtimeRoot, "video");
}

function manifestPath(side, kind) {
  assertSide(side);
  return assertWithin(videoRoot(), path.join(videoRoot(), `${side}-${kind}.json`), "视频清单");
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function normalizeSegments(segments, duration) {
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    throw new VideoToolError(`分段数量必须在 0–${MAX_SEGMENTS} 之间`, "SEGMENTS_INVALID");
  }
  const normalized = segments.map((segment, index) => {
    const start = finite(segment?.start);
    const end = finite(segment?.end);
    if (start === null || end === null || start < 0 || end <= start || end - start < 0.08) {
      throw new VideoToolError(`第 ${index + 1} 个分段时间范围无效`, "SEGMENT_RANGE_INVALID");
    }
    if (duration && end > duration + 0.05) {
      throw new VideoToolError(`第 ${index + 1} 个分段超出视频时长`, "SEGMENT_RANGE_INVALID");
    }
    return {
      id: SEGMENT_ID.test(segment?.id) ? segment.id : `seg-${randomBytes(5).toString("hex")}`,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      label: String(segment?.label ?? `片段 ${index + 1}`).trim().slice(0, 48) || `片段 ${index + 1}`,
      selected: segment?.selected !== false,
    };
  });
  return normalized.sort((a, b) => a.start - b.start || a.end - b.end);
}

async function fingerprintMaterial(target) {
  const fileStat = await stat(target);
  return {
    name: path.basename(target),
    bytes: fileStat.size,
    modifiedAtMs: Math.round(fileStat.mtimeMs),
  };
}

function runProcess(executable, args, { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new VideoToolError("视频处理超过安全时限，已终止", "VIDEO_TOOL_TIMEOUT", 504));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        child.kill();
        finish(reject, new VideoToolError("视频工具输出过大，已终止", "VIDEO_TOOL_OUTPUT_LIMIT", 500));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(resolve, result);
      else finish(reject, new VideoToolError(
        result.stderr.trim().split(/\r?\n/).slice(-4).join("\n") || "视频工具执行失败",
        "VIDEO_TOOL_FAILED",
        422,
      ));
    });
  });
}

async function readManifest(side, kind) {
  const target = manifestPath(side, kind);
  if (!(await pathExists(target))) return null;
  try {
    return await readJson(target);
  } catch {
    return null;
  }
}

export async function listFrameArchives(side) {
  assertSide(side);
  const root = path.join(PATHS.archiveRoot, "frames", side);
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ARCHIVE_TOKEN.test(entry.name)) continue;
    const files = (await readdir(path.join(root, entry.name), { withFileTypes: true }))
      .filter((file) => file.isFile() && IMAGE_NAME.test(file.name));
    if (files.length) archives.push({ side, token: entry.name, frameCount: files.length });
  }
  return archives.sort((left, right) => right.token.localeCompare(left.token));
}

export async function inspectVideoTimeline(side) {
  assertSide(side);
  const workspace = await inspectWorkspace();
  const material = workspace.materials?.[side] ?? null;
  if (!material) {
    return { side, material: null, scenes: [], segments: [], archives: await listFrameArchives(side), sceneThreshold: 0.35 };
  }
  const fingerprint = await fingerprintMaterial(material.path);
  const [sceneManifest, segmentManifest, archives] = await Promise.all([
    readManifest(side, "scenes"),
    readManifest(side, "segments"),
    listFrameArchives(side),
  ]);
  const sameMaterial = (manifest) => (
    manifest?.material?.name === fingerprint.name
    && manifest.material.bytes === fingerprint.bytes
    && manifest.material.modifiedAtMs === fingerprint.modifiedAtMs
  );
  return {
    side,
    material: {
      ...material,
      path: undefined,
      url: `/api/workspace/materials/${side}`,
    },
    scenes: sameMaterial(sceneManifest) ? sceneManifest.scenes ?? [] : [],
    sceneThreshold: sameMaterial(sceneManifest) ? sceneManifest.threshold : 0.35,
    segments: sameMaterial(segmentManifest) ? segmentManifest.segments ?? [] : [],
    archives,
  };
}

export async function detectVideoScenes(side, { threshold = 0.35 } = {}) {
  assertSide(side);
  const safeThreshold = Math.min(Math.max(Number(threshold) || 0.35, 0.08), 0.85);
  if (!(await pathExists(PATHS.ffmpeg))) {
    throw new VideoToolError("内置 ffmpeg 不存在", "FFMPEG_MISSING", 503);
  }
  const [material, workspace] = await Promise.all([resolveWorkspaceMaterial(side), inspectWorkspace()]);
  const duration = Number(workspace.materials?.[side]?.durationSeconds) || 0;
  const { stderr } = await runProcess(PATHS.ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-i",
    material,
    "-filter:v",
    `select=gt(scene\\,${safeThreshold}),showinfo`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const detected = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && (!duration || value < duration));
  const cuts = [0, ...detected.sort((a, b) => a - b), ...(duration ? [duration] : [])]
    .filter((value, index, values) => index === 0 || value - values[index - 1] >= 0.12)
    .slice(0, 501);
  const scenes = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    scenes.push({
      id: `scene-${String(index + 1).padStart(3, "0")}`,
      start: Math.round(cuts[index] * 1000) / 1000,
      end: Math.round(cuts[index + 1] * 1000) / 1000,
    });
  }
  const manifest = {
    schemaVersion: 1,
    side,
    material: await fingerprintMaterial(material),
    threshold: safeThreshold,
    analyzedAt: new Date().toISOString(),
    scenes,
  };
  await mkdir(videoRoot(), { recursive: true });
  await writeJsonAtomic(manifestPath(side, "scenes"), manifest);
  return { side, threshold: safeThreshold, scenes };
}

export async function saveVideoSegments(side, { segments } = {}) {
  assertSide(side);
  const [material, workspace] = await Promise.all([resolveWorkspaceMaterial(side), inspectWorkspace()]);
  const duration = Number(workspace.materials?.[side]?.durationSeconds) || 0;
  const normalized = normalizeSegments(segments, duration);
  const manifest = {
    schemaVersion: 1,
    side,
    material: await fingerprintMaterial(material),
    updatedAt: new Date().toISOString(),
    segments: normalized,
  };
  await mkdir(videoRoot(), { recursive: true });
  await writeJsonAtomic(manifestPath(side, "segments"), manifest);
  return { side, segments: normalized };
}

export async function extractVideoSegments(side, { segments, fps = 0 } = {}) {
  assertSide(side);
  if (!(await pathExists(PATHS.ffmpeg))) {
    throw new VideoToolError("内置 ffmpeg 不存在", "FFMPEG_MISSING", 503);
  }
  const [material, workspace] = await Promise.all([resolveWorkspaceMaterial(side), inspectWorkspace()]);
  const duration = Number(workspace.materials?.[side]?.durationSeconds) || 0;
  const requested = segments ?? (await readManifest(side, "segments"))?.segments ?? [];
  const selected = normalizeSegments(requested, duration).filter((segment) => segment.selected);
  if (!selected.length) throw new VideoToolError("至少选择一个分段", "SEGMENTS_EMPTY");
  const safeFps = Number(fps) === 0 ? 0 : Math.min(Math.max(Number(fps) || 0, 1), 60);
  const token = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(5).toString("hex")}`;
  const root = videoRoot();
  const staging = assertWithin(root, path.join(root, "staging", `${side}-${token}`), "提帧暂存目录");
  const frameRoot = path.join(PATHS.workspaceRoot, `data_${side}`);
  const archive = assertWithin(PATHS.archiveRoot, path.join(PATHS.archiveRoot, "frames", side, token), "帧归档目录");
  await mkdir(staging, { recursive: true });
  const movedExisting = [];
  const installed = [];
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const segment = selected[index];
      const output = path.join(staging, `s${String(index + 1).padStart(3, "0")}_%08d.jpg`);
      const args = [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(segment.start),
        "-t", String(segment.end - segment.start), "-i", material, "-an",
        ...(safeFps ? ["-vf", `fps=${safeFps}`] : ["-vsync", "0"]),
        "-q:v", "2", output,
      ];
      await runProcess(PATHS.ffmpeg, args);
    }
    const stagedFiles = (await readdir(staging, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_NAME.test(entry.name));
    if (!stagedFiles.length) throw new VideoToolError("选定分段没有生成任何帧", "NO_FRAMES_EXTRACTED", 422);
    await Promise.all([mkdir(frameRoot, { recursive: true }), mkdir(archive, { recursive: true })]);
    const existing = (await readdir(frameRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_NAME.test(entry.name));
    for (const entry of existing) {
      await rename(path.join(frameRoot, entry.name), path.join(archive, entry.name));
      movedExisting.push(entry.name);
    }
    for (const entry of stagedFiles) {
      await rename(path.join(staging, entry.name), path.join(frameRoot, entry.name));
      installed.push(entry.name);
    }
    await rm(staging, { recursive: true, force: true });
    return {
      side,
      token,
      segmentCount: selected.length,
      frameCount: installed.length,
      archivedFrameCount: movedExisting.length,
      recoverableArchive: archive,
      fps: safeFps,
    };
  } catch (error) {
    for (const name of installed) {
      const target = path.join(frameRoot, name);
      if (await pathExists(target)) await rename(target, path.join(staging, name));
    }
    for (const name of movedExisting) {
      const source = path.join(archive, name);
      if (await pathExists(source)) await rename(source, path.join(frameRoot, name));
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreFrameArchive(side, token) {
  assertSide(side);
  if (!ARCHIVE_TOKEN.test(token)) throw new VideoToolError("帧归档令牌无效", "FRAME_ARCHIVE_INVALID");
  const archiveRoot = path.join(PATHS.archiveRoot, "frames", side);
  const source = assertWithin(archiveRoot, path.join(archiveRoot, token), "帧归档");
  if (!(await pathExists(source))) throw new VideoToolError("帧归档不存在", "FRAME_ARCHIVE_MISSING", 404);
  const archived = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && IMAGE_NAME.test(entry.name));
  if (!archived.length) throw new VideoToolError("帧归档为空", "FRAME_ARCHIVE_EMPTY", 409);
  const frameRoot = path.join(PATHS.workspaceRoot, `data_${side}`);
  const undoToken = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(5).toString("hex")}`;
  const undo = assertWithin(archiveRoot, path.join(archiveRoot, undoToken), "当前帧撤销归档");
  await Promise.all([mkdir(frameRoot, { recursive: true }), mkdir(undo, { recursive: true })]);
  const current = (await readdir(frameRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && IMAGE_NAME.test(entry.name));
  const movedCurrent = [];
  const restored = [];
  try {
    for (const entry of current) {
      await rename(path.join(frameRoot, entry.name), path.join(undo, entry.name));
      movedCurrent.push(entry.name);
    }
    for (const entry of archived) {
      await rename(path.join(source, entry.name), path.join(frameRoot, entry.name));
      restored.push(entry.name);
    }
    return { side, token, restoredFrameCount: restored.length, undoToken, recoverable: true };
  } catch (error) {
    for (const name of restored) {
      const target = path.join(frameRoot, name);
      if (await pathExists(target)) await rename(target, path.join(source, name));
    }
    for (const name of movedCurrent) {
      const backup = path.join(undo, name);
      if (await pathExists(backup)) await rename(backup, path.join(frameRoot, name));
    }
    throw error;
  }
}
