import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const webuiRoot = path.resolve(serverDirectory, "..");
const repositoryRoot = path.resolve(webuiRoot, "..");
const internalRoot = path.join(repositoryRoot, "_internal");
const workspaceRoot = path.join(repositoryRoot, "workspace");
const runtimeRoot = path.join(workspaceRoot, ".webui");

export const PATHS = Object.freeze({
  serverDirectory,
  webuiRoot,
  repositoryRoot,
  internalRoot,
  workspaceRoot,
  runtimeRoot,
  jobsRoot: path.join(runtimeRoot, "jobs"),
  archiveRoot: path.join(runtimeRoot, "archive"),
  python: path.join(internalRoot, "python_common", "python.exe"),
  ffprobe: path.join(internalRoot, "ffmpeg", "ffprobe.exe"),
  currentMain: path.join(internalRoot, "DeepFaceLab", "main.py"),
  legacyMain: path.join(internalRoot, "DeepFaceLab_old", "main.py"),
  currentDflRoot: path.join(internalRoot, "DeepFaceLab"),
  legacyDflRoot: path.join(internalRoot, "DeepFaceLab_old"),
  staticRoot: path.join(webuiRoot, "dist", "client"),
});

function canonicalForComparison(value) {
  return path.resolve(value).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

export function assertWithin(parent, candidate, label = "路径") {
  const parentPath = canonicalForComparison(parent);
  const candidatePath = canonicalForComparison(candidate);
  if (candidatePath !== parentPath && !candidatePath.startsWith(`${parentPath}\\`)) {
    throw new Error(`${label}超出允许范围`);
  }
  return path.resolve(candidate);
}

export function jobDirectory(jobId) {
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/i.test(jobId)) {
    throw new Error("任务 ID 不合法");
  }
  return assertWithin(PATHS.jobsRoot, path.join(PATHS.jobsRoot, jobId), "任务目录");
}

export async function pathExists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureRuntimeDirectories() {
  await Promise.all([
    mkdir(PATHS.jobsRoot, { recursive: true }),
    mkdir(PATHS.archiveRoot, { recursive: true }),
    mkdir(path.join(PATHS.internalRoot, "_e", "t"), { recursive: true }),
    mkdir(path.join(PATHS.internalRoot, "_e", "u", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(PATHS.internalRoot, "_e", "u", "AppData", "Roaming"), { recursive: true }),
  ]);
}

export async function writeJsonAtomic(target, value) {
  assertWithin(PATHS.runtimeRoot, target, "运行时文件");
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}
