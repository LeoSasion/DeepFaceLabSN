import { mkdir, readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { releaseVersion } from "../../release/version.mjs";
import { PATHS, writeJsonAtomic } from "./paths.mjs";

const root = path.join(PATHS.runtimeRoot, "exports");
const outputName = /^result(?:_mask)?\.(?:mp4|avi|mov)$/;

async function safeRoot() {
  for (const directory of [PATHS.workspaceRoot,PATHS.runtimeRoot,root]) {
    const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("导出记录路径不是普通目录");
  }
}

export async function recordExport(job) {
  if (job.state !== "succeeded" || !job.commandId?.startsWith("encode.")) return;
  if (!/^[a-z0-9-]+$/.test(job.id)) throw new Error("导出记录 ID 无效");
  await safeRoot();
  await mkdir(root, { recursive: true });
  const extension = job.commandId.includes("avi") ? "avi" : job.commandId.includes("mov") ? "mov" : "mp4";
  const outputs = [];
  for (const name of [`result.${extension}`, `result_mask.${extension}`]) {
    try {
      const info = await lstat(path.join(PATHS.workspaceRoot, name));
      if (info.isFile() && !info.isSymbolicLink()) outputs.push({ name, bytes: info.size, modifiedAt: info.mtime.toISOString() });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await writeJsonAtomic(path.join(root, `${job.id}.json`), {
    id: job.id, commandId: job.commandId, label: job.label, appVersion:releaseVersion.version,
    createdAt: job.createdAt, endedAt: job.endedAt, parameters: job.parameters, outputs,
  });
}

export async function listExportHistory() {
  await safeRoot();
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = await Promise.all(entries.filter(entry => entry.isFile() && /^[a-z0-9-]+\.json$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 100).map(async entry => {
      try {
        const record = JSON.parse(await readFile(path.join(root, entry.name), "utf8"));
        return { ...record, outputs: (record.outputs ?? []).filter(output => outputName.test(output.name)) };
      } catch { return null; }
    }));
  return records.filter(Boolean);
}
