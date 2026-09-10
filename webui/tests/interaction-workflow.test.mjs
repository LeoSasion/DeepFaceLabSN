import assert from "node:assert/strict";
import test from "node:test";
import { jobPresentation, isFailedJob, mergeMetricHistory } from "../src/domain/job-presentation.js";
import { assignRole, restoreRoleAssignment, listRoleAssignments, inspectRoleLabels } from "../server/role-assignment-manager.mjs";
import { roleDatasetSnapshot } from "../server/asset-manager.mjs";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { PATHS, assertWithin } from "../server/paths.mjs";
import { recordExport, listExportHistory } from "../server/export-history.mjs";

test("normal stops are distinct from failures and from saved model readiness", () => {
  assert.deepEqual(jobPresentation({state:"cancelled",stopReason:"safe-stop"}),{label:"已安全停止",tone:"green"});
  assert.equal(jobPresentation({state:"cancelled",stopReason:"safe-stop-before-start"}).label,"启动前已停止");
  assert.equal(jobPresentation({state:"cancelled"}).tone,"muted");
  assert.equal(isFailedJob({state:"cancelled"}),false);
  assert.equal(isFailedJob({state:"failed"}),true);
  assert.equal(isFailedJob({state:"orphaned"}),true);
});

test("training history survives reconnect, filters invalid metrics and bounds rendering", () => {
  const events = Array.from({length:450},(_,iteration)=>({type:"job.metric",payload:{iteration,srcLoss:.4,dstLoss:.6}}));
  const points = mergeMetricHistory([],events);
  assert.equal(points.length,400);
  assert.equal(points[0].iteration,50);
  const merged = mergeMetricHistory(points,[events[449],{type:"job.metric",payload:{iteration:500,srcLoss:NaN,dstLoss:1}},{type:"terminal.output",payload:{iteration:600}}]);
  assert.deepEqual(merged,points);
});

test("role assignment copies a reviewed selection and restores the exact previous target", {
  skip:process.env.DFLSN_ISOLATED_TEST_ROOT ? false : "requires isolated fixture",
},async()=>{
  const source = await roleDatasetSnapshot("src");
  const destination = await roleDatasetSnapshot("dst");
  assert.ok(source.names.length);
  await assert.rejects(assignRole("src",{targetSide:"outside",names:[source.names[0]],fingerprint:source.fingerprint,name:"演员"}),{code:"SIDE_INVALID"});
  await assert.rejects(assignRole("src",{targetSide:"dst",names:[source.names[0]],fingerprint:"stale",name:"演员"}),{code:"ROLE_DATASET_CHANGED"});
  await assert.rejects(assignRole("src",{targetSide:"dst",names:["../outside.jpg"],fingerprint:source.fingerprint,name:"演员"}),{code:"ROLE_SELECTION_INVALID"});
  await assert.rejects(assignRole("src",{targetSide:"dst",names:[source.names[0]],fingerprint:source.fingerprint,name:""}),{code:"ROLE_NAME_INVALID"});
  const frameNames = (await readdir(path.join(PATHS.workspaceRoot,"data_src"))).filter(name => /\.(jpe?g|png)$/i.test(name));
  const sourceVideos = (await readdir(PATHS.workspaceRoot)).filter(name => /^data_src\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(name));
  const originalResult = await readFile(path.join(PATHS.workspaceRoot,"result.mp4")).catch(() => null);
  let assigned;
  let restored;
  try {
    assigned=await assignRole("src",{targetSide:"dst",names:[source.names[0]],fingerprint:source.fingerprint,name:"访谈嘉宾"});
    assert.equal(assigned.keptCount,1);
    assert.equal(assigned.sourcePreserved,true);
    for (const name of frameNames) assert.deepEqual(await readFile(path.join(PATHS.workspaceRoot,"data_dst",name)),await readFile(path.join(PATHS.workspaceRoot,"data_src",name)));
    for (const name of sourceVideos) assert.deepEqual(await readFile(path.join(PATHS.workspaceRoot,name.replace("data_src","data_dst"))),await readFile(path.join(PATHS.workspaceRoot,name)));
    await assert.rejects(readFile(path.join(PATHS.workspaceRoot,"result.mp4")),{code:"ENOENT"});
    assert.equal((await inspectRoleLabels()).dst.current,true);
    const added = assertWithin(PATHS.workspaceRoot,path.join(PATHS.workspaceRoot,"data_dst","aligned","review-stale.jpg"));
    try {
      await writeFile(added,await readFile(path.join(PATHS.workspaceRoot,"data_src","aligned",source.names[0])));
      assert.equal((await inspectRoleLabels()).dst.current,false);
    } finally { await rm(added,{force:true}); }
    assert.deepEqual((await roleDatasetSnapshot("dst")).names,[source.names[0]]);
    assert.deepEqual(await roleDatasetSnapshot("src"),source);
    assert.ok((await listRoleAssignments()).some(record=>record.token===assigned.assignmentToken));
  } finally {
    if (assigned) restored = await restoreRoleAssignment(assigned.assignmentToken);
  }
  assert.deepEqual(await roleDatasetSnapshot("dst"),destination);
  if (originalResult) assert.deepEqual(await readFile(path.join(PATHS.workspaceRoot,"result.mp4")),originalResult);
  assert.equal((await readdir(path.join(PATHS.runtimeRoot,"role-assignments"))).some(name=>name.startsWith("stage-")),false);
  const repeated = await restoreRoleAssignment(assigned.assignmentToken);
  assert.equal(repeated.alreadyRestored,true);
  assert.equal(repeated.undoToken,restored.undoToken);
});

test("export records preserve parameters independently of archived job logs", {
  skip:process.env.DFLSN_ISOLATED_TEST_ROOT ? false : "requires isolated fixture",
},async()=>{
  const job={id:"20990101000000-abcdef00",state:"succeeded",commandId:"encode.mp4",label:"导出 MP4",parameters:{bitrate:16},endedAt:new Date().toISOString()};
  await assert.rejects(recordExport({...job,id:"../outside"}));
  await recordExport(job);
  const record=(await listExportHistory()).find(record=>record.id===job.id);
  assert.deepEqual(record.parameters,job.parameters);
  assert.equal(record.commandId,"encode.mp4");
  await recordExport({...job,id:"20990101000000-abcdef01",state:"failed"});
  assert.equal((await listExportHistory()).some(record=>record.id.endsWith("abcdef01")),false);
});
