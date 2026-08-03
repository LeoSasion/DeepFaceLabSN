import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrainingPoseRegression,
  snapshotCompatibility,
} from "../src/domain/training-pose-regression.js";

const signature = {
  class: "SAEHD",
  resolution: 64,
  faceType: "wf",
  architecture: "df-d",
  dataFormat: "NCHW",
};

function sample(id, cellId, metrics, side = "dst") {
  return {
    id,
    side,
    cellId,
    yaw: Number(cellId.split("-y")[1]),
    pitch: Number(cellId.slice(1).split("-y")[0]),
    metrics: { reconstruction: metrics },
    variants: ["input", "reconstruction"],
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    snapshotId: "iter-00001000-aaaaaaaa",
    modelKey: "quality-smoke-saehd-123456789abc",
    manifestId: "a".repeat(24),
    iteration: 1000,
    metricSchemaVersion: 1,
    modelSignature: signature,
    createdAt: "2026-08-03T00:00:00.000Z",
    samples: [],
    ...overrides,
  };
}

test("snapshot compatibility exposes the four required comparison gates", () => {
  const baseline = snapshot();
  const current = snapshot({ snapshotId: "iter-00002000-bbbbbbbb", iteration: 2000 });
  const compatible = snapshotCompatibility(baseline, current);
  assert.equal(compatible.comparable, true);
  assert.deepEqual(compatible.checks.map((check) => check.id), [
    "model",
    "manifest",
    "metrics",
    "signature",
  ]);

  const mismatches = [
    ["model", { modelKey: "different-saehd-123456789abc" }],
    ["manifest", { manifestId: "b".repeat(24) }],
    ["metrics", { metricSchemaVersion: 2 }],
    ["signature", { modelSignature: { ...signature, resolution: 128 } }],
  ];
  for (const [id, override] of mismatches) {
    const result = snapshotCompatibility(baseline, { ...current, ...override });
    assert.equal(result.comparable, false);
    assert.equal(result.checks.find((check) => check.id === id).passed, false);
  }
});

test("pose regression keeps confidence separate and classifies metric direction", () => {
  const baseline = snapshot({
    samples: [
      sample("dst-p0-y0-01", "p0-y0", {
        maskedMse: 0.1,
        eyesMouthMse: 0.12,
        maskDice: 0.8,
        sharpnessRatio: 0.6,
      }),
      sample("dst-p0-y15-01", "p0-y15", {
        maskedMse: 0.08,
        eyesMouthMse: 0.08,
        maskDice: 0.9,
        sharpnessRatio: 1,
      }),
    ],
  });
  const current = snapshot({
    snapshotId: "iter-00002000-bbbbbbbb",
    iteration: 2000,
    samples: [
      sample("dst-p0-y0-01", "p0-y0", {
        maskedMse: 0.08,
        eyesMouthMse: 0.09,
        maskDice: 0.86,
        sharpnessRatio: 0.8,
      }),
      sample("dst-p0-y15-01", "p0-y15", {
        maskedMse: 0.1,
        eyesMouthMse: 0.11,
        maskDice: 0.82,
        sharpnessRatio: 1.2,
      }),
    ],
  });
  const manifest = {
    probes: {
      dst: { yawTicks: [0, 15], pitchTicks: [0] },
    },
  };
  const result = buildTrainingPoseRegression({ baseline, current, manifest });
  const improved = result.cells.find((cell) => cell.id === "p0-y0");
  const regressed = result.cells.find((cell) => cell.id === "p0-y15");

  assert.equal(result.comparable, true);
  assert.equal(improved.status, "improved");
  assert.equal(regressed.status, "regressed");
  assert.equal(improved.confidence, 1 / 3);
  assert.equal(improved.sampleCount, 1);
  assert.equal(improved.metrics.maskDice.status, "improved");
  assert.equal(improved.metrics.sharpnessRatio.status, "improved");
  assert.equal(result.totals.improved, 1);
  assert.equal(result.totals.regressed, 1);
  assert.ok(!Object.hasOwn(result, "score"));
});
