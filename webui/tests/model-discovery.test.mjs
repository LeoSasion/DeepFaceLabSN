import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverModels } from "../server/workspace-manager.mjs";

test("XSeg discovery returns saved model names and ignores directory-only readiness", async () => {
  const parent = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, "dfl-model-discovery-"));
  try {
    const modelRoot = path.join(directory, "xseg_model");
    await mkdir(modelRoot);
    await writeFile(path.join(modelRoot, "XSeg_default_options.dat"), "options");
    await writeFile(path.join(modelRoot, "README.txt"), "not a model");
    const empty = await discoverModels(directory);
    assert.deepEqual(empty.models, []);
    assert.equal(empty.xsegStats.count, 0);
    await writeFile(path.join(modelRoot, "XSeg_256.npy"), "weights");
    await writeFile(path.join(modelRoot, "interview_guest_XSeg_data.dat"), "saved state");
    await writeFile(path.join(modelRoot, "incomplete_XSeg_data.dat"), "");
    const saved = await discoverModels(directory);
    const model = saved.models.find(item => item.name === "interview_guest");
    assert.equal(model.type, "XSeg");
    assert.equal(model.ready, true);
    assert.deepEqual(model.files, ["interview_guest_XSeg_data.dat"]);
    assert.equal(saved.models.some(item => item.name === "xseg_model"), false);
    assert.equal(saved.models.find(item => item.name === "incomplete").ready, false);
    assert.equal(saved.xsegStats.count, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith("dfl-model-discovery-"));
    await rm(directory, { recursive: true, force: true });
  }
});
