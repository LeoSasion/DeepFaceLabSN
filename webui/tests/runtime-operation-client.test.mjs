import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runtimeApi, watchOperations } from "../src/runtime/api.js";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return status >= 200 && status < 300
        ? { ok: true, data }
        : { ok: false, error: data };
    },
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createScheduler() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cancelled = true;
    },
    async runNext() {
      let timer = scheduled.shift();
      while (timer?.cancelled) timer = scheduled.shift();
      if (!timer) return false;
      await timer.callback();
      return true;
    },
  };
}

test("runOperation is Node-safe, deduplicates progress, and retries transient polling failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let pollCount = 0;
  const requests = [];
  globalThis.fetch = async (pathname, options = {}) => {
    requests.push({ pathname, options });
    if (pathname === "/api/operations" && options.method === "POST") {
      return jsonResponse({ id: "op-client", status: "queued", current: null, total: null });
    }
    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({ id: "op-client", status: "queued", current: null, total: null });
    }
    if (pollCount === 2) throw new TypeError("temporary connection loss");
    if (pollCount === 3) {
      return jsonResponse({ id: "op-client", status: "running", current: 1, total: 2 });
    }
    return jsonResponse({
      id: "op-client",
      status: "succeeded",
      current: 2,
      total: 2,
      result: { analyzed: 2 },
    });
  };

  const progress = [];
  const result = await runtimeApi.runOperation("asset-audit", "src", {}, {
    pollIntervalMs: 1,
    maxPollIntervalMs: 1,
    onProgress(operation) {
      progress.push(operation.status);
      if (operation.status === "queued") throw new Error("presentation failed");
    },
  });

  assert.deepEqual(result, { analyzed: 2 });
  assert.deepEqual(progress, ["queued", "running", "succeeded"]);
  assert.equal(pollCount, 4);
  assert.equal(requests.every(({ options }) => options.signal === undefined || options.signal instanceof AbortSignal), true);
});

test("aborting runOperation stops local polling without issuing a cancel request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const controller = new AbortController();
  const requests = [];
  globalThis.fetch = async (pathname, options = {}) => {
    requests.push({ pathname, options });
    return jsonResponse({ id: "op-abort", status: "queued" });
  };

  await assert.rejects(
    runtimeApi.runOperation("pose-atlas", "dst", {}, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(requests.map(({ pathname }) => pathname), ["/api/operations"]);
});

test("watchOperations backs off, reports an outage once, and suppresses unchanged snapshots", async () => {
  const scheduler = createScheduler();
  const active = [{ id: "op-watch", status: "running", current: 1, total: 2 }];
  const results = [
    new Error("offline"),
    new Error("offline"),
    active,
    active.map((operation) => ({ ...operation })),
    [],
    new Error("offline again"),
  ];
  const updates = [];
  const errors = [];
  let fetchCount = 0;
  const dispose = watchOperations({
    fetchOperations: async () => {
      const result = results[fetchCount];
      fetchCount += 1;
      if (result instanceof Error) throw result;
      return result;
    },
    onUpdate: (records) => updates.push(records),
    onError: (error) => {
      errors.push(error.message);
      if (errors.length === 1) throw new Error("toast failed");
    },
    pollIntervalMs: 100,
    maxPollIntervalMs: 800,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await settle();
  assert.deepEqual(errors, ["offline"]);
  assert.equal(scheduler.scheduled.at(-1).delay, 100);

  await scheduler.runNext();
  assert.deepEqual(errors, ["offline"]);
  assert.equal(scheduler.scheduled.at(-1).delay, 200);

  await scheduler.runNext();
  assert.equal(updates.length, 1);
  assert.equal(scheduler.scheduled.at(-1).delay, 100);

  await scheduler.runNext();
  assert.equal(updates.length, 1);

  await scheduler.runNext();
  assert.deepEqual(updates.at(-1), []);
  assert.equal(updates.length, 2);

  await scheduler.runNext();
  assert.deepEqual(errors, ["offline", "offline again"]);
  dispose();
  const fetchesBeforeDispose = fetchCount;
  assert.equal(await scheduler.runNext(), false);
  assert.equal(fetchCount, fetchesBeforeDispose);
});

test("BackgroundOperations delegates polling and only offers cancel for cancellable work", async () => {
  const source = await readFile(
    new URL("../src/components/BackgroundOperations.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /runtimeApi\.watchOperations\(/);
  assert.match(source, /operation\.cancellable\s*&&\s*\["queued",\s*"running"\]/);
  assert.doesNotMatch(source, /window\.(?:setTimeout|clearTimeout)/);
});

test("operation-backed pages keep context loaders inline so each operation owns one HUD card", async () => {
  const [toolPanels, advancedPanels, toolLab, background] = await Promise.all([
    readFile(new URL("../src/components/ToolWorkbenchPanels.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AdvancedWorkbenchPanels.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ToolLabView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/BackgroundOperations.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(toolPanels, /function LoadingState[\s\S]*?<LoadingProgress inline className="in-panel"/);
  assert.match(advancedPanels, /function PanelState[\s\S]*?<LoadingProgress inline className="in-panel"/);
  assert.match(advancedPanels, /inline=\{busy === "detect"\}/);
  assert.equal((toolLab.match(/<LoadingProgress\s+inline/g) ?? []).length, 2);
  assert.match(background, /operationKey=\{operation\.id\}/);
  assert.doesNotMatch(background, /<LoadingProgress\s+inline/);
});
