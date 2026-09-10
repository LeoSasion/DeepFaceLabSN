import assert from "node:assert/strict";
import test from "node:test";
import { jobPresentation, mergeMetricHistory } from "../src/domain/job-presentation.js";
import { selectTrainingJob, resolveSavedTrainingModel, getSavedTrainingModelState } from "../src/domain/training-context.js";
import { createTrainingHistoryReader } from "../src/runtime/training-history-reader.js";

function clock() {
  const queue = [];
  return {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      queue.push(timer);
      return timer;
    },
    cancelSchedule(timer) { if (timer) timer.cancelled = true; },
    next() { return queue.find(timer => !timer.cancelled); },
    async tick() {
      const timer = this.next();
      assert.ok(timer, "expected a scheduled retry");
      timer.cancelled = true;
      await timer.callback();
    },
  };
}

const metric = (sequence, iteration, srcLoss = .4, dstLoss = .6) => ({
  sequence, type: "job.metric", payload: { iteration, srcLoss, dstLoss },
});

test("forced and timed-out stops never claim successful safe saving", () => {
  assert.deepEqual(jobPresentation({ state: "cancelled", stopReason: "safe-stop-timeout" }), {
    label: "停止超时，保存未确认", tone: "amber",
  });
  assert.deepEqual(jobPresentation({ state: "cancelled", stopReason: "force-kill" }), {
    label: "已强制停止", tone: "amber",
  });
  assert.equal(jobPresentation({ state: "cancelled", stopReason: "safe-stop-unknown" }).label, "已停止");
  assert.equal(jobPresentation({ state: "stopping", stopReason: "force-kill" }).label, "正在停止");
  assert.equal(jobPresentation({ state: "stopping", stopReason: "safe-stop" }).label, "保存并停止中");
});

test("training controls follow the live trainer while stopped histories remain selectable", () => {
  const old = { id: "old", commandId: "train.saehd", state: "cancelled" };
  const queued = { id: "queued", commandId: "train.saehd", state: "queued" };
  const live = { id: "live", commandId: "train.saehd", state: "stopping" };
  const encode = { id: "encode", commandId: "encode.mp4", state: "running" };
  assert.equal(selectTrainingJob([encode, queued, live, old], old), live);
  assert.equal(selectTrainingJob([encode, queued, old], old), queued);
  assert.equal(selectTrainingJob([encode, { ...live, state: "succeeded" }, old], old), old);
  assert.equal(selectTrainingJob([encode], old), null);
});

test("resume never substitutes an unrelated checkpoint for a missing named model", () => {
  const first = { name: "first", type: "SAEHD" };
  const second = { name: "second", type: "SAEHD" };
  const quick = { name: "first", type: "Q96" };
  assert.equal(resolveSavedTrainingModel([first, second], { parameters: { forceModelName: "first" } }), first);
  assert.equal(resolveSavedTrainingModel([second], { parameters: { forceModelName: "first" } }), null);
  assert.equal(resolveSavedTrainingModel([first, second]), null);
  assert.equal(resolveSavedTrainingModel([first, quick]), first);
  assert.equal(resolveSavedTrainingModel([quick]), null);
  assert.equal(getSavedTrainingModelState([first]), "available");
  assert.equal(getSavedTrainingModelState([first, second]), "ambiguous");
  assert.equal(getSavedTrainingModelState([second], { parameters: { forceModelName: "first" } }), "missing");
  assert.equal(getSavedTrainingModelState([quick]), "empty");
});

test("completed history retries a temporary outage and retains the loaded metric tail", async () => {
  const timer = clock();
  const changes = [];
  const cursors = [];
  const initial = mergeMetricHistory([], [metric(1, 10)]);
  const reader = createTrainingHistoryReader({
    ...timer, points: initial,
    onChange: value => changes.push(value),
    readEvents: async cursor => {
      cursors.push(cursor);
      if (cursors.length === 1) throw Object.assign(new Error("offline"), { retryable: true });
      return [metric(8, 11), { sequence: 9, type: "terminal.output" }];
    },
  });
  await reader.refresh();
  assert.deepEqual(changes[0], { points: initial, error: "offline" });
  assert.equal(timer.next().delay, 4000);
  await timer.tick();
  assert.equal(timer.next(), undefined, "completed history stops polling once recovered");
  assert.deepEqual(changes.at(-1).points.map(point => point.iteration), [10, 11]);
  assert.equal(changes.at(-1).error, null);
  await reader.refresh();
  assert.deepEqual(cursors, [0, 0, 9]);
  reader.dispose();
});

test("history recovery backs off without overlapping requests and cancels stale updates", async () => {
  const timer = clock();
  let calls = 0;
  let resolveRead;
  const changes = [];
  const reader = createTrainingHistoryReader({
    ...timer, active: true,
    onChange: value => changes.push(value),
    readEvents: () => { calls += 1; return new Promise(resolve => { resolveRead = resolve; }); },
  });
  const pending = reader.refresh();
  await reader.refresh();
  assert.equal(calls, 1);
  reader.dispose();
  resolveRead([metric(1, 1)]);
  await pending;
  assert.deepEqual(changes, []);
  assert.equal(timer.next(), undefined);

  const backoff = createTrainingHistoryReader({
    ...timer, onChange() {},
    readEvents: async () => { throw new Error("temporarily unavailable"); },
  });
  await backoff.refresh();
  for (const delay of [4000, 8000, 16000, 30000, 30000]) {
    assert.equal(timer.next().delay, delay);
    await timer.tick();
  }
  backoff.dispose();
  assert.equal(timer.next(), undefined);
});

test("archived history does not retry indefinitely and malformed loss points stay off the chart", async () => {
  const timer = clock();
  const reader = createTrainingHistoryReader({
    ...timer, active: true, onChange() {},
    readEvents: async () => { throw Object.assign(new Error("archived"), { status: 404 }); },
  });
  await reader.refresh();
  assert.equal(timer.next(), undefined);
  reader.dispose();
  assert.deepEqual(mergeMetricHistory([{ iteration: 1, gLoss: Infinity, dLoss: .2 }], [
    metric(1, -1), metric(2, 1.5), metric(3, 2, -.4), metric(4, 3, 0, 0),
  ]), [{ iteration: 3, gLoss: 0, dLoss: 0 }]);
});
