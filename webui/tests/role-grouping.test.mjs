import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildAlignedRoleGroups, retainAlignedRoles, listAlignedAssets } from "../server/asset-manager.mjs";
import { PATHS } from "../server/paths.mjs";

test("person grouping separates cooccurrence, weak bridges and invalid descriptors", () => {
  const result = spawnSync(process.env.DFLSN_TEST_PYTHON || PATHS.python,
    ["tests/role-grouping-contract.py"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("role retention rejects empty, unsafe and outdated selections without moving images", {
  skip: process.env.DFLSN_ISOLATED_TEST_ROOT ? false : "requires isolated fixture",
}, async () => {
  const before = await listAlignedAssets("src");
  for (const names of [[], ["../outside.jpg"], ["a.jpg", null], Array(2001).fill("a.jpg")]) {
    await assert.rejects(retainAlignedRoles("src", { names, fingerprint: "old" }),
      { code: "ROLE_SELECTION_INVALID" });
  }
  await assert.rejects(retainAlignedRoles("src", { names: [before.items[0].name], fingerprint: "old" }),
    { code: "ROLE_DATASET_CHANGED", status: 409 });
  const after = await listAlignedAssets("src");
  assert.deepEqual(after.items.map(item => item.name), before.items.map(item => item.name));
  await assert.rejects(buildAlignedRoleGroups("src", { threshold: .99 }), { code: "ROLE_THRESHOLD_INVALID" });
});
