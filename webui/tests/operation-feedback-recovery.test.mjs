import assert from "node:assert/strict";
import test from "node:test";
import { runtimeApi, watchOperations } from "../src/runtime/api.js";
import { cancelOperationAndCheck } from "../src/runtime/operation-cancellation.js";
import { withRequestDeadline } from "../src/runtime/request-deadline.js";

const settle = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
const running = { id: "op-recovery", status: "running", current: 3, total: 10, percent: 30 };
function scheduler() {
  const queue = [];
  return {
    setTimer(callback) { const item = { callback }; queue.push(item); return item; },
    clearTimer(item) { item.cancelled = true; },
    async tick() { let item; do { item = queue.shift(); } while (item?.cancelled); if (item) await item.callback(); },
  };
}

test("a response body that never arrives is bounded and the transport is aborted", async () => {
  let signal;
  await assert.rejects(withRequestDeadline(activeSignal => {
    signal = activeSignal;
    return new Promise(() => {});
  }, { timeoutMs: 15 }), error => error.code === "RUNTIME_REQUEST_TIMEOUT" && error.retryable);
  assert.equal(signal.aborted, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withRequestDeadline(() => assert.fail("already aborted"), { signal: controller.signal }), error => error.name === "AbortError");
});

test("an uncertain operation submission is never automatically submitted twice", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let writes = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    writes += 1;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  };
  await assert.rejects(runtimeApi.runOperation("pose-atlas", "src", {}, { requestTimeoutMs: 15 }),
    error => error.code === "OPERATION_START_UNCONFIRMED");
  assert.equal(writes, 1);
});

test("a stalled result read retries the original operation without starting or cancelling work", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let writes = 0;
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === "POST") { writes += 1; return response(running); }
    assert.equal(url, "/api/operations/op-recovery");
    if (++reads === 1) return new Promise(() => {});
    return response({ ...running, status: "succeeded", result: { analyzed: 10 } });
  };
  const result = await runtimeApi.runOperation("pose-atlas", "src", {}, {
    requestTimeoutMs: 15, pollIntervalMs: 100, maxPollIntervalMs: 100,
  });
  assert.deepEqual(result, { analyzed: 10 });
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test("exhausted result checks keep the operation ID and report unknown rather than failed", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, options) => options.method === "POST" ? response(running) : new Promise(() => {});
  await assert.rejects(runtimeApi.runOperation("pose-atlas", "src", {}, {
    requestTimeoutMs: 15, pollIntervalMs: 100, maxConsecutiveErrors: 0,
  }), error => error.code === "OPERATION_OBSERVATION_LOST" && error.operation.id === running.id);
});

test("an interrupted result view resumes the same operation using only reads", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/operations/op-recovery");
    assert.notEqual(options.method, "POST");
    return response(++reads === 1 ? running : { ...running, status: "succeeded", result: { groups: ["original"] } });
  };
  const result = await runtimeApi.resumeOperation(running.id, { pollIntervalMs: 100 });
  assert.deepEqual(result, { groups: ["original"] });
  assert.equal(reads, 2);
});

test("monitor recovery is reported even when the operation progress has not changed", async () => {
  const clock = scheduler();
  const updates = [];
  const connections = [];
  let mode = "online";
  const dispose = watchOperations({
    ...clock, fetchOperations: async () => { if (mode === "offline") throw new Error("offline"); return [running]; },
    onUpdate: records => updates.push(records), onConnectionChange: state => connections.push(state),
  });
  await settle();
  mode = "offline"; await clock.tick();
  assert.equal(updates.length, 1, "last known progress is preserved");
  mode = "online"; await clock.tick();
  assert.equal(updates.length, 1, "identical progress stays deduplicated");
  assert.deepEqual(connections, ["online", "reconnecting", "online"]);
  dispose();
});

test("manual progress checks share one pending read and a timeout resumes monitoring", async () => {
  const clock = scheduler();
  let count = 0;
  let firstSignal;
  const errors = [];
  const updates = [];
  const dispose = watchOperations({
    ...clock, requestTimeoutMs: 15,
    fetchOperations: ({ signal }) => {
      if (++count === 1) { firstSignal = signal; return new Promise(() => {}); }
      return Promise.resolve([running]);
    },
    onError: error => errors.push(error.code), onUpdate: records => updates.push(records),
  });
  const pending = dispose.refresh();
  assert.equal(dispose.refresh(), pending);
  await pending;
  assert.equal(count, 1);
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(errors, ["RUNTIME_REQUEST_TIMEOUT"]);
  await dispose.refresh();
  assert.deepEqual(updates, [[running]]);
  dispose();
});

test("only observed work produces one terminal outcome, including after an outage", async () => {
  const clock = scheduler();
  let records = [{ id: "op-old", status: "failed" }, running];
  const outcomes = [];
  const dispose = watchOperations({ ...clock,
    fetchOperations: async () => { if (records instanceof Error) throw records; return records; },
    onSettled: record => outcomes.push(record),
  });
  await settle();
  assert.deepEqual(outcomes, [], "old history does not generate new notifications");
  records = new Error("offline"); await clock.tick();
  records = [{ ...running, status: "interrupted", error: { message: "service restarted" } }];
  await clock.tick(); await clock.tick();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "interrupted");
  dispose();
});

test("malformed lists preserve progress and a missing record is never reported as completed", async () => {
  const clock = scheduler();
  let records = [running];
  const updates = [];
  const outcomes = [];
  const dispose = watchOperations({ ...clock, fetchOperations: async () => records,
    onUpdate: value => updates.push(value), onSettled: value => outcomes.push(value),
  });
  await settle();
  records = [null]; await clock.tick();
  assert.equal(updates.length, 1);
  assert.equal(outcomes.length, 0);
  records = []; await clock.tick();
  assert.equal(outcomes[0].status, "unknown");
  dispose();
});

test("disposing a monitor ignores late results and never schedules another read", async () => {
  const clock = scheduler();
  let finish;
  const dispose = watchOperations({ ...clock,
    fetchOperations: () => new Promise(resolve => { finish = resolve; }),
    onUpdate: () => assert.fail("unmounted monitor updated"),
    onConnectionChange: () => assert.fail("unmounted monitor changed state"),
  });
  await settle();
  const pending = dispose.refresh();
  dispose();
  await pending;
  finish([running]); await settle(); await clock.tick();
});

test("a lost cancellation response is verified by reading once, without another cancel", async () => {
  let writes = 0;
  let reads = 0;
  const result = await cancelOperationAndCheck(running.id, {
    cancel: async () => { writes += 1; throw new TypeError("response lost"); },
    read: async () => { reads += 1; return { ...running, status: "cancelling" }; },
  });
  assert.equal(result.status, "cancelling");
  assert.equal(writes, 1); assert.equal(reads, 1);
});

test("a stalled cancellation ends in an actionable unknown state when work is still running", async () => {
  let writes = 0;
  await assert.rejects(cancelOperationAndCheck(running.id, {
    cancel: () => { writes += 1; return new Promise(() => {}); },
    read: async () => running, timeoutMs: 15,
  }), error => error.code === "OPERATION_CANCEL_UNCONFIRMED" && error.message.includes("仍在运行"));
  assert.equal(writes, 1);
});

test("cancellation keeps genuine terminal outcomes and does not retry a rejected request", async () => {
  const result = await cancelOperationAndCheck(running.id, {
    cancel: async () => ({ ...running, status: "succeeded" }), read: () => assert.fail("unnecessary read"),
  });
  assert.equal(result.status, "succeeded", "finishing before cancellation is not a cancelled result");
  await assert.rejects(cancelOperationAndCheck(running.id, {
    cancel: async () => { throw Object.assign(new Error("rejected"), { status: 403 }); },
    read: () => assert.fail("a rejected write does not need an uncertainty check"),
  }), error => error.status === 403);
});
