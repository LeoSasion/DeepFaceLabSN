import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const webuiRoot = path.resolve(testsRoot, "..");
const repositoryRoot = path.resolve(webuiRoot, "..");

test("portable Node bootstrap keeps its pinned release contract synchronized", async () => {
  const [launcher, installer, packageJson, offlineReadme] = await Promise.all([
    readFile(path.join(repositoryRoot, "启动 WebUI.bat"), "utf8"),
    readFile(path.join(webuiRoot, "scripts", "install-node.ps1"), "utf8"),
    readFile(path.join(webuiRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "_internal", "installers", "README.md"), "utf8"),
  ]);

  const version = installer.match(/\$NodeVersion = "([^"]+)"/)?.[1];
  const checksum = installer.match(/\$ArchiveSha256 = "([a-f0-9]{64})"/)?.[1];

  assert.equal(version, "24.19.0");
  assert.equal(checksum, "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73");
  assert.match(launcher, new RegExp(`set "NODE_REQUIRED_VERSION=${version.replaceAll(".", "\\.")}"`));
  assert.match(launcher, /process\.platform === 'win32' && process\.arch === 'x64'/);
  assert.match(launcher, /powershell\.exe .* -File "%NODE_INSTALLER%"/);
  assert.match(installer, /Get-FileHash -LiteralPath \$archiveToUse -Algorithm SHA256/);
  assert.match(installer, /Invoke-WebRequest -Uri \$DownloadUrl/);
  assert.match(offlineReadme, new RegExp(`node-v${version.replaceAll(".", "\\.")}-win-x64\\.zip`));
  assert.match(offlineReadme, new RegExp(checksum));
  assert.equal(packageJson.engines.node, ">=24 <25");
  assert.equal(packageJson.packageManager, "pnpm@11.19.0");
});

test("Windows PowerShell bootstrap retains a UTF-8 BOM for bilingual messages", async () => {
  const installer = await readFile(path.join(webuiRoot, "scripts", "install-node.ps1"), "utf8");
  assert.equal(installer.charCodeAt(0), 0xfeff);
});
