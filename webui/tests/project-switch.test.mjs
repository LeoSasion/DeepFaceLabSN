import assert from "node:assert/strict";
import test from "node:test";
import { switchProjectAndWait, waitForProject } from "../src/runtime/project-switch.js";

const health = (id, ready = true) => ({ project: { id }, runtime: { workspaceAvailable: ready } });
const noDelay = async () => {};

test("project switching waits through the old project and reconnects before entering a ready target", async () => {
  const phases = [];
  const responses = [health("old"), new Error("restart offline"), health("target", false), health("target")];
  let activations = 0;
  let reads = 0;
  const result = await switchProjectAndWait("target", {
    activate: async id => { assert.equal(id, "target"); activations += 1; },
    readHealth: async () => {
      const response = responses[reads++];
      if (response instanceof Error) throw response;
      return response;
    },
    onStatus: value => phases.push(value.phase), delay: noDelay,
  });
  assert.equal(result.project.id, "target");
  assert.equal(activations, 1);
  assert.equal(reads, 4);
  assert.deepEqual(phases, ["requesting", "waiting", "reconnecting", "waiting"]);
});

test("a lost or malformed activation response is checked without repeating the write", async () => {
  for (const status of [undefined, 200, 408, 500]) {
    let writes = 0;
    let reads = 0;
    const result = await switchProjectAndWait("target", {
      activate: async () => { writes += 1; throw Object.assign(new Error("response lost"), { status }); },
      readHealth: async () => { reads += 1; return health("target"); },
    });
    assert.equal(result.project.id, "target");
    assert.equal(writes, 1);
    assert.equal(reads, 1);
  }
});

test("an activation response that never settles has a deadline and still checks the accepted target", async () => {
  let writeSignal;
  let writes = 0;
  const result = await switchProjectAndWait("target", {
    activate: (id, { signal }) => { writes += 1; writeSignal = signal; return new Promise(() => {}); },
    readHealth: async () => health("target"), activationTimeoutMs: 15,
  });
  assert.equal(result.project.id, "target");
  assert.equal(writeSignal.aborted, true);
  assert.equal(writes, 1);
});

test("a refused switch stays actionable without polling or automatically resubmitting", async () => {
  const failure = Object.assign(new Error("active tasks"), { status: 409, code: "PROJECT_BUSY" });
  let reads = 0;
  await assert.rejects(switchProjectAndWait("target", {
    activate: async () => { throw failure; },
    readHealth: async () => { reads += 1; return health("target"); },
  }), error => error === failure);
  assert.equal(reads, 0);
});

test("continuing an uncertain switch only reads state", async () => {
  const result = await switchProjectAndWait("target", {
    activate: () => assert.fail("a result check must not activate a project"),
    readHealth: async () => health("target"), checkOnly: true,
  });
  assert.equal(result.project.id, "target");
});

test("a hung health request times out without reporting success or starting overlapping reads", async () => {
  let reads = 0;
  let finish;
  let readSignal;
  const changes = [];
  await assert.rejects(waitForProject("target", {
    timeoutMs: 15, intervalMs: 1,
    readHealth: ({ signal }) => { reads += 1; readSignal = signal; return new Promise(resolve => { finish = resolve; }); },
    onStatus: state => changes.push(state),
  }), error => error.code === "PROJECT_SWITCH_UNCONFIRMED");
  assert.equal(reads, 1);
  assert.equal(readSignal.aborted, true);
  finish(health("target"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changes, []);
});

test("a reachable old project does not count as a successful switch", async () => {
  await assert.rejects(waitForProject("target", {
    readHealth: async () => health("old"), timeoutMs: 20, intervalMs: 1,
  }), error => error.code === "PROJECT_SWITCH_UNCONFIRMED");
});

test("leaving cancels observation and late responses cannot update the dialog", async () => {
  const controller = new AbortController();
  const changes = [];
  let finish;
  const pending = waitForProject("target", {
    signal: controller.signal,
    readHealth: () => new Promise(resolve => { finish = resolve; }),
    onStatus: state => changes.push(state),
  });
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  finish(health("old"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changes, []);
  await assert.rejects(switchProjectAndWait("target", {
    signal: controller.signal,
    activate: () => assert.fail("aborted action must not write"),
    readHealth: () => assert.fail("aborted action must not read"),
    onStatus: () => assert.fail("aborted action must not publish progress"),
  }), error => error.name === "AbortError");
});
