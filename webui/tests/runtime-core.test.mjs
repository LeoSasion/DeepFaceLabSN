import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCommand,
  formatCommand,
  getCommandDefinition,
  listCommands,
  prepareCommand,
  validateCommandParameters,
  validateXSegTrainingLabels,
} from "../server/command-registry.mjs";
import {
  auditAlignedAssets,
  buildAlignedPoseAtlas,
  buildAlignedPoseProbe,
  buildAlignedSimilarityGroups,
  inspectAlignedAnnotation,
  inspectAlignedPack,
  inspectExtractionCoverage,
  listAlignedAssets,
  previewAlignedRepair,
  resolveAlignedImage,
} from "../server/asset-manager.mjs";
import { buildDflEnvironment } from "../server/environment.mjs";
import { DisabledExternalWindowAdapter } from "../server/external-window-adapter.mjs";
import { JobManager } from "../server/job-manager.mjs";
import { OutputParser, stripAnsi } from "../server/output-parser.mjs";
import { PATHS, assertWithin } from "../server/paths.mjs";
import { ProjectManager } from "../server/project-manager.mjs";
import { createPtyRunner } from "../server/pty-runner.mjs";
import { parseNvidiaSmiCsv } from "../server/telemetry.mjs";
import {
  createTrainingModelKey,
  TrainingEvaluationManager,
} from "../server/training-evaluation-manager.mjs";
import {
  inspectExportReadiness,
  inspectWorkspace,
  listMergeReview,
  resolveReviewAsset,
  resolveWorkspaceArtifact,
} from "../server/workspace-manager.mjs";
import { applyEventToJob, mergeJobs } from "../src/runtime/useRuntime.js";
import { buildPoseComparison } from "../src/domain/pose-comparison.js";
import { normalizeSegments } from "../server/video-tool-manager.mjs";

test("command registry exposes the approved fixed workflows", () => {
  const commands = listCommands();
  assert.deepEqual(
    commands.map((command) => command.id),
    [
      "src.extract_frames",
      "src.extract_faces",
      "dst.extract_frames",
      "dst.extract_faces",
      "train.saehd",
      "src.sort_faces",
      "dst.sort_faces",
      "xseg.train",
      "xseg.apply_src",
      "xseg.apply_dst",
      "merge.saehd",
      "encode.mp4",
      "encode.mp4_lossless",
      "src.landmarks_debug",
      "src.faces_resize",
      "src.faces_enhance",
      "src.faces_pack",
      "src.faces_unpack",
      "src.recover_names",
      "src.metadata_save",
      "src.metadata_restore",
      "dst.landmarks_debug",
      "dst.faces_resize",
      "dst.faces_enhance",
      "dst.faces_pack",
      "dst.faces_unpack",
      "dst.recover_names",
      "dst.metadata_save",
      "dst.metadata_restore",
      "xseg.src_apply_builtin",
      "xseg.src_remove_labels",
      "xseg.src_remove_mask",
      "xseg.src_fetch_labels",
      "xseg.dst_apply_builtin",
      "xseg.dst_remove_labels",
      "xseg.dst_remove_mask",
      "xseg.dst_fetch_labels",
      "video.cut_src",
      "video.cut_dst",
      "dst.denoise_frames",
      "train.me",
      "train.q384",
      "train.q512",
      "export.dfm_me",
      "export.dfm_q384",
      "export.dfm_q512",
      "export.dfm_saehd",
      "merge.amp",
      "merge.me",
      "merge.q384",
      "merge.q512",
      "encode.avi",
      "encode.mov_lossless",
    ],
  );
  const training = commands.find((command) => command.id === "train.saehd");
  assert.equal(training.profile, "legacy");
  assert.equal(training.stage, "train");
  assert.deepEqual(training.controls, ["save", "backup", "preview", "evaluate", "close"]);
  assert.equal(commands.find((command) => command.id === "merge.saehd").profile, "legacy");
  assert.equal(commands.find((command) => command.id === "encode.mp4").stage, "encode");
});

test("XSeg training preflight rejects datasets without labels", () => {
  assert.throws(
    () => validateXSegTrainingLabels(
      { usableLabelCount: 0 },
      { usableLabelCount: 0 },
    ),
    (error) => error.code === "XSEG_LABELS_MISSING"
      && error.details.srcLabelCount === 0
      && error.details.dstLabelCount === 0,
  );
  assert.deepEqual(
    validateXSegTrainingLabels(
      { usableLabelCount: 2 },
      { usableLabelCount: 3 },
    ),
    { srcLabelCount: 2, dstLabelCount: 3 },
  );
});

test("fixed video runner rejects unregistered modes before spawning DFL", () => {
  const runnerPath = path.join(PATHS.serverDirectory, "encode-mp4.mjs");
  const result = spawnSync(process.execPath, [runnerPath, "arbitrary"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /只允许 standard、lossless、avi 或 mov-lossless/);
});

test("guided parameters are allowlisted, typed, and reflected in fixed arguments", () => {
  const parameters = validateCommandParameters("src.extract_faces", {
    detector: "s3fd",
    faceType: "whole_face",
    imageSize: "128",
    maxFaces: "1",
    jpegQuality: "92",
    gpuIndexes: "0,1",
    cpuOnly: false,
  }, "guided");
  assert.equal(parameters.imageSize, 128);
  assert.equal(parameters.jpegQuality, 92);
  const { launch } = buildCommand(getCommandDefinition("src.extract_faces"), { parameters });
  assert.ok(launch.args.includes("--image-size"));
  assert.ok(launch.args.includes("128"));
  assert.ok(launch.args.includes("--force-gpu-idxs"));
  assert.ok(!launch.args.includes("--cpu-only"));

  const trainingParameters = validateCommandParameters("train.saehd", {
    targetIterations: 100000,
    forceModelName: "web-smoke-128",
    silentStart: true,
    gpuIndexes: "0",
    cpuOnly: false,
  }, "guided");
  const trainingLaunch = buildCommand(getCommandDefinition("train.saehd"), {
    parameters: trainingParameters,
    controlFile: path.join(PATHS.jobsRoot, "fixed-job", "control.jsonl"),
    previewFile: path.join(PATHS.jobsRoot, "fixed-job", "preview.png"),
    preflight: {
      evaluation: {
        enabled: true,
        modelKey: "web-smoke-128-saehd-123456789abc",
        manifestId: "a".repeat(24),
        manifestPath: path.join(PATHS.trainingEvaluationsRoot, "model", "manifests", `${"a".repeat(24)}.json`),
        evaluationRoot: path.join(PATHS.trainingEvaluationsRoot, "model"),
        existingSnapshotIds: [],
      },
    },
  }).launch;
  assert.equal(trainingLaunch.evaluation.enabled, true);
  assert.equal(trainingLaunch.env.DFL_WEB_EVAL_MODEL_KEY, "web-smoke-128-saehd-123456789abc");
  assert.match(trainingLaunch.env.DFL_WEB_EVAL_MANIFEST, /training-evaluations/i);
  assert.equal(trainingLaunch.env.DFL_WEBUI_PYTHON, path.join(PATHS.webuiRoot, "python"));
  assert.deepEqual(validateCommandParameters("src.sort_faces", {}, "cli"), {});
  assert.throws(
    () => validateCommandParameters("src.extract_faces", { detector: "shell" }, "guided"),
    (error) => error.code === "PARAMETER_INVALID",
  );
  assert.throws(
    () => validateCommandParameters("train.saehd", { gpuIndexes: "0 & whoami" }, "guided"),
    (error) => error.code === "PARAMETER_INVALID",
  );
  assert.throws(
    () => validateCommandParameters("encode.mp4", { arbitrary: "value" }, "guided"),
    (error) => error.code === "PARAMETER_NOT_ALLOWED",
  );
  assert.throws(
    () => validateCommandParameters("video.cut_dst", {
      fromTime: "00:00:00.000 & whoami",
      toTime: "",
      audioTrackId: 0,
      bitrate: 16,
    }, "guided"),
    (error) => error.code === "PARAMETER_INVALID",
  );

  const cutParameters = validateCommandParameters("video.cut_src", {
    fromTime: "00:00:00.000",
    toTime: "",
    audioTrackId: 0,
    bitrate: 16,
  }, "guided");
  const cutLaunch = buildCommand(getCommandDefinition("video.cut_src"), {
    launchMode: "guided",
    parameters: cutParameters,
  }).launch;
  const cutInput = cutLaunch.args[cutLaunch.args.indexOf("--input-file") + 1];
  assert.equal(path.isAbsolute(cutInput), true);
  assert.match(path.basename(cutInput), /^data_src\.[^.]+$/i);

  const mergeParameters = validateCommandParameters("merge.saehd", {
    forceModelName: "web-smoke-128",
    mode: "overlay",
    maskMode: 7,
    workers: 4,
    erodeMask: 0,
    blurMask: 8,
    motionBlur: 0,
    faceScale: 0,
    colorTransfer: "none",
    sharpenMode: 0,
    sharpenAmount: 0,
    superResolution: 0,
    imageDenoise: 0,
    bicubicDegrade: 0,
    colorDegrade: 0,
    gpuIndexes: "0",
    cpuOnly: false,
  }, "guided");
  const mergeLaunch = buildCommand(getCommandDefinition("merge.saehd"), {
    launchMode: "guided",
    parameters: mergeParameters,
  }).launch;
  assert.equal(JSON.parse(mergeLaunch.env.DFL_WEB_MERGE_CONFIG).maskMode, 7);
  assert.ok(mergeLaunch.args.includes("--force-gpu-idxs"));
});

test("DFL environments point to repository-owned runtimes", () => {
  const current = buildDflEnvironment("current");
  const legacy = buildDflEnvironment("legacy");
  assert.equal(current.DFL_ROOT, PATHS.currentDflRoot);
  assert.equal(legacy.DFL_ROOT, PATHS.legacyDflRoot);
  assert.equal(current.WORKSPACE, PATHS.workspaceRoot);
  assert.equal(current.PYTHON_EXECUTABLE, PATHS.python);
  assert.ok(current.PATH.includes(path.join(PATHS.internalRoot, "CUDA")));
  assert.equal(
    Object.keys(current).filter((key) => key.toUpperCase() === "PATH").length,
    1,
  );
  assert.throws(() => buildDflEnvironment("other"), /未知 DFL 运行时/);
});

test("allowed paths cannot escape their parent", () => {
  assert.equal(
    assertWithin(PATHS.workspaceRoot, path.join(PATHS.workspaceRoot, "data_src")),
    path.join(PATHS.workspaceRoot, "data_src"),
  );
  assert.throws(
    () => assertWithin(PATHS.workspaceRoot, path.join(PATHS.repositoryRoot, "_internal")),
    /超出允许范围/,
  );
  assert.throws(
    () => resolveAlignedImage("src", encodeURIComponent("../model/file.jpg")),
    (error) => error.code === "IMAGE_NAME_INVALID",
  );
  assert.match(resolveAlignedImage("src", "review.png"), /review\.png$/i);
  assert.match(resolveAlignedImage("src", "review.jpeg"), /review\.jpeg$/i);
});

test("aligned asset browser reads real DFL metadata through the fixed helper", async () => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 10 });
  assert.equal(assets.side, "src");
  assert.ok(assets.total >= assets.items.length);
  assert.ok(assets.items.every((item) => item.imageUrl.startsWith("/api/assets/src/aligned/")));
  const valid = assets.items.find((item) => item.hasDflMetadata);
  assert.ok(valid, "expected a real DFL aligned fixture");
  const target = resolveAlignedImage("src", encodeURIComponent(valid.name));
  const before = await stat(target);
  const annotation = await inspectAlignedAnnotation("src", encodeURIComponent(valid.name));
  const after = await stat(target);
  assert.ok(annotation.width > 0 && annotation.height > 0);
  assert.equal(annotation.landmarks.length, 68);
  assert.ok(annotation.landmarks.flat().every(Number.isFinite));
  assert.equal(annotation.sourceRectAligned.length, 4);
  assert.ok(annotation.sourceRectAligned.flat().every(Number.isFinite));
  assert.equal(typeof annotation.faceType, "string");
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("pose atlas aggregates real DFL landmarks into bounded review bins", async () => {
  const atlas = await buildAlignedPoseAtlas("src");
  assert.equal(atlas.side, "src");
  assert.equal(atlas.cells.length, atlas.yawTicks.length * atlas.pitchTicks.length);
  assert.equal(
    atlas.cells.reduce((total, cell) => total + cell.count, 0),
    atlas.validCount,
  );
  assert.ok(atlas.coverage >= 0 && atlas.coverage <= 1);
  assert.ok(atlas.meanSharpness >= 0 && atlas.meanSharpness <= 1);
  assert.ok(atlas.cells.every((cell) => cell.samples.length <= 8));
  assert.ok(atlas.cells.flatMap((cell) => cell.samples).every(
    (sample) => sample.imageUrl.startsWith("/api/assets/src/aligned/"),
  ));
});

test("tool workbench analysis is bounded, non-destructive, and uses fixed review slots", async () => {
  const [audit, pack, coverage, mergeReview, exportReadiness] = await Promise.all([
    auditAlignedAssets("src", { refresh: true }),
    inspectAlignedPack("src", { refresh: true }),
    inspectExtractionCoverage("dst", { refresh: true }),
    listMergeReview({ limit: 8 }),
    inspectExportReadiness(),
  ]);
  assert.equal(audit.side, "src");
  assert.ok(audit.analyzedCount <= 500);
  assert.ok(audit.items.every((item) => item.imageUrl.startsWith("/api/assets/src/aligned/")));
  assert.ok(audit.items.every((item) => item.qualityScore >= 0 && item.qualityScore <= 1));
  assert.ok(audit.items.every((item) => ["full", "xseg"].includes(item.sharpnessScope)));
  assert.ok(audit.items.every((item) => typeof item.hasAppliedMask === "boolean"));
  assert.ok(audit.items.every((item) => item.fullSharpness >= 0 && item.fullSharpness <= 1));
  if (audit.total > 1) {
    const firstAudit = await auditAlignedAssets("src", { refresh: true, offset: 0, limit: 1 });
    const nextAudit = await auditAlignedAssets("src", { refresh: true, offset: 1, limit: 1 });
    assert.equal(nextAudit.offset, 1);
    assert.equal(nextAudit.items.length, 1);
    assert.notEqual(nextAudit.items[0].name, firstAudit.items[0].name);
  }
  assert.equal(pack.side, "src");
  assert.ok(["ready", "invalid", "not_packed"].includes(pack.status));
  assert.equal(coverage.side, "dst");
  assert.ok(coverage.analyzedCount <= 500);
  assert.ok(coverage.items.every((item) => item.frameUrl.startsWith("/api/workspace/review/dst-frame/")));
  assert.ok(mergeReview.items.length <= 8);
  assert.ok(mergeReview.items.every((item) => item.sourceUrl.startsWith("/api/workspace/review/dst-frame/")));
  assert.equal(typeof exportReadiness.readyCount, "number");
  assert.throws(
    () => resolveReviewAsset("dst-frame", encodeURIComponent("../model/file.png")),
    (error) => error.code === "REVIEW_NAME_INVALID",
  );
  assert.throws(
    () => resolveReviewAsset("arbitrary", "00001.png"),
    (error) => error.code === "REVIEW_SLOT_INVALID",
  );
  if (mergeReview.total > 1) {
    const nextMergeReview = await listMergeReview({ offset: 1, limit: 1 });
    assert.equal(nextMergeReview.offset, 1);
    assert.equal(nextMergeReview.items.length, 1);
    assert.notEqual(nextMergeReview.items[0].name, mergeReview.items[0].name);
  }
});

test("visual similarity grouping is bounded, explainable, and read-only", async () => {
  const assets = await listAlignedAssets("src", { limit: 1 });
  assert.ok(assets.items.length > 0, "expected a real aligned fixture");
  const target = resolveAlignedImage("src", encodeURIComponent(assets.items[0].name));
  const before = await stat(target);
  const result = await buildAlignedSimilarityGroups("src", {
    refresh: true,
    threshold: 0.86,
    limit: 40,
  });
  const after = await stat(target);
  assert.equal(result.method, "dct-hsv-edge-v1");
  assert.ok(result.analyzedCount <= 40);
  assert.ok(result.groups.every((group) => group.members.length >= 2));
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("alignment repair preview uses 68 real source points without mutating the JPG", async () => {
  const coverage = await inspectExtractionCoverage("src", { refresh: true, limit: 60 });
  const face = coverage.items.flatMap((item) => item.faces).find((item) => item.landmarks.length === 68);
  assert.ok(face, "expected a 68-point aligned fixture");
  const target = resolveAlignedImage("src", encodeURIComponent(face.alignedName));
  const before = await stat(target);
  const preview = await previewAlignedRepair("src", encodeURIComponent(face.alignedName), {
    landmarks: face.landmarks,
  });
  const after = await stat(target);
  assert.match(preview.previewDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(preview.landmarks.length, 68);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("alignment repair atomically rewrites a temporary JPG and creates a recovery copy", async (t) => {
  const coverage = await inspectExtractionCoverage("src", { refresh: true, limit: 60 });
  const frame = coverage.items.find((item) => item.faces.some((face) => face.landmarks.length === 68));
  const face = frame?.faces.find((item) => item.landmarks.length === 68);
  assert.ok(frame && face, "expected a repair fixture");
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-alignment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = path.join(root, "frames");
  const aligned = path.join(root, "aligned");
  const backups = path.join(root, "backups");
  await Promise.all([mkdir(frames), mkdir(aligned), mkdir(backups)]);
  const sourceTarget = path.join(frames, frame.name);
  const alignedTarget = path.join(aligned, face.alignedName);
  await Promise.all([
    copyFile(path.join(PATHS.workspaceRoot, "data_src", frame.name), sourceTarget),
    copyFile(resolveAlignedImage("src", encodeURIComponent(face.alignedName)), alignedTarget),
  ]);
  const helper = path.join(PATHS.webuiRoot, "python", "dfl_asset_tool.py");
  const result = spawnSync(PATHS.python, [
    helper,
    "alignment-apply",
    "--file", alignedTarget,
    "--frames", frames,
    "--backup-directory", backups,
  ], {
    cwd: PATHS.currentDflRoot,
    env: buildDflEnvironment("current"),
    input: JSON.stringify({ landmarks: face.landmarks }),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).applied, true);
  assert.ok((await stat(path.join(backups, face.alignedName))).size > 0);
  assert.ok((await stat(alignedTarget)).size > 0);
});

test("managed projects cannot escape their root and refuse active-job switches", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ProjectManager({
    registryRoot: path.join(root, "registry"),
    registryFile: path.join(root, "registry", "projects.json"),
    managedRoot: path.join(root, "workspaces"),
    legacyWorkspace: path.join(root, "legacy"),
  });
  await mkdir(path.join(root, "legacy"), { recursive: true });
  const created = await manager.create({ name: "Interview A", id: "interview-a" });
  assert.equal(created.id, "interview-a");
  assert.ok(created.workspaceRoot.startsWith(path.join(root, "workspaces")));
  await assert.rejects(
    () => manager.activate("interview-a", [{ id: "job-1", state: "running" }]),
    (error) => error.code === "PROJECT_BUSY" && error.status === 409,
  );
  const activated = await manager.activate("interview-a", [{ id: "job-2", state: "succeeded" }]);
  assert.equal(activated.restartRequired, true);
  assert.equal((await manager.list()).activeId, "interview-a");
});

test("video segment manifests enforce bounded in-range cuts", () => {
  const segments = normalizeSegments([
    { start: 1.25, end: 2.5, label: "A", selected: true },
    { start: 0, end: 1.2, label: "B", selected: false },
  ], 6);
  assert.deepEqual(segments.map((segment) => segment.label), ["B", "A"]);
  assert.ok(segments.every((segment) => /^seg-[a-f0-9]{10}$/.test(segment.id)));
  assert.throws(() => normalizeSegments([{ start: 5, end: 7 }], 6), /超出视频时长/);
  assert.throws(() => normalizeSegments(Array.from({ length: 101 }, () => ({ start: 0, end: 1 })), 6));
});

test("pose probe manifest is deterministic, bounded, and uses the shared pose cells", async () => {
  const first = await buildAlignedPoseProbe("src");
  const second = await buildAlignedPoseProbe("src");
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.cells.length, first.yawTicks.length * first.pitchTicks.length);
  assert.ok(first.samples.length <= 180);
  assert.ok(first.cells.every((cell) => cell.selectedCount <= 3));
  assert.equal(new Set(first.samples.map((sample) => sample.id)).size, first.samples.length);
  assert.deepEqual(
    first.samples.map((sample) => sample.id),
    second.samples.map((sample) => sample.id),
  );
  assert.equal(first.datasetFingerprint, second.datasetFingerprint);
  assert.ok(first.samples.every((sample) => (
    sample.cellId === `p${sample.pitchTick}-y${sample.yawTick}`
  )));
});

test("training evaluation manifests are content-addressed and snapshot reads ignore pending data", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dfl-training-evaluation-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  let reverseSamples = false;
  let srcFingerprint = "a".repeat(64);
  const yawTicks = [-15, 0, 15];
  const pitchTicks = [15, 0, -15];
  const makeSample = (side, yawTick, ordinal) => ({
    id: `${side}-p0-y${yawTick}-${String(ordinal).padStart(2, "0")}`,
    side,
    name: `${side}-${yawTick}-${ordinal}.jpg`,
    sha256Prefix: String(ordinal).repeat(16),
    sourceFilename: `${side}-${yawTick}.png`,
    cellId: `p0-y${yawTick}`,
    yaw: yawTick,
    pitch: 0,
    yawTick,
    pitchTick: 0,
    sharpness: 0.4,
    brightness: 0.5,
    hasAppliedMask: false,
  });
  const probeBuilder = async (side) => {
    const samples = [makeSample(side, -15, 1), makeSample(side, 15, 1)];
    if (reverseSamples) samples.reverse();
    return {
      schemaVersion: 1,
      side,
      datasetFingerprint: side === "src" ? srcFingerprint : "b".repeat(64),
      sampleCount: samples.length,
      yawTicks,
      pitchTicks,
      samples,
    };
  };
  const manager = new TrainingEvaluationManager({
    root: path.join(temporaryDirectory, "active"),
    archiveRoot: path.join(temporaryDirectory, "archive"),
    probeBuilder,
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  await manager.initialize();
  const modelName = "web smoke 128";
  const modelKey = createTrainingModelKey(modelName, "SAEHD");
  const first = await manager.createOrReuseManifest(modelKey, { modelName, modelClass: "SAEHD" });
  reverseSamples = true;
  const reused = await manager.createOrReuseManifest(modelKey, { modelName, modelClass: "SAEHD" });
  assert.equal(reused.manifestId, first.manifestId);
  assert.equal((await manager.listManifests(modelKey)).manifests.length, 1);

  srcFingerprint = "c".repeat(64);
  const changed = await manager.createOrReuseManifest(modelKey, { modelName, modelClass: "SAEHD" });
  assert.notEqual(changed.manifestId, first.manifestId);
  const manifests = await manager.listManifests(modelKey);
  assert.equal(manifests.manifests.length, 2);
  assert.equal(manifests.activeManifestId, changed.manifestId);

  const snapshotId = "iter-00008000-abcdef12";
  const snapshotsRoot = path.join(manager.modelDirectory(modelKey), "snapshots");
  await mkdir(path.join(snapshotsRoot, snapshotId), { recursive: true });
  await writeFile(path.join(snapshotsRoot, snapshotId, "summary.json"), JSON.stringify({
    schemaVersion: 1,
    snapshotId,
    modelKey,
    manifestId: changed.manifestId,
    iteration: 8000,
    metricSchemaVersion: 1,
    modelSignature: { class: "SAEHD", resolution: 128, faceType: "wf" },
    createdAt: "2026-08-03T00:10:00.000Z",
    samples: [],
  }));
  await mkdir(path.join(snapshotsRoot, "_pending-deadbeef"), { recursive: true });
  await writeFile(path.join(snapshotsRoot, "_pending-deadbeef", "summary.json"), "{}");
  const snapshots = await manager.listSnapshots(modelKey);
  assert.deepEqual(snapshots.snapshots.map((snapshot) => snapshot.snapshotId), [snapshotId]);
  assert.equal((await manager.getSnapshot(modelKey, snapshotId)).iteration, 8000);
  assert.deepEqual(
    (await manager.archiveSnapshots(modelKey, [snapshotId])).archivedSnapshotIds,
    [snapshotId],
  );
  assert.equal((await manager.listSnapshots(modelKey)).snapshots.length, 0);
  assert.deepEqual(
    (await manager.restoreSnapshots(modelKey, [snapshotId])).restoredSnapshotIds,
    [snapshotId],
  );
  assert.equal((await manager.listSnapshots(modelKey)).snapshots.length, 1);
  assert.throws(
    () => manager.snapshotDirectory(modelKey, "../outside"),
    (error) => error.code === "SNAPSHOT_ID_INVALID",
  );
  await assert.rejects(
    manager.createOrReuseManifest("unsafe-model-key", { modelName, modelClass: "SAEHD" }),
    (error) => error.code === "MODEL_KEY_MISMATCH",
  );
});

test("SAEHD guided preflight binds a real manifest to fixed server-owned paths", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dfl-training-preflight-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const manager = new TrainingEvaluationManager({
    root: path.join(temporaryDirectory, "active"),
    archiveRoot: path.join(temporaryDirectory, "archive"),
  });
  await manager.initialize();
  const parameters = {
    targetIterations: 100000,
    forceModelName: "web-smoke-128",
    silentStart: true,
    gpuIndexes: "0",
    cpuOnly: false,
  };
  const prepared = await prepareCommand("train.saehd", {
    launchMode: "guided",
    parameters,
    trainingEvaluationManager: manager,
  });
  assert.equal(prepared.preflight.evaluation.enabled, true);
  assert.equal(
    assertWithin(manager.root, prepared.preflight.evaluation.manifestPath),
    prepared.preflight.evaluation.manifestPath,
  );
  const launch = buildCommand(prepared.definition, {
    launchMode: prepared.launchMode,
    parameters: prepared.parameters,
    preflight: prepared.preflight,
    controlFile: path.join(PATHS.jobsRoot, "fixed-job", "control.jsonl"),
    previewFile: path.join(PATHS.jobsRoot, "fixed-job", "preview.png"),
  }).launch;
  assert.equal(launch.evaluation.enabled, true);
  assert.equal(launch.env.DFL_WEB_EVAL_MANIFEST, prepared.preflight.evaluation.manifestPath);
  assert.equal(launch.env.DFL_WEB_EVAL_ROOT, prepared.preflight.evaluation.evaluationRoot);
});

test("training evaluation metrics and snapshot publication are deterministic and atomic", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dfl-evaluation-python-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const helperDirectory = path.join(PATHS.webuiRoot, "python");
  const source = `
import json
import sys
from pathlib import Path
import numpy as np
sys.path.insert(0, ${JSON.stringify(helperDirectory)})
from training_evaluation import AtomicEvaluationSnapshot, reconstruction_metrics, swap_metrics

root = Path(sys.argv[1])
image = np.full((16, 16, 3), 0.5, dtype=np.float32)
changed = image.copy()
changed[4:12, 4:12] = 0.25
mask = np.zeros((16, 16, 1), dtype=np.float32)
mask[3:13, 3:13] = 1.0
eyes = np.zeros((16, 16, 1), dtype=np.float32)
eyes[5:8, 5:11] = 1.0
metrics = reconstruction_metrics(image, changed, mask, eyes, mask)
metrics["nonFiniteProbe"] = float("nan")
swap = swap_metrics(image, changed, mask, mask)
snapshot = AtomicEvaluationSnapshot(
    root,
    "web-smoke-128-saehd-123456789abc",
    "a" * 24,
    8000,
    {"class": "SAEHD", "resolution": 16, "faceType": "wf"},
)
snapshot.add_sample(
    {"id": "dst-p0-y0-01", "side": "dst", "cellId": "p0-y0", "yaw": 0, "pitch": 0},
    {"input": image, "reconstruction": changed, "target-mask": mask},
    {"reconstruction": metrics, "swap": swap},
)
summary = snapshot.publish()
published_summary = json.loads((root / "snapshots" / summary["snapshotId"] / "summary.json").read_text())
print(json.dumps({
    "snapshotId": summary["snapshotId"],
    "maskedMse": metrics["maskedMse"],
    "maskDice": metrics["maskDice"],
    "published": (root / "snapshots" / summary["snapshotId"] / "summary.json").is_file(),
    "pending": any(path.name.startswith("_pending-") for path in (root / "snapshots").iterdir()),
    "nonFiniteSanitized": published_summary["samples"][0]["metrics"]["reconstruction"]["nonFiniteProbe"] is None,
}))
`;
  const result = spawnSync(PATHS.python, ["-c", source, temporaryDirectory], {
    encoding: "utf8",
    env: buildDflEnvironment("legacy"),
    cwd: PATHS.legacyDflRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.snapshotId, /^iter-00008000-[a-f0-9]{8}$/);
  assert.ok(output.maskedMse > 0);
  assert.equal(output.maskDice, 1);
  assert.equal(output.published, true);
  assert.equal(output.pending, false);
  assert.equal(output.nonFiniteSanitized, true);
});

test("SAEHD pose evaluation is statically isolated from optimizer and save calls", async () => {
  const modelSource = await readFile(
    path.join(PATHS.legacyDflRoot, "models", "Model_SAEHD", "Model.py"),
    "utf8",
  );
  const method = modelSource.slice(
    modelSource.indexOf("    def evaluate_pose_probes(self):"),
    modelSource.indexOf("    def export_dfm(self):"),
  );
  assert.match(method, /self\.AE_view\(/);
  assert.match(method, /DFL_WEBUI_PYTHON/);
  assert.doesNotMatch(method, /self\.(?:src_dst_train|D_train|D_src_dst_train|save|onSave)\(/);
});

test("pose comparison normalizes unequal datasets and identifies actionable SRC gaps", () => {
  const atlas = (side, counts) => ({
    side,
    validCount: Object.values(counts).reduce((total, count) => total + count, 0),
    cells: [
      { id: "front", yaw: 0, pitch: 0, count: counts.front ?? 0 },
      { id: "left", yaw: -30, pitch: 0, count: counts.left ?? 0 },
      { id: "right", yaw: 30, pitch: 0, count: counts.right ?? 0 },
    ],
  });
  const comparison = buildPoseComparison(
    atlas("src", { front: 80, left: 20 }),
    atlas("dst", { front: 50, right: 50 }),
  );

  assert.equal(comparison.matchScore, 0.5);
  assert.equal(comparison.destinationCoverage, 0.5);
  assert.equal(comparison.gapCount, 1);
  assert.equal(comparison.deficitCount, 1);
  assert.equal(comparison.cells.find((cell) => cell.id === "right").status, "missing-src");
  assert.equal(comparison.cells.find((cell) => cell.id === "left").status, "src-only");
  assert.equal(comparison.cells.find((cell) => cell.id === "front").status, "src-surplus");
});

test("audit sharpness uses an eroded XSeg region while retaining the full-frame baseline", () => {
  const helperDirectory = path.join(PATHS.webuiRoot, "python");
  const source = `
import json
import sys
import cv2
import numpy as np
sys.path.insert(0, ${JSON.stringify(helperDirectory)})
from dfl_asset_tool import bounded_image_metrics

image = np.full((128, 128, 3), 40, dtype=np.uint8)
checker = ((np.indices((128, 64)).sum(axis=0) % 2) * 255).astype(np.uint8)
image[:, 64:, :] = checker[:, :, None]
mask = np.zeros((128, 128, 1), dtype=np.float32)
mask[:, :64, 0] = 1.0
print(json.dumps(bounded_image_metrics(image, mask)))
`;
  const result = spawnSync(PATHS.python, ["-c", source], {
    encoding: "utf8",
    env: buildDflEnvironment("current"),
    cwd: PATHS.currentDflRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.equal(metrics.sharpnessScope, "xseg");
  assert.equal(metrics.maskValid, true);
  assert.ok(metrics.maskCoverage > 0.49 && metrics.maskCoverage < 0.51);
  assert.ok(metrics.maskSamplePixels >= 64);
  assert.ok(metrics.sharpness < metrics.fullSharpness);
});

test("PackedFaceset preflight counts configs without executing pickle callables", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dfl-pack-review-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const helper = path.join(PATHS.webuiRoot, "python", "dfl_asset_tool.py");
  const packPath = path.join(temporaryDirectory, "faceset.pak");
  const markerPath = path.join(temporaryDirectory, "pickle-executed.txt").replaceAll("\\", "/");
  const maliciousMetadata = Buffer.from(
    `cbuiltins\neval\n(V__import__('pathlib').Path('${markerPath}').write_text('owned')\ntR.`,
    "utf8",
  );
  const packPayload = (metadata) => {
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(1n, 0);
    header.writeBigUInt64LE(BigInt(metadata.length), 8);
    return Buffer.concat([header, metadata]);
  };
  await writeFile(packPath, packPayload(maliciousMetadata));
  let result = spawnSync(
    PATHS.python,
    [helper, "pack-inspect", "--directory", temporaryDirectory],
    { encoding: "utf8", env: buildDflEnvironment("current"), cwd: PATHS.currentDflRoot },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "invalid");
  await assert.rejects(access(path.join(temporaryDirectory, "pickle-executed.txt")));

  const safeMetadata = Buffer.from([
    0x80, 0x04, 0x5d, 0x94, 0x28,
    0x7d, 0x94, 0x7d, 0x94, 0x7d, 0x94,
    0x65, 0x2e,
  ]);
  await writeFile(packPath, packPayload(safeMetadata));
  result = spawnSync(
    PATHS.python,
    [helper, "pack-inspect", "--directory", temporaryDirectory],
    { encoding: "utf8", env: buildDflEnvironment("current"), cwd: PATHS.currentDflRoot },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "ready");
  assert.equal(payload.sampleCount, 3);
});

test("coverage pagination keeps aligned faces after frame 500 out of orphan counts", async (t) => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 1 });
  const sample = assets.items.find((item) => item.sourceFilename);
  assert.ok(sample, "real SRC aligned metadata should include a source frame");
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dfl-coverage-review-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const framesDirectory = path.join(temporaryDirectory, "frames");
  const alignedDirectory = path.join(temporaryDirectory, "aligned");
  await mkdir(framesDirectory);
  await mkdir(alignedDirectory);
  const sourceFrame = path.join(PATHS.workspaceRoot, "data_src", path.basename(sample.sourceFilename));
  const alignedImage = path.join(PATHS.workspaceRoot, "data_src", "aligned", sample.name);
  await Promise.all(Array.from({ length: 500 }, (_, index) => link(
    sourceFrame,
    path.join(framesDirectory, `!${String(index).padStart(4, "0")}.png`),
  )));
  await link(sourceFrame, path.join(framesDirectory, path.basename(sample.sourceFilename)));
  await link(alignedImage, path.join(alignedDirectory, sample.name));

  const helper = path.join(PATHS.webuiRoot, "python", "dfl_asset_tool.py");
  const result = spawnSync(
    PATHS.python,
    [
      helper,
      "coverage",
      "--frames",
      framesDirectory,
      "--directory",
      alignedDirectory,
      "--offset",
      "500",
      "--limit",
      "10",
    ],
    { encoding: "utf8", env: buildDflEnvironment("current"), cwd: PATHS.currentDflRoot },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.total, 501);
  assert.equal(payload.offset, 500);
  assert.equal(payload.items[0].name, path.basename(sample.sourceFilename));
  assert.equal(payload.items[0].faceCount, 1);
  assert.equal(payload.coveredCount, 1);
  assert.equal(payload.orphanAlignmentCount, 0);
});

test("workspace inspector exposes only fixed materials, models, and outputs", async () => {
  const workspace = await inspectWorkspace();
  assert.equal(workspace.root, PATHS.workspaceRoot);
  assert.ok(Object.hasOwn(workspace.materials, "src"));
  assert.ok(Object.hasOwn(workspace.materials, "dst"));
  assert.equal(typeof workspace.datasets.srcFrames.count, "number");
  assert.ok(Array.isArray(workspace.models));
  assert.equal(resolveWorkspaceArtifact("result.mp4"), path.join(PATHS.workspaceRoot, "result.mp4"));
  assert.throws(
    () => resolveWorkspaceArtifact("other.mp4"),
    (error) => error.code === "ARTIFACT_NOT_ALLOWED",
  );
});

test("command display quotes paths without invoking a shell", () => {
  assert.equal(
    formatCommand("C:\\Program Files\\python.exe", ["main.py", "--model", "SAEHD"]),
    '"C:\\Program Files\\python.exe" main.py --model SAEHD',
  );
});

test("output parser extracts metrics, prompts, and strips ANSI", () => {
  const parser = new OutputParser();
  const metrics = parser.push("\u001b[32m[12:00:00][#000123][0450ms][0.4321][0.5678]\u001b[0m\r");
  assert.deepEqual(metrics[0], {
    type: "job.metric",
    payload: {
      iteration: 123,
      iterationTime: "0450ms",
      iterationTimeMs: 450,
      srcLoss: 0.4321,
      dstLoss: 0.5678,
    },
  });
  const prompt = parser.push("\n请选择 GPU [0]：");
  assert.equal(prompt[0].type, "terminal.prompt");
  const fatal = parser.push("\n/!\\ ffmpeg fail, job commandline: [...]");
  assert.equal(fatal[0].type, "job.error");
  const ffmpegMetadata = new OutputParser();
  assert.equal(ffmpegMetadata.push("\n15 tbc (default)\r").length, 0);
  assert.equal(parser.push("\n按 Enter 停止训练并保存进度").length, 0);
  assert.equal(stripAnsi("\u001b[31m错误\u001b[0m"), "错误");
  const modelPrompt = new OutputParser().push(
    "\u001b[2J\u001b[H[new] 没有发现模型，输入一个名字新建模型 :"
      + "\u001b]0;C:\\Python\\python.exe\u0007\u001b[?25h",
  );
  assert.equal(modelPrompt[0].type, "terminal.prompt");
  assert.match(modelPrompt[0].payload.prompt, /新建模型/);
});

test("safe stop ends a training task that is still waiting in startup prompts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dfl-safe-stop-"));
  const manager = new JobManager();
  manager.persist = async () => {};
  let killed = false;
  const job = {
    id: "waiting-xseg",
    commandId: "xseg.train",
    label: "训练 XSeg",
    shortLabel: "XSeg 训练",
    profile: "legacy",
    category: "training",
    launchMode: "cli",
    parameters: {},
    controls: ["close"],
    locks: [],
    state: "waiting_input",
    pid: 123,
    exitCode: null,
    signal: null,
    sequence: 0,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    stopReason: null,
    commandLine: "python main.py train --model XSeg",
    error: null,
    latestPrompt: "没有发现模型，输入一个名字新建模型 :",
    latestMetric: null,
    latestProgress: null,
    previewVersion: null,
    latestEvaluationSnapshotId: null,
    evaluation: null,
    directory,
    metadataFile: path.join(directory, "metadata.json"),
    eventsFile: path.join(directory, "events.ndjson"),
    controlFile: path.join(directory, "control.jsonl"),
    previewFile: path.join(directory, "preview.png"),
    runner: { kill() { killed = true; } },
    parser: new OutputParser(),
    events: [],
    writeChain: Promise.resolve(),
    metadataWriteChain: Promise.resolve(),
    previewTimer: null,
    stopTimer: null,
    artifactPollPending: false,
    evaluationSnapshotIds: new Set(),
  };
  manager.jobs.set(job.id, job);
  const result = await manager.control(job.id, "close");
  await manager.waitForWrites(job.id);
  assert.equal(killed, true);
  assert.equal(result.state, "stopping");
  assert.equal(result.stopReason, "safe-stop-before-start");
  await rm(directory, { recursive: true, force: true });
});

test("output parser exposes real tqdm percentage, counts, and ETA without duplicate events", () => {
  const parser = new OutputParser();
  assert.equal(parser.push("合成进度:  52%|#####################################6").length, 0);
  const progress = parser.push("| 47/90 [00:14<00:13,  3.29it/s]");
  assert.deepEqual(progress, [{
    type: "job.progress",
    payload: {
      stage: "合成进度",
      percent: 52,
      current: 47,
      total: 90,
      elapsedSeconds: 14,
      etaSeconds: 13,
      rate: "3.29it/s",
    },
  }]);
  assert.equal(
    parser.push("\r合成进度:  52%|###################################### | 48/90 [00:15<00:12,  3.50it/s]")
      .filter((event) => event.type === "job.progress").length,
    0,
  );
  assert.equal(parser.push("\r\n处理中…").filter((event) => event.type === "job.progress").length, 0);
  const nextStage = parser.push("\r计算运动矢量:   0%|               | 0/90 [00:00<?, ?it/s]");
  assert.deepEqual(nextStage.find((event) => event.type === "job.progress")?.payload, {
    stage: "计算运动矢量",
    percent: 0,
    current: 0,
    total: 90,
    elapsedSeconds: 0,
    etaSeconds: null,
    rate: null,
  });
});

test("GPU telemetry parser handles NVIDIA CSV values and unavailable fields", () => {
  const gpus = parseNvidiaSmiCsv(
    "0, NVIDIA RTX 4090, 87, 12288, 24564, 71, 320.5, 450.0, N/A\n",
  );
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].utilizationPercent, 87);
  assert.equal(gpus[0].memoryTotalMiB, 24564);
  assert.equal(gpus[0].temperatureC, 71);
  assert.equal(gpus[0].fanPercent, null);
});

test("resource locks reject conflicting tasks and release by owner", () => {
  const manager = new JobManager();
  manager.acquireLocks("job-one", ["gpu", "workspace:model"]);
  assert.throws(
    () => manager.acquireLocks("job-two", ["gpu"]),
    (error) => error.code === "RESOURCE_LOCKED" && error.status === 409,
  );
  manager.releaseLocks({ id: "job-one", locks: ["gpu", "workspace:model"] });
  assert.doesNotThrow(() => manager.acquireLocks("job-two", ["gpu"]));
});

test("external window adapter explicitly reports the reserved capability", async () => {
  const adapter = new DisabledExternalWindowAdapter();
  assert.equal(adapter.capabilities().supported, false);
  await assert.rejects(() => adapter.attach(), /未启用/);
});

test("legacy Trainer bridge remains valid Python syntax", () => {
  const trainerPath = path.join(
    PATHS.repositoryRoot,
    "_internal",
    "DeepFaceLab_old",
    "mainscripts",
    "Trainer.py",
  );
  const source = [
    "import ast, pathlib",
    `ast.parse(pathlib.Path(r'${trainerPath.replaceAll("\\", "\\\\")}').read_text(encoding='utf-8'))`,
  ].join("; ");
  const result = spawnSync(PATHS.python, ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("runtime state ignores stale snapshots and out-of-order job events", () => {
  const current = [{ id: "job-one", state: "succeeded", sequence: 12 }];
  assert.deepEqual(
    mergeJobs(current, [{ id: "job-one", state: "running", sequence: 11 }]),
    current,
  );
  assert.equal(
    applyEventToJob(
      { id: "job-one", sequence: 13 },
      {
        jobId: "job-one",
        sequence: 14,
        type: "job.progress",
        payload: { stage: "合成进度", percent: 50, current: 45, total: 90, etaSeconds: 12 },
      },
    ).latestProgress.percent,
    50,
  );
  assert.equal(
    applyEventToJob(
      { id: "job-one", sequence: 14, previewVersion: 10 },
      {
        jobId: "job-one",
        sequence: 15,
        type: "job.artifact",
        payload: { kind: "training-evaluation", snapshotId: "iter-00008000-abcdef12" },
      },
    ).latestEvaluationSnapshotId,
    "iter-00008000-abcdef12",
  );
  assert.deepEqual(
    applyEventToJob(current[0], {
      jobId: "job-one",
      sequence: 10,
      type: "job.state",
      payload: { state: "running" },
    }),
    current[0],
  );
  assert.deepEqual(
    applyEventToJob(current[0], {
      jobId: "job-one",
      sequence: 13,
      timestamp: "2026-07-30T00:00:00.000Z",
      type: "job.finished",
      payload: { state: "failed", exitCode: 1 },
    }),
    {
      id: "job-one",
      state: "failed",
      sequence: 13,
      endedAt: "2026-07-30T00:00:00.000Z",
      exitCode: 1,
    },
  );
});

test("ConPTY runner streams output and accepts interactive input", { timeout: 10000 }, async () => {
  let output = "";
  const runner = createPtyRunner({
    executable: PATHS.python,
    args: ["-c", "value=input('Answer? '); print('got:'+value)"],
    cwd: PATHS.repositoryRoot,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    cols: 80,
    rows: 20,
  });
  await new Promise((resolve, reject) => {
    let answered = false;
    runner.onData((chunk) => {
      output += chunk;
      if (!answered && output.includes("Answer?")) {
        answered = true;
        runner.write("yes\r");
      }
    });
    runner.onExit(({ exitCode }) => {
      runner.dispose();
      if (exitCode === 0) resolve();
      else reject(new Error(`PTY exited with ${exitCode}: ${output}`));
    });
  });
  assert.match(output, /got:yes/);
});
