import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationManager } from "../server/operation-manager.mjs";

test("operation manager persists determinate progress and a completed result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-operations-"));
  try {
    const updates = [];
    const manager = new OperationManager({ root, onUpdate: (update) => updates.push(update) });
    await manager.initialize();
    const operation = await manager.start("audit", async ({ report }) => {
      await report({ stage: "分析样本", current: 2, total: 4 });
      await report({ stage: "整理结果" });
      return { analyzed: 4 };
    });
    const completed = await manager.wait(operation.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.percent, 100);
    assert.deepEqual(completed.result, { analyzed: 4 });
    assert.equal(Object.hasOwn(manager.list()[0], "result"), false);
    assert.deepEqual(manager.get(operation.id).result, { analyzed: 4 });
    const stageOnlyUpdate = updates.find((update) => update.stage === "整理结果");
    assert.equal(stageOnlyUpdate.current, 2);
    assert.equal(stageOnlyUpdate.total, 4);
    assert.equal(stageOnlyUpdate.percent, 50);
    const persisted = JSON.parse(await readFile(path.join(root, `${operation.id}.json`), "utf8"));
    assert.equal(persisted.status, "succeeded");
    assert.equal(Object.hasOwn(persisted, "controller"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation manager does not recreate interrupted records pruned by retention", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-operations-"));
  try {
    const records = Array.from({ length: 102 }, (_, index) => ({
      id: `op-test-${String(index).padStart(3, "0")}`,
      kind: "retention-test",
      label: "保留测试",
      status: "running",
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      startedAt: null,
      finishedAt: null,
      cancellable: true,
      result: { index },
      error: null,
    }));
    await Promise.all(records.map((record) => writeFile(
      path.join(root, `${record.id}.json`),
      `${JSON.stringify(record)}\n`,
      "utf8",
    )));

    const manager = new OperationManager({ root });
    await manager.initialize();

    const files = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
    assert.equal(files.length, 100);
    assert.equal(files.includes("op-test-000.json"), false);
    assert.equal(files.includes("op-test-001.json"), false);
    assert.equal(manager.list().length, 100);
    assert.ok(manager.list().every((record) => record.status === "interrupted"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation cancellation aborts the runner and reports cancelled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-operations-"));
  try {
    const manager = new OperationManager({ root });
    const operation = await manager.start("slow", ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    }));
    await manager.cancel(operation.id);
    const completed = await manager.wait(operation.id);
    assert.equal(completed.status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation manager serializes concurrent progress persistence without regressing terminal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-operations-"));
  try {
    const manager = new OperationManager({ root });
    await manager.initialize();
    const operation = await manager.start("stress", async ({ report }) => {
      await Promise.all(Array.from({ length: 40 }, (_, index) => report({
        stage: `批次 ${index + 1}`,
        current: index + 1,
        total: 40,
      })));
      return { analyzed: 40 };
    });
    const completed = await manager.wait(operation.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.percent, 100);
    const persisted = JSON.parse(await readFile(path.join(root, `${operation.id}.json`), "utf8"));
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.percent, 100);
    assert.deepEqual(persisted.result, { analyzed: 40 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
