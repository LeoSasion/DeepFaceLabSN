import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("1366x768 desktop layout keeps the collapsed terminal in the first viewport", async () => {
  const [chromeSource, styles] = await Promise.all([
    readFile(new URL("../src/components/Chrome.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  const readNumericConstant = (name) => {
    const match = chromeSource.match(new RegExp(`const ${name} = ([\\d.]+);`));
    assert.ok(match, `${name} must remain explicit so the desktop fit can be audited`);
    return Number(match[1]);
  };
  const minimumScale = readNumericConstant("MINIMUM_DESKTOP_SCALE");
  const maximumScale = readNumericConstant("MAXIMUM_DESKTOP_SCALE");
  const designWidth = readNumericConstant("DESKTOP_DESIGN_WIDTH");
  const designHeight = readNumericConstant("DESKTOP_DESIGN_HEIGHT");
  const viewport = { width: 1366, height: 768 };
  const scale = Math.max(
    minimumScale,
    Math.min(maximumScale, viewport.width / designWidth, viewport.height / designHeight),
  );

  assert.equal(minimumScale, 1, "desktop text must not shrink below its authored size");
  assert.equal(scale, 1, "the 16:9 desktop should fit through layout, not global downscaling");
  assert.match(
    styles,
    /\.main-surface:has\(\.runtime-console\.is-collapsed\)\s*\{\s*grid-template-rows:\s*72px 68px minmax\(0, 1fr\) 58px;/s,
  );
  assert.match(
    styles,
    /\.main-surface\.is-tools:has\(\.runtime-console\.is-collapsed\)\s*\{\s*grid-template-rows:\s*72px minmax\(0, 1fr\) 58px;/s,
  );
  assert.doesNotMatch(styles, /runtime-console\.is-collapsed[\s\S]{0,180}minmax\(626px, 1fr\)/);

  const virtualShellHeight = viewport.height - 42;
  const collapsedOverviewChrome = 72 + 68 + 58 + (3 * 8) + 8;
  assert.ok(
    virtualShellHeight - collapsedOverviewChrome > 0,
    "the content row must retain space without displacing the reserved 58px terminal row",
  );
});

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

test("training preview only renders real Trainer output while training is active", async () => {
  const source = await readFile(new URL("../src/components/TrainingView.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    source,
    /previewEligibleStates = new Set\(\["starting", "running", "waiting_input", "stopping"\]\)/,
  );
  assert.match(source, /const showPreview = trainingHasStarted && Boolean\(previewUrl\)/);
  assert.match(source, /data-preview-state=\{trainingHasStarted \? "waiting" : "inactive"\}/);
  assert.match(source, /t\("当前没有运行中的训练"\)/);
  assert.match(source, /t\("正在等待首张训练预览"\)/);
  assert.match(
    styles,
    /\.training-preview-stage \.preview-empty\s*\{[^}]*height:\s*100%;[^}]*aspect-ratio:\s*auto;/s,
  );
});

test("pipeline status derives failures from each command's latest run", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const pipelineSource = source.slice(
    source.indexOf("const commandIds = pipelineCommandMap"),
    source.indexOf("const workflowStates = useMemo"),
  );

  assert.match(pipelineSource, /const latestJobs = commandIds/);
  assert.match(pipelineSource, /const failedJob = latestJobs\.find/);
  assert.doesNotMatch(pipelineSource, /const failedJob = matchingJobs\.find/);
});

test("tool lab primary navigation has English labels", async () => {
  const translations = await readFile(new URL("../src/i18n.jsx", import.meta.url), "utf8");
  for (const key of [
    "工具实验室视图",
    "数据审计",
    "提取复核",
    "合成复核",
    "视频时间线",
    "元数据与打包",
    "姿态图谱",
    "覆盖清单",
  ]) {
    assert.ok(translations.includes(`"${key}":`), `missing English translation for ${key}`);
  }
});
