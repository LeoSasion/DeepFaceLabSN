import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace recovery UI lists sanitized archive metadata and refreshes after restore", async () => {
  const source = await readFile(new URL("../src/components/WorkspaceView.jsx", import.meta.url), "utf8");
  assert.match(source, /runtimeApi\.materialArchives\(side\)/);
  assert.match(source, /runtimeApi\.restoreMaterialArchive\(side, archive\.token\)/);
  assert.match(source, /archive\.archivedAt/);
  assert.match(source, /archiveFormat\(archive\).*formatBytes\(archive\.bytes\)/s);
  assert.match(source, /window\.confirm/);
  assert.match(source, /Promise\.all\(\[refresh\(\), refreshArchives\(side\)\]\)/);
  assert.doesNotMatch(source, /archive\.(?:path|directory|archivedPath)/);
  assert.doesNotMatch(source, /material\.path/);
});

test("workspace storage stays compact and exposes the five-gigabyte safety reserve", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/components/WorkspaceView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /storage\?\.freeBytes/);
  assert.match(source, /storage\?\.reserveBytes/);
  assert.match(source, /storage\?\.usableBytes/);
  assert.match(source, /workspace-storage-strip.*is-warning/s);
  assert.match(styles, /\.workspace-storage-strip\s*\{[\s\S]*?min-height:\s*36px;/);
});

test("settings exports a privacy-bounded diagnostic JSON with version and sample time", async () => {
  const source = await readFile(new URL("../src/components/OperationsView.jsx", import.meta.url), "utf8");
  assert.match(source, /const snapshot = await runtimeApi\.diagnostics\(\)/);
  assert.match(source, /new Blob\(\[.*JSON\.stringify\(snapshot, null, 2\)/s);
  assert.match(source, /link\.download = `deepfacelabsn-diagnostics-/);
  assert.match(source, /snapshot\.product\?\.version/);
  assert.match(source, /snapshot\.generatedAt/);
  assert.match(source, /不含绝对路径、命令参数或终端内容/);
});
