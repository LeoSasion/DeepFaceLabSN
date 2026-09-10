import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import * as promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalFs = { ...promises };
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server");
const injectedError = code => Object.assign(new Error(`Injected ${code}`), { code });

// Each test loads the production managers from a tiny, private repository. These
// tests never resolve PATHS against the user's project and require no Python/video decoding.
async function fixture(run) {
  const root = await originalFs.mkdtemp(path.join(os.tmpdir(), "dfl-role-recovery-"));
  const workspace = path.join(root, "workspace");
  const runtime = path.join(workspace, ".webui");
  const server = path.join(root, "webui", "server");
  const restores = [];
  try {
    await originalFs.mkdir(server, { recursive:true });
    for (const name of ["paths.mjs", "environment.mjs", "asset-manager.mjs", "role-assignment-manager.mjs"]) {
      await originalFs.copyFile(path.join(serverRoot, name), path.join(server, name));
    }
    await originalFs.mkdir(runtime, { recursive:true });
    for (const side of ["src", "dst"]) {
      await originalFs.mkdir(path.join(workspace, `data_${side}`, "aligned"), { recursive:true });
      await originalFs.writeFile(path.join(workspace, `data_${side}`, "aligned", "one.jpg"), `${side}-face-one`);
      await originalFs.writeFile(path.join(workspace, `data_${side}`, "aligned", "two.jpg"), `${side}-face-two`);
      await originalFs.writeFile(path.join(workspace, `data_${side}`, "frame.jpg"), `${side}-frame`);
      await originalFs.writeFile(path.join(workspace, `data_${side}.mp4`), `${side}-video`);
    }
    await originalFs.writeFile(path.join(workspace, "result.mp4"), "original-result");
    await originalFs.writeFile(path.join(workspace, "result_mask.mp4"), "original-mask");
    const manager = await import(pathToFileURL(path.join(server, "role-assignment-manager.mjs")));
    const assets = await import(pathToFileURL(path.join(server, "asset-manager.mjs")));
    const source = await assets.roleDatasetSnapshot("src");
    const options = { targetSide:"dst", names:["one.jpg"], fingerprint:source.fingerprint, name:"访谈嘉宾" };
    function fault(method, replacement) {
      const previous = fs.promises[method];
      fs.promises[method] = (...args) => replacement(previous, ...args);
      syncBuiltinESMExports();
      const restore = () => { fs.promises[method] = previous; syncBuiltinESMExports(); };
      restores.push(restore);
      return restore;
    }
    await run({ root, workspace, runtime, manager, assets, source, options, fault });
  } finally {
    for (const restore of restores.reverse()) restore();
    // The absolute deletion target is a unique direct child of the system temp directory.
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(root), /^dfl-role-recovery-/);
    await originalFs.rm(root, { recursive:true, force:true, maxRetries:3, retryDelay:100 });
  }
}

async function tree(directory) {
  const result = {};
  for (const entry of await originalFs.readdir(directory, { withFileTypes:true })) {
    const target = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? await tree(target) : await originalFs.readFile(target, "utf8");
  }
  return result;
}
async function stages(runtime) {
  return (await originalFs.readdir(path.join(runtime, "role-assignments"))).filter(name => name.startsWith("stage-"));
}

test("same-side label failures do not silently leave a filtered dataset", async () => fixture(async ({ workspace, runtime, manager, assets, options, fault }) => {
  const before = await tree(path.join(workspace, "data_src"));
  const labels = path.join(runtime, "roles.json");
  await originalFs.writeFile(labels, "{}");
  fault("rename", (rename, from, to) => {
    if (to === labels) throw injectedError("EACCES");
    return rename(from, to);
  });
  await assert.rejects(manager.assignRole("src", { ...options, targetSide:"src" }), { code:"EACCES" });
  assert.deepEqual(await tree(path.join(workspace, "data_src")), before);
  assert.deepEqual(await manager.readRoleLabels(), {});
  assert.equal((await assets.roleDatasetSnapshot("src")).names.length, 2);
}));

test("unreadable role metadata is checked before same-side face moves", async () => fixture(async ({ workspace, runtime, manager, options }) => {
  const before = await tree(path.join(workspace, "data_src"));
  await originalFs.writeFile(path.join(runtime, "roles.json"), "{broken");
  await assert.rejects(manager.assignRole("src", { ...options, targetSide:"src" }), SyntaxError);
  assert.deepEqual(await tree(path.join(workspace, "data_src")), before);
}));

test("failed destination install rolls back frames, video, outputs and staged copies", async () => fixture(async ({ workspace, runtime, manager, assets, source, options, fault }) => {
  const before = await tree(path.join(workspace, "data_dst"));
  fault("rename", (rename, from, to) => {
    if (from.includes(`${path.sep}stage-`) && to === path.join(workspace, "data_dst.mp4")) throw injectedError("EACCES");
    return rename(from, to);
  });
  await assert.rejects(manager.assignRole("src", options), { code:"EACCES" });
  assert.deepEqual(await tree(path.join(workspace, "data_dst")), before);
  assert.equal(await originalFs.readFile(path.join(workspace, "data_dst.mp4"), "utf8"), "dst-video");
  assert.equal(await originalFs.readFile(path.join(workspace, "result.mp4"), "utf8"), "original-result");
  assert.equal(await originalFs.readFile(path.join(workspace, "result_mask.mp4"), "utf8"), "original-mask");
  assert.deepEqual(await assets.roleDatasetSnapshot("src"), source);
  assert.deepEqual(await stages(runtime), []);
  assert.deepEqual(await manager.listRoleAssignments(), []);
}));

test("rollback attempts remaining files after an error and retains recovery evidence", async () => fixture(async ({ workspace, runtime, manager, options, fault }) => {
  fault("rename", (rename, from, to) => {
    if (from.includes(`${path.sep}stage-`) && to === path.join(workspace, "data_dst.mp4")) throw injectedError("ENOSPC");
    if (from.includes(`${path.sep}previous${path.sep}`) && to === path.join(workspace, "result.mp4")) throw injectedError("EACCES");
    return rename(from, to);
  });
  let failure;
  await assert.rejects(manager.assignRole("src", options), error => {
    failure = error;
    return error.code === "ROLE_RECOVERY_REQUIRED" && error.details.originalCode === "ENOSPC";
  });
  assert.equal(await originalFs.readFile(path.join(workspace, "data_dst.mp4"), "utf8"), "dst-video");
  assert.equal(await originalFs.readFile(path.join(workspace, "data_dst", "aligned", "one.jpg"), "utf8"), "dst-face-one");
  assert.equal(await originalFs.readFile(path.join(workspace, "result_mask.mp4"), "utf8"), "original-mask");
  const recovery = path.join(runtime, "role-assignments", failure.details.token);
  assert.equal(await originalFs.readFile(path.join(recovery, "previous", "result.mp4"), "utf8"), "original-result");
  const manifest = JSON.parse(await originalFs.readFile(path.join(recovery, "manifest.json"), "utf8"));
  assert.equal(manifest.state, "recovery-required");
  assert.equal(manifest.failure.rollbackErrors.length, 1);
  assert.equal((await stages(runtime)).length, 1);
}));

test("a failed final journal commit rolls back the saved role label with the original dataset", async () => fixture(async ({ workspace, runtime, manager, assets, options, fault }) => {
  const previousLabel = { name:"原目标", count:2, fingerprint:(await assets.roleDatasetSnapshot("dst")).fingerprint };
  const labels = { src:{ name:"原来源" }, dst:previousLabel };
  await originalFs.writeFile(path.join(runtime, "roles.json"), JSON.stringify(labels));
  const before = await tree(path.join(workspace, "data_dst"));
  fault("writeFile", (write, target, content, ...args) => {
    if (path.basename(target).startsWith("manifest.json.") && typeof content === "string" && JSON.parse(content).state === "complete") {
      throw injectedError("ENOSPC");
    }
    return write(target, content, ...args);
  });
  await assert.rejects(manager.assignRole("src", options), { code:"ENOSPC" });
  assert.deepEqual(await tree(path.join(workspace, "data_dst")), before);
  assert.deepEqual(await manager.readRoleLabels(), labels);
  assert.equal((await manager.inspectRoleLabels()).dst.current, true);
  assert.deepEqual(await stages(runtime), []);
}));

test("insufficient copy space is rejected before copies or destination changes", async () => fixture(async ({ workspace, runtime, manager, options, fault }) => {
  const before = await tree(path.join(workspace, "data_dst"));
  let copies = 0;
  fault("statfs", () => ({ bavail:0n, bsize:4096n }));
  fault("copyFile", (copy, ...args) => { copies++; return copy(...args); });
  await assert.rejects(manager.assignRole("src", options), { code:"ROLE_SPACE_INSUFFICIENT" });
  assert.equal(copies, 0);
  assert.deepEqual(await tree(path.join(workspace, "data_dst")), before);
  assert.deepEqual(await stages(runtime), []);
}));

test("cleanup errors preserve the original copy failure", async () => fixture(async ({ workspace, manager, options, fault }) => {
  fault("copyFile", () => { throw injectedError("ENOSPC"); });
  fault("rm", (remove, target, options) => {
    if (path.basename(target).startsWith("stage-")) throw injectedError("EACCES");
    return remove(target, options);
  });
  await assert.rejects(manager.assignRole("src", options), error => error.code === "ENOSPC" && error.details.cleanupPending === true);
  assert.equal(await originalFs.readFile(path.join(workspace, "data_dst.mp4"), "utf8"), "dst-video");
}));

test("cleanup failure does not misreport a committed assignment as failed", async () => fixture(async ({ manager, options, fault }) => {
  const reset = fault("rm", (remove, target, options) => {
    if (path.basename(target).startsWith("stage-")) throw injectedError("EBUSY");
    return remove(target, options);
  });
  const assigned = await manager.assignRole("src", options);
  assert.equal(assigned.cleanupPending, true);
  assert.equal(assigned.keptCount, 1);
  reset();
  assert.ok((await manager.restoreRoleAssignment(assigned.assignmentToken)).undoToken);
}));

test("restore receipt makes retries safe even when the old manifest update fails", async () => fixture(async ({ workspace, runtime, manager, options, fault }) => {
  const assigned = await manager.assignRole("src", options);
  const oldJournal = path.join(runtime, "role-assignments", assigned.assignmentToken, "manifest.json");
  fault("rename", (rename, from, to) => {
    if (to === oldJournal) throw injectedError("EACCES");
    return rename(from, to);
  });
  const restored = await manager.restoreRoleAssignment(assigned.assignmentToken);
  assert.equal(restored.recoveryRecordPending, true);
  assert.equal(await originalFs.readFile(path.join(workspace, "data_dst.mp4"), "utf8"), "dst-video");
  const beforeRetry = await tree(workspace);
  const repeated = await manager.restoreRoleAssignment(assigned.assignmentToken);
  assert.equal(repeated.undoToken, restored.undoToken);
  assert.equal(repeated.alreadyRestored, true);
  assert.deepEqual(await tree(workspace), beforeRetry);
  assert.equal((await manager.listRoleAssignments()).some(record => record.token === assigned.assignmentToken), false);
}));

test("restoring a dataset preserves its previous review status instead of approving stale faces", async () => fixture(async ({ runtime, manager, options }) => {
  const oldLabel = { name:"此前已变化的素材", count:1, fingerprint:"outdated-review" };
  await originalFs.writeFile(path.join(runtime, "roles.json"), JSON.stringify({ dst:oldLabel }));
  assert.equal((await manager.inspectRoleLabels()).dst.current, false);
  const assigned = await manager.assignRole("src", options);
  assert.equal((await manager.inspectRoleLabels()).dst.current, true);
  const restored = await manager.restoreRoleAssignment(assigned.assignmentToken);
  assert.deepEqual((await manager.readRoleLabels()).dst, oldLabel);
  assert.equal((await manager.inspectRoleLabels()).dst.current, false);
  const repeat = await manager.restoreRoleAssignment(assigned.assignmentToken);
  assert.equal(repeat.undoToken, restored.undoToken);
  assert.equal(repeat.alreadyRestored, true);
}));

test("overlapping role mutations cannot install two transactions at once", async () => fixture(async ({ manager, options, fault }) => {
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  fault("copyFile", async (copy, ...args) => { entered(); await releasePromise; return copy(...args); });
  const first = manager.assignRole("src", options);
  await enteredPromise;
  try {
    await assert.rejects(manager.assignRole("src", options), { code:"ROLE_ASSIGNMENT_BUSY" });
  } finally { release(); }
  assert.ok((await first).assignmentToken);
}));
