import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  buildCommand,
  formatCommand,
  getCommandDefinition,
  listCommands,
  validateCommandParameters,
} from "../server/command-registry.mjs";
import { listAlignedAssets, resolveAlignedImage } from "../server/asset-manager.mjs";
import { buildDflEnvironment } from "../server/environment.mjs";
import { DisabledExternalWindowAdapter } from "../server/external-window-adapter.mjs";
import { JobManager } from "../server/job-manager.mjs";
import { OutputParser, stripAnsi } from "../server/output-parser.mjs";
import { PATHS, assertWithin } from "../server/paths.mjs";
import { createPtyRunner } from "../server/pty-runner.mjs";
import { parseNvidiaSmiCsv } from "../server/telemetry.mjs";
import { inspectWorkspace, resolveWorkspaceArtifact } from "../server/workspace-manager.mjs";
import { applyEventToJob, mergeJobs } from "../src/runtime/useRuntime.js";

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
});

test("aligned asset browser reads real DFL metadata through the fixed helper", async () => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 2 });
  assert.equal(assets.side, "src");
  assert.ok(assets.total >= assets.items.length);
  assert.ok(assets.items.every((item) => item.imageUrl.startsWith("/api/assets/src/aligned/")));
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
