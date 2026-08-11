import assert from "node:assert/strict";
import test from "node:test";
import {
  createProgressStore,
  deriveProgressValue,
  selectVisibleProgressTasks,
} from "../src/progress-store.js";

function createClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();

  const clock = {
    now: () => current,
    schedule(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, at: current + delay });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(duration) {
      const target = current + duration;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        current = timer.at;
        timer.callback();
      }
      current = target;
    },
  };
  return clock;
}

test("deriveProgressValue prefers real values and derives counts", () => {
  assert.equal(deriveProgressValue(42.4, 1, 2), 42.4);
  assert.equal(deriveProgressValue(undefined, 61, 90), (61 / 90) * 100);
  assert.equal(deriveProgressValue(null, null, null), null);
  assert.equal(deriveProgressValue("", null, null), null);
  assert.equal(deriveProgressValue(undefined, 1, 0), null);
  assert.equal(deriveProgressValue(140, 1, 2), 100);
  assert.equal(deriveProgressValue(-4, 1, 2), 0);
});

test("fast operations finish before the HUD appears", () => {
  const clock = createClock();
  const store = createProgressStore({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    showDelayMs: 240,
  });

  store.register("fast", { label: "fast" });
  clock.advance(200);
  store.unregister("fast");
  clock.advance(1000);
  assert.deepEqual(store.getSnapshot(), []);
});

test("visible operations remain long enough to avoid a flash", () => {
  const clock = createClock();
  const store = createProgressStore({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    showDelayMs: 0,
    minVisibleMs: 520,
    exitMs: 160,
  });

  store.register("steady", { label: "steady" });
  clock.advance(0);
  assert.equal(store.getSnapshot().length, 1);

  store.unregister("steady");
  clock.advance(519);
  assert.equal(store.getSnapshot().length, 1);
  clock.advance(1);
  assert.equal(store.getSnapshot()[0].phase, "leaving");
  clock.advance(160);
  assert.deepEqual(store.getSnapshot(), []);
});

test("a remounted contributor cancels a pending removal", () => {
  const clock = createClock();
  const store = createProgressStore({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    showDelayMs: 0,
    minVisibleMs: 520,
    exitMs: 160,
  });

  store.register("strict", { label: "first" });
  clock.advance(0);
  store.unregister("strict");
  clock.advance(100);
  store.register("strict", { label: "second" });
  clock.advance(1000);
  assert.equal(store.getSnapshot().length, 1);
  assert.equal(store.getSnapshot()[0].label, "second");
});

test("visible selection deduplicates stable operation keys and caps the stack", () => {
  const entries = [
    { id: "a", operationKey: "job:1", createdAt: 1, updatedAt: 1, phase: "active" },
    { id: "b", operationKey: "job:1", createdAt: 2, updatedAt: 3, phase: "active" },
    { id: "c", operationKey: "job:2", createdAt: 3, updatedAt: 3, phase: "active" },
    { id: "d", operationKey: "job:3", createdAt: 4, updatedAt: 4, phase: "active" },
    { id: "e", operationKey: "job:4", createdAt: 5, updatedAt: 5, phase: "active" },
  ];

  const result = selectVisibleProgressTasks(entries, 3);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["c", "d", "e"]);
  assert.equal(result.overflow, 1);
});

test("visible selection keeps an active duplicate ahead of a newer leaving entry", () => {
  const result = selectVisibleProgressTasks([
    { id: "active", operationKey: "job:1", phase: "active", createdAt: 1, updatedAt: 10 },
    { id: "leaving", operationKey: "job:1", phase: "leaving", createdAt: 2, updatedAt: 20 },
  ]);

  assert.deepEqual(result.tasks.map((entry) => entry.id), ["active"]);
});
