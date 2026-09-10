import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requireFile, requireDirectoryWithFiles } from "../server/command-registry.mjs";
import { preflightRecovery } from "../src/domain/preflight-recovery.js";

const t = (value) => value;

test("runtime, model and material blockers route to distinct recovery actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-recovery-"));
  try {
    async function check(action, code, target, stage = "frames") {
      await assert.rejects(action, (error) => {
        assert.equal(error.code, code);
        assert.equal(preflightRecovery(error, { stage }, t).target, target);
        return true;
      });
    }
    await check(() => requireFile(path.join(root, "python.exe"), "missing", "RUNTIME_MISSING"), "RUNTIME_MISSING", "settings");
    await check(() => requireFile(path.join(root, "main.py"), "missing", "PROJECT_INCOMPLETE"), "PROJECT_INCOMPLETE", "settings");
    await check(() => requireDirectoryWithFiles(path.join(root, "model"), "missing", "MODEL_MISSING"), "MODEL_MISSING", "training", "mask");
    await mkdir(path.join(root, "model"));
    await check(() => requireDirectoryWithFiles(path.join(root, "model"), "empty", "MODEL_MISSING"), "MODEL_MISSING", "training", "merge");
    await check(() => requireDirectoryWithFiles(path.join(root, "frames"), "missing"), "INPUT_MISSING", "workspace");
    await mkdir(path.join(root, "frames"));
    await check(() => requireDirectoryWithFiles(path.join(root, "frames"), "empty"), "INPUT_EMPTY", "workspace");
    await writeFile(path.join(root, "python.exe"), "fixture");
    await requireFile(path.join(root, "python.exe"), "missing", "RUNTIME_MISSING");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parameter, resource lock and XSeg annotation guidance remains specific", () => {
  for (const [code, target] of [["PARAMETER_INVALID", "parameters"], ["RESOURCE_LOCKED", "console"], ["XSEG_LABELS_MISSING", "xseg"], ["BUNDLED_MODEL_MISSING", "settings"]]) {
    assert.equal(preflightRecovery({ code }, { stage: "train" }, t).target, target);
  }
});
