import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagnosticSnapshot,
  inspectStorage,
} from "../server/system-diagnostics.mjs";

test("inspectStorage preserves a safety reserve and reports shortfall", async () => {
  const result = await inspectStorage("C:\\workspace", {
    requiredBytes: 7_000,
    reserveBytes: 2_000,
    readStatfs: async () => ({
      bsize: 1n,
      blocks: 20_000n,
      bavail: 8_000n,
      bfree: 9_000n,
    }),
  });

  assert.equal(result.totalBytes, 20_000);
  assert.equal(result.freeBytes, 8_000);
  assert.equal(result.usableBytes, 6_000);
  assert.equal(result.ready, false);
  assert.equal(result.shortfallBytes, 1_000);
});

test("diagnostic snapshot excludes absolute paths, arguments, and terminal output", () => {
  const snapshot = buildDiagnosticSnapshot({
    version: "0.2.0",
    workspace: {
      root: "C:\\Users\\Example\\workspace",
      materials: {
        src: { path: "C:\\secret\\src.mp4", name: "private.mp4", extension: ".mp4", bytes: 42 },
      },
      datasets: { srcFrames: { count: 12, bytes: 900 } },
      readiness: { materials: false },
      models: [{ files: ["secret.dat"] }],
      outputs: [{ path: "C:\\secret\\result.mp4" }],
    },
    jobs: [{
      id: "job-1",
      commandId: "extract.src",
      status: "failed",
      args: ["--password", "secret"],
      output: "private terminal text",
      cwd: "C:\\secret",
    }],
  });

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /C:\\\\/);
  assert.doesNotMatch(serialized, /private\.mp4|secret\.dat|private terminal text|--password/);
  assert.equal(snapshot.jobs[0].commandId, "extract.src");
  assert.equal(snapshot.workspace.datasets.srcFrames.count, 12);
});
