import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  navigationWorkflowStages,
  workflowStageDestinations,
  workflowStages,
} from "../src/data/dashboard.js";

test("every workflow stage has a concrete navigation destination", () => {
  assert.deepEqual(
    Object.keys(workflowStageDestinations),
    workflowStages.map((stage) => stage.id),
  );

  for (const stage of workflowStages) {
    assert.match(workflowStageDestinations[stage.id].nav, /\S/);
  }
});

test("workflow destinations cover the dedicated command and product pages", () => {
  assert.deepEqual(workflowStageDestinations, {
    material: { nav: "video" },
    frames: { nav: "workflow.frames", task: "extract" },
    faces: { nav: "workflow.faces", task: "src" },
    clean: { nav: "workflow.clean", task: "sort" },
    mask: { nav: "xseg", task: "xseg" },
    train: { nav: "overview", task: "saehd" },
    diagnose: { nav: "diagnostics", task: "diagnose" },
    merge: { nav: "merge", task: "merge" },
    encode: { nav: "export", task: "export" },
  });
});

test("primary navigation keeps the workflow highlight synchronized", () => {
  assert.equal(navigationWorkflowStages.video, "material");
  assert.equal(navigationWorkflowStages.xseg, "mask");
  assert.equal(navigationWorkflowStages.training, "train");
  assert.equal(navigationWorkflowStages.diagnostics, "diagnose");
  assert.equal(navigationWorkflowStages.merge, "merge");
  assert.equal(navigationWorkflowStages.export, "encode");
});

test("terminal safe stop targets the selected training session", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(
    source,
    /onSafeStop=\{\(\) => selectedJob\?\.id && setStopTargetJobId\(selectedJob\.id\)\}/,
  );
  assert.match(source, /runtime\.control\("close", targetJobId\)/);
});
