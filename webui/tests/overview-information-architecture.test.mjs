import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("overview keeps terminal sessions as the only task log queue", async () => {
  const source = await readFile(new URL("../src/components/TrainingView.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /查看全部命令日志/);
  assert.doesNotMatch(source, /任务队列（/);
  assert.doesNotMatch(source, /queue-row/);
});

test("training summary metrics live in the status panel instead of the preview workspace", async () => {
  const source = await readFile(new URL("../src/components/TrainingView.jsx", import.meta.url), "utf8");
  const workspaceSource = source.slice(
    source.indexOf("export function TrainingWorkspace"),
    source.indexOf("function MetricRow"),
  );
  const statusSource = source.slice(
    source.indexOf("export function StatusPanel"),
    source.indexOf("export function WorkbenchGrid"),
  );
  assert.doesNotMatch(source, /className="training-stats"/);
  assert.doesNotMatch(workspaceSource, /<TrainingChart/);
  assert.match(statusSource, /<TrainingChart/);
  assert.match(source, /label=\{t\("单次迭代"\)\}/);
  assert.match(source, /label=\{t\("SRC 损失"\)\}/);
  assert.match(source, /label=\{t\("DST 损失"\)\}/);
});
