import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCommand,
  formatCommand,
  getCommandDefinition,
  listCommands,
  validateCommandParameters,
} from "../server/command-registry.mjs";
import {
  auditAlignedAssets,
  buildAlignedPoseAtlas,
  inspectAlignedPack,
  inspectExtractionCoverage,
  listAlignedAssets,
  resolveAlignedImage,
} from "../server/asset-manager.mjs";
import { buildDflEnvironment } from "../server/environment.mjs";
import { DisabledExternalWindowAdapter } from "../server/external-window-adapter.mjs";
import { JobManager } from "../server/job-manager.mjs";
import { OutputParser, stripAnsi } from "../server/output-parser.mjs";
import { PATHS, assertWithin } from "../server/paths.mjs";
import { createPtyRunner } from "../server/pty-runner.mjs";
import { parseNvidiaSmiCsv } from "../server/telemetry.mjs";
import {
  inspectExportReadiness,
  inspectWorkspace,
  listMergeReview,
  resolveReviewAsset,
  resolveWorkspaceArtifact,
} from "../server/workspace-manager.mjs";
import { applyEventToJob, mergeJobs } from "../src/runtime/useRuntime.js";
import { buildPoseComparison } from "../src/domain/pose-comparison.js";

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
  assert.deepEqual(training.controls, ["save", "backup", "preview", "close"]);
  assert.equal(commands.find((command) => command.id === "merge.saehd").profile, "legacy");
  assert.equal(commands.find((command) => command.id === "encode.mp4").stage, "encode");
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
  const assets = await listAlignedAssets("src", { offset: 0, limit: 2 });
  assert.equal(assets.side, "src");
  assert.ok(assets.total >= assets.items.length);
  assert.ok(assets.items.every((item) => item.imageUrl.startsWith("/api/assets/src/aligned/")));
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
