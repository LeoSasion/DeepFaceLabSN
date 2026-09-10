import assert from "node:assert/strict";
import test from "node:test";
import { reconcileJobs, selectAvailableJob } from "../src/runtime/useRuntime.js";

const job = (id, state = "succeeded", sequence = 2) => ({ id, state, sequence, createdAt: id });

test("an authoritative job list removes archived jobs and clears an unavailable selection", () => {
  const current = [job("b"), job("a", "running")];
  const next = reconcileJobs(current, [job("a", "running")]);
  assert.deepEqual(next.map(item => item.id), ["a"]);
  assert.equal(selectAvailableJob(next, "b"), "a");
  assert.deepEqual(reconcileJobs(next, []), []);
  assert.equal(selectAvailableJob([], "a"), null);
});

test("a poll does not discard a newly started job whose response arrived during the request", () => {
  const knownAtStart = new Set(["a"]);
  const next = reconcileJobs([job("b", "queued"), job("a")], [], knownAtStart);
  assert.deepEqual(next.map(item => item.id), ["b"]);
  assert.equal(selectAvailableJob(next, "b"), "b");
  // The following authoritative response can now remove it if it is truly gone.
  assert.deepEqual(reconcileJobs(next, []), []);
});

test("snapshot reconciliation preserves newer live events while removing missing history", () => {
  const current = [job("c"), job("b", "succeeded", 9), job("a")];
  const next = reconcileJobs(current, [job("b", "running", 3), job("a")]);
  assert.deepEqual(next.map(item => item.id), ["b", "a"]);
  assert.equal(next[0].state, "succeeded");
  assert.equal(next[0].sequence, 9);
  assert.equal(selectAvailableJob(next, "a"), "a");
});

test("removing an old selection picks a live task ahead of more recent finished history", () => {
  const next = [job("c"), job("b", "waiting_input"), job("a")];
  assert.equal(selectAvailableJob(next, "archived"), "b");
  assert.equal(selectAvailableJob(next, "a"), "a");
});
