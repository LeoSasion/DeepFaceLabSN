import assert from "node:assert/strict";
import test from "node:test";

import {
  findAdjacentTerminalJobId,
  isTerminalSession,
  selectTerminalTabs,
} from "../src/domain/terminal-sessions.js";

const jobs = Array.from({ length: 14 }, (_, index) => ({
  id: `job-${index + 1}`,
  state: index === 12 ? "running" : "succeeded",
}));

test("terminal tab selection caps history but always keeps active and selected sessions", () => {
  const visible = selectTerminalTabs(jobs, new Set(), {
    limit: 5,
    selectedJobId: "job-12",
  });
  assert.deepEqual(visible.map((job) => job.id), [
    "job-1",
    "job-2",
    "job-3",
    "job-4",
    "job-5",
    "job-12",
    "job-13",
  ]);
});

test("hidden terminal sessions stay out of the rendered tab list", () => {
  const visible = selectTerminalTabs(jobs, new Set(["job-1", "job-2"]), { showAll: true });
  assert.equal(visible.some((job) => ["job-1", "job-2"].includes(job.id)), false);
  assert.equal(visible.length, 12);
});

test("closing a selected tab chooses the adjacent available session", () => {
  assert.equal(findAdjacentTerminalJobId(jobs, new Set(["job-2"]), "job-1"), "job-3");
  assert.equal(findAdjacentTerminalJobId(jobs, new Set(["job-13", "job-14"]), "job-14"), "job-12");
});

test("only completed session states are dismissible", () => {
  assert.equal(isTerminalSession({ state: "failed" }), true);
  assert.equal(isTerminalSession({ state: "cancelled" }), true);
  assert.equal(isTerminalSession({ state: "running" }), false);
  assert.equal(isTerminalSession({ state: "stopping" }), false);
});
