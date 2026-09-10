import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, statfs } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { PATHS, assertWithin, writeJsonAtomic } from "./paths.mjs";
import { AssetError, restoreAlignedImage, retainAlignedRoles, roleDatasetSnapshot } from "./asset-manager.mjs";

const root = path.join(PATHS.runtimeRoot, "role-assignments");
const labelsFile = path.join(PATHS.runtimeRoot, "roles.json");
const imageName = /^[^<>:"/\\|?*\u0000-\u001f]{1,220}\.(?:jpe?g|png)$/i;
const tokenPattern = /^\d{14}-[a-f0-9]{10}$/;
let mutationActive = false;
async function withMutation(operation) {
  if (mutationActive) throw new AssetError("另一个人物分配或恢复操作正在进行，请稍后重试", "ROLE_ASSIGNMENT_BUSY", 409);
  mutationActive = true;
  try { return await operation(); }
  finally { mutationActive = false; }
}
const sideOf = side => {
  if (!["src", "dst"].includes(side)) throw new AssetError("数据集类型不受支持", "SIDE_INVALID");
  return side;
};
async function plain(target, directory = false) {
  const info = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))) {
    throw new AssetError("素材路径包含不支持的链接或文件类型", "ROLE_PATH_UNSAFE");
  }
  return info;
}
async function prepareRoot() {
  await plain(PATHS.workspaceRoot, true);
  await plain(PATHS.runtimeRoot, true);
  await plain(root, true);
  await mkdir(root, { recursive: true });
}
export async function readRoleLabels() {
  await plain(PATHS.workspaceRoot,true);
  await plain(PATHS.runtimeRoot,true);
  await plain(labelsFile);
  try { return JSON.parse(await readFile(labelsFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
export async function inspectRoleLabels() {
  const labels = await readRoleLabels();
  const entries = await Promise.all(["src","dst"].map(async side => {
    const label = labels[side];
    if (!label) return [side,null];
    const snapshot = await roleDatasetSnapshot(side);
    return [side,{...label,current:label.fingerprint === snapshot.fingerprint}];
  }));
  return Object.fromEntries(entries);
}
async function saveLabel(side, value) {
  await writeJsonAtomic(labelsFile, { ...await readRoleLabels(), [side]: value });
}
async function videoNames(side) {
  return (await readdir(PATHS.workspaceRoot)).filter(name => new RegExp(`^data_${side}\\.(mp4|webm|mov|avi|mkv|m4v)$`, "i").test(name));
}
async function ensureCopySpace(bytes) {
  let available;
  try {
    const capacity = await statfs(root, { bigint: true });
    available = capacity.bavail * capacity.bsize;
  } catch (error) {
    if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) return;
    throw error;
  }
  // Leave room for directory entries and recovery journals before starting a large copy.
  const required = BigInt(bytes) + 4n * 1024n * 1024n;
  if (available < required) throw new AssetError("素材所在磁盘空间不足，无法保留原素材并完成角色分配；请释放空间后重试", "ROLE_SPACE_INSUFFICIENT", 409,
    { requiredBytes: String(required), availableBytes: String(available) });
}
async function recoveryRecords() {
  await prepareRoot();
  const records = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !tokenPattern.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    await plain(directory, true);
    try {
      const journal = path.join(directory, "manifest.json");
      await plain(journal);
      const record = JSON.parse(await readFile(journal, "utf8"));
      records.push({ ...record, token: entry.name });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return records;
}
async function transact(targetSide, replacements, label, extra = {}) {
  await prepareRoot();
  const token = `${new Date().toISOString().replace(/\D/g, "").slice(0,14)}-${randomBytes(5).toString("hex")}`;
  const directory = assertWithin(root, path.join(root, token));
  await mkdir(path.join(directory, "previous"), { recursive:true });
  const names = [...new Set([`data_${targetSide}`, ...await videoNames(targetSide), ...replacements.map(item => item.name),
    ...(targetSide === "dst" ? ["result.mp4","result_mask.mp4","result.avi","result_mask.avi","result.mov","result_mask.mov"] : [])])];
  const previousLabel = (await readRoleLabels())[targetSide] ?? null;
  const manifest = { token, targetSide, label, previousLabel, state:"preparing", createdAt:new Date().toISOString(), previous:[], installed:[], ...extra };
  const journal = path.join(directory,"manifest.json");
  const moves = [];
  let labelSaved = false;
  await writeJsonAtomic(journal, manifest);
  try {
    for (const name of names) {
      const target = assertWithin(PATHS.workspaceRoot, path.join(PATHS.workspaceRoot, name));
      if (!await plain(target, name === `data_${targetSide}`)) continue;
      const backup = path.join(directory,"previous",name);
      await rename(target, backup); moves.push([backup, target]); manifest.previous.push(name);
      await writeJsonAtomic(journal, manifest);
    }
    for (const item of replacements) {
      const target = assertWithin(PATHS.workspaceRoot,path.join(PATHS.workspaceRoot,item.name));
      await rename(item.path,target); moves.push([target,item.path]); manifest.installed.push(item.name);
      await writeJsonAtomic(journal,manifest);
    }
    // Restoring files restores their original review evidence as well. Recomputing
    // that fingerprint would incorrectly approve a dataset whose review was already stale.
    const reviewedLabel = label
      ? extra.restores ? label : { ...label, fingerprint:(await roleDatasetSnapshot(targetSide)).fingerprint }
      : null;
    await saveLabel(targetSide, reviewedLabel);
    labelSaved = true;
    manifest.label = reviewedLabel;
    manifest.state = "complete";
    await writeJsonAtomic(journal,manifest);
    return manifest;
  } catch (error) {
    const rollbackErrors = [];
    for (const [from,to] of moves.reverse()) {
      try {
        // A file created outside this operation must never be overwritten by rollback.
        if (await lstat(to).catch(failure => { if (failure.code === "ENOENT") return null; throw failure; })) {
          throw new AssetError("恢复目标出现同名素材", "ROLE_RESTORE_CONFLICT", 409);
        }
        await rename(from,to);
      } catch (failure) { rollbackErrors.push({ from, to, code: failure.code ?? "ROLE_ROLLBACK_FAILED" }); }
    }
    if (labelSaved) {
      try { await saveLabel(targetSide,previousLabel); }
      catch (failure) { rollbackErrors.push({ code: failure.code ?? "ROLE_LABEL_ROLLBACK_FAILED" }); }
    }
    manifest.state = rollbackErrors.length ? "recovery-required" : "rolled-back";
    manifest.failure = { code: error.code ?? "ROLE_ASSIGNMENT_FAILED", rollbackErrors };
    try { await writeJsonAtomic(journal,manifest); }
    catch (failure) { rollbackErrors.push({ code: failure.code ?? "ROLE_JOURNAL_FAILED" }); }
    if (rollbackErrors.length) throw new AssetError("人物分配未完成，部分素材无法自动恢复；恢复副本和记录已保留在项目目录", "ROLE_RECOVERY_REQUIRED", 500,
      { token, originalCode: error.code, rollbackErrors });
    throw error;
  }
}

export function assignRole(sourceSide, options) {
  return withMutation(() => assignRoleUnlocked(sourceSide, options));
}
async function assignRoleUnlocked(sourceSide, { targetSide = sourceSide, names, fingerprint, name } = {}) {
  sideOf(sourceSide); sideOf(targetSide);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 60 || /[\u0000-\u001f]/.test(name)) throw new AssetError("请输入 1–60 字的角色名称", "ROLE_NAME_INVALID");
  if (!Array.isArray(names) || !names.length || names.length > 2000 || names.some(value => typeof value !== "string" || !imageName.test(value))) throw new AssetError("请选择有效的角色图片", "ROLE_SELECTION_INVALID");
  const snapshot = await roleDatasetSnapshot(sourceSide);
  if (snapshot.fingerprint !== fingerprint || snapshot.names.length > 2000) throw new AssetError("素材已变化，请重新分析", "ROLE_DATASET_CHANGED",409);
  if (names.some(value => !snapshot.names.includes(value))) throw new AssetError("所选图片不属于当前数据集", "ROLE_SELECTION_INVALID");
  await prepareRoot();
  const label = { name:name.trim(), sourceSide, count:new Set(names).size, reviewedAt:new Date().toISOString() };
  if (sourceSide === targetSide) {
    // Read labels before moving any faces, so corrupt/unreadable metadata cannot leave a partial selection.
    await readRoleLabels();
    const result = await retainAlignedRoles(sourceSide,{ names,fingerprint });
    try {
      await saveLabel(targetSide, { ...label, fingerprint:(await roleDatasetSnapshot(targetSide)).fingerprint });
    } catch (error) {
      const rollbackErrors = [];
      for (const file of result.names ?? []) {
        try { await restoreAlignedImage(sourceSide, result.token, encodeURIComponent(file)); }
        catch (failure) { rollbackErrors.push({ name: file, code: failure.code }); }
      }
      if (rollbackErrors.length) throw new AssetError("角色名称未能保存，部分图片仍在隔离区，可从隔离区恢复", "ROLE_RECOVERY_REQUIRED", 500,
        { side:sourceSide, quarantineToken:result.token, originalCode:error.code, rollbackErrors });
      throw error;
    }
    return { ...result, targetSide, name:label.name };
  }
  const staging = path.join(root,`stage-${randomBytes(8).toString("hex")}`);
  const stagedData = path.join(staging,`data_${targetSide}`);
  let result;
  let operationError;
  try {
    const sourceData = path.join(PATHS.workspaceRoot,`data_${sourceSide}`);
    await plain(sourceData,true); await plain(path.join(sourceData,"aligned"),true);
    const copies = [];
    async function planCopy(source, target) {
      const info = await plain(source);
      if (!info) throw new AssetError("角色素材已变化，请重新分析", "ROLE_DATASET_CHANGED",409);
      copies.push({source, target, size:info.size});
    }
    for (const file of new Set(names)) {
      await planCopy(path.join(sourceData,"aligned",file),path.join(stagedData,"aligned",file));
    }
    for (const entry of await readdir(sourceData,{withFileTypes:true})) {
      if (imageName.test(entry.name)) await planCopy(path.join(sourceData,entry.name),path.join(stagedData,entry.name));
    }
    const replacements = [{ name:`data_${targetSide}`, path:stagedData }];
    for (const video of await videoNames(sourceSide)) {
      const name = `data_${targetSide}${path.extname(video).toLowerCase()}`;
      const target = path.join(staging,name);
      await planCopy(path.join(PATHS.workspaceRoot,video),target);
      replacements.push({name,path:target});
    }
    await ensureCopySpace(copies.reduce((total, item) => total + BigInt(item.size), 0n));
    await mkdir(path.join(stagedData,"aligned"),{recursive:true});
    for (const item of copies) await copyFile(item.source,item.target);
    if ((await roleDatasetSnapshot(sourceSide)).fingerprint !== fingerprint) throw new AssetError("素材已变化，请重新分析", "ROLE_DATASET_CHANGED",409);
    const manifest = await transact(targetSide,replacements,label,{sourceSide});
    result = {targetSide,name:label.name,keptCount:label.count,count:0,assignmentToken:manifest.token,sourcePreserved:true};
  } catch (error) { operationError = error; }
  try {
    // Only discard copies in this operation’s own staging directory.
    const cleanup = assertWithin(root,staging);
    await plain(cleanup,true);
    if (operationError?.code !== "ROLE_RECOVERY_REQUIRED") await rm(cleanup,{recursive:true,force:true});
  } catch (error) {
    // A cleanup failure must not turn a committed assignment into a reported failure,
    // or hide the original reason a copy failed. The retained directory contains copies only.
    if (operationError) operationError.details = { ...operationError.details, cleanupPending:true };
    else result.cleanupPending = true;
  }
  if (operationError) throw operationError;
  return result;
}

export async function listRoleAssignments() {
  const records = await recoveryRecords();
  const restored = new Set(records.filter(record => ["complete","restored"].includes(record.state)).map(record => record.restores).filter(Boolean));
  return records.filter(record => record.state === "complete" && !restored.has(record.token))
    .map(record => ({token:record.token,targetSide:record.targetSide,name:record.label?.name,createdAt:record.createdAt}))
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

export function restoreRoleAssignment(token) {
  return withMutation(() => restoreRoleAssignmentUnlocked(token));
}
async function restoreRoleAssignmentUnlocked(token) {
  if (!tokenPattern.test(token)) throw new AssetError("恢复记录无效", "ROLE_RESTORE_INVALID");
  await prepareRoot();
  const directory = path.join(root,token); await plain(directory,true);
  await plain(path.join(directory,"manifest.json"));
  const manifest = JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));
  const side = sideOf(manifest.targetSide);
  // The new transaction is the durable receipt. It remains authoritative if the
  // response is lost or the old manifest cannot be updated after a successful restore.
  const restoredBy = (await recoveryRecords()).find(record => record.restores === token
    && record.targetSide === side && ["complete","restored"].includes(record.state));
  if (restoredBy) return {targetSide:side,undoToken:restoredBy.token,alreadyRestored:true};
  if (manifest.state !== "complete") throw new AssetError("该分配尚未完成或恢复记录不完整", "ROLE_RESTORE_INVALID",409);
  if (!Array.isArray(manifest.previous) || new Set(manifest.previous).size !== manifest.previous.length) throw new AssetError("恢复记录无效", "ROLE_RESTORE_INVALID");
  const previous = path.join(directory,"previous"); await plain(previous,true);
  const allowed = name => name === `data_${side}` || new RegExp(`^data_${side}\\.(mp4|webm|mov|avi|mkv|m4v)$`,"i").test(name) || (side === "dst" && /^result(?:_mask)?\.(mp4|avi|mov)$/.test(name));
  const replacements = [];
  for (const name of manifest.previous) {
    if (!allowed(name)) throw new AssetError("恢复路径无效", "ROLE_PATH_UNSAFE");
    const target = path.join(previous,name);
    if (!await plain(target,name === `data_${side}`)) throw new AssetError("恢复文件缺失", "ROLE_RESTORE_INVALID");
    replacements.push({name,path:target});
  }
  const undo = await transact(side,replacements,manifest.previousLabel,{restores:token});
  manifest.state = "restored";
  manifest.undoToken = undo.token;
  const result = {targetSide:side,undoToken:undo.token};
  try { await writeJsonAtomic(path.join(directory,"manifest.json"),manifest); }
  catch { result.recoveryRecordPending = true; }
  return result;
}
