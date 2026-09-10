import assert from "node:assert/strict";
import test from "node:test";
import {
  commandModelFamily, createTaskConfiguration, displayWorkspacePath,
  modelNameIssue, searchTaskCommands, taskModels, taskOutputLocations,
} from "../src/domain/task-configuration.js";
import { listCommands } from "../server/command-registry.mjs";

const commands = listCommands();
const command = id => commands.find(item => item.id === id);
const saved = [
  { name: "interview", type: "SAEHD", files: ["interview_SAEHD_data.dat", "interview_SAEHD_encoder.npy"] },
  { name: "other-family", type: "ME", files: ["other-family_ME_data.dat"] },
];

test("model choices match fixed command families and exclude incomplete or synthetic entries", () => {
  for (const item of commands.filter(item => item.parameters.some(parameter => parameter.id === "forceModelName"))) {
    assert.ok(commandModelFamily(item), `${item.id} needs a model family`);
  }
  assert.equal(commandModelFamily(command("export.dfm_q384")), "Q384");
  assert.deepEqual(taskModels(command("train.saehd"), [...saved,
    { name: "weights-only", type: "SAEHD", files: ["weights-only_SAEHD_encoder.npy"] },
  ]), [saved[0]]);
  assert.deepEqual(taskModels(command("xseg.train"), [{ name: "xseg_model", type: "XSeg" }]), []);
});

test("task defaults preserve explicit resume parameters and never carry unregistered arguments", () => {
  const result = createTaskConfiguration(command("train.saehd"), {
    forceModelName: "interview", cpuOnly: true, gpuIndexes: "0,1", targetIterations: 1234, executable: "outside.exe",
  }, saved);
  assert.equal(result.newModel, false);
  assert.equal(result.parameters.forceModelName, "interview");
  assert.equal(result.parameters.targetIterations, 1234);
  assert.equal(result.parameters.cpuOnly, true);
  assert.equal(result.parameters.gpuIndexes, "");
  assert.equal(Object.hasOwn(result.parameters, "executable"), false);
  const unique = createTaskConfiguration(command("train.saehd"), null, saved);
  assert.equal(unique.parameters.forceModelName, "interview");
  assert.equal(unique.parameters.silentStart, true);
  assert.equal(createTaskConfiguration(command("train.saehd"), { forceModelName: "" }, saved).parameters.forceModelName, "");
  const multiple = createTaskConfiguration(command("train.saehd"), {}, [...saved, { ...saved[0], name: "second" }]);
  assert.equal(multiple.parameters.forceModelName, "");
});

test("new-model intent cannot silently continue a same-name model on Windows", () => {
  const fresh = createTaskConfiguration(command("train.saehd"), {}, []);
  assert.equal(fresh.newModel, true);
  assert.equal(fresh.parameters.silentStart, false);
  assert.equal(modelNameIssue("", true, saved), "empty");
  assert.equal(modelNameIssue("INTERVIEW", true, saved), "duplicate");
  assert.equal(modelNameIssue("../interview", true, saved), "invalid");
  assert.equal(modelNameIssue(" interview ", true, saved), "invalid");
  assert.equal(modelNameIssue("访谈第二版", true, saved), null);
  assert.equal(modelNameIssue("interview", false, saved), null);
});

test("task search counts true matches and combines trimmed case-insensitive terms", () => {
  assert.deepEqual(searchTaskCommands(commands, "  "), commands);
  assert.equal(searchTaskCommands(commands, "a-task-that-does-not-exist").length, 0);
  const found = searchTaskCommands(commands, "  SAEHD    训练 ");
  assert.ok(found.some(item => item.id === "train.saehd"));
  assert.equal(found.some(item => item.id === "merge.saehd"), false);
});

test("output summaries follow the actual fixed workflow destinations", () => {
  assert.deepEqual(taskOutputLocations(command("xseg.train")).paths, ["xseg_model"]);
  assert.deepEqual(taskOutputLocations(command("dst.denoise_frames")).paths, ["data_dst"]);
  assert.deepEqual(taskOutputLocations(command("merge.saehd")).paths, ["data_dst/merged", "data_dst/merged_mask"]);
  assert.deepEqual(taskOutputLocations(command("encode.mov_lossless")).paths, ["result.mov", "result_mask.mov"]);
  assert.deepEqual(taskOutputLocations(command("src.faces_resize")).paths, ["data_src/aligned_resized"]);
  assert.deepEqual(taskOutputLocations(command("xseg.dst_fetch_labels")).paths, ["data_dst/aligned_xseg"]);
  assert.deepEqual(taskOutputLocations(command("video.cut_src"), { materials: { src: { name: "data_src.MP4" } } }).paths, ["data_src_cut.MP4"]);
  assert.equal(taskOutputLocations(command("runtime.prepare_vision")).note, "runtime");
  assert.equal(displayWorkspacePath("C:\\DFL\\workspace\\", "data_src/aligned"), "C:\\DFL\\workspace\\data_src\\aligned");
  assert.equal(displayWorkspacePath("/home/dfl/workspace/", "xseg_model"), "/home/dfl/workspace/xseg_model");
});
