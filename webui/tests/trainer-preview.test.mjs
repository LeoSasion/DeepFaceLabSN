import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PATHS } from "../server/paths.mjs";

test("training preview PNG preserves DFL color channels and refreshes atomically", () => {
  const result = spawnSync(process.env.DFLSN_TEST_PYTHON || PATHS.python,
    ["tests/trainer-preview-contract.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
