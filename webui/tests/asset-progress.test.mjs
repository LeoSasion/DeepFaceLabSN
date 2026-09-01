import assert from "node:assert/strict";
import test from "node:test";
import {
  auditAlignedAssets,
  buildAlignedPoseAtlas,
  inspectExtractionCoverage,
} from "../server/asset-manager.mjs";

const isolated = Boolean(process.env.DFLSN_ISOLATED_TEST_ROOT);

test("asset helpers expose real determinate progress without polluting their JSON result", {
  skip: isolated ? false : "requires the isolated generated DFL fixture",
}, async () => {
  const auditProgress = [];
  const audit = await auditAlignedAssets("src", {
    refresh: true,
    limit: 3,
    onProgress: (update) => auditProgress.push(update),
  });
  assert.equal(audit.analyzedCount, 3);
  assert.equal(auditProgress[0].stage, "audit-samples");
  assert.equal(auditProgress[0].current, 0);
  assert.equal(auditProgress.at(-1).current, auditProgress.at(-1).total);
  assert.equal(auditProgress.at(-1).percent, 100);

  const atlasProgress = [];
  const atlas = await buildAlignedPoseAtlas("dst", {
    onProgress: (update) => atlasProgress.push(update),
  });
  assert.equal(atlas.total, 3);
  assert.equal(atlasProgress[0].stage, "pose-atlas");
  assert.equal(atlasProgress.at(-1).current, atlasProgress.at(-1).total);
  assert.equal(atlasProgress.at(-1).percent, 100);

  const coverageProgress = [];
  const coverage = await inspectExtractionCoverage("src", {
    refresh: true,
    limit: 3,
    onProgress: (update) => coverageProgress.push(update),
  });
  assert.equal(coverage.analyzedCount, 3);
  assert.equal(coverageProgress[0].stage, "coverage-alignments");
  assert.equal(coverageProgress.at(-1).current, coverageProgress.at(-1).total);
  assert.equal(coverageProgress.at(-1).percent, 100);
});
