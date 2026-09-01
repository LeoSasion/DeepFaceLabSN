import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceWebuiRoot = path.resolve(testsRoot, "..");
const sourceRepositoryRoot = path.resolve(sourceWebuiRoot, "..");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function fail(message, result) {
  const details = [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim();
  throw new Error(details ? `${message}\n${details}` : message);
}

function discoverPythonExecutable() {
  const bundled = path.join(sourceRepositoryRoot, "_internal", "python_common");
  if (process.platform === "win32" && path.isAbsolute(bundled)) {
    const probe = spawnSync(path.join(bundled, "python.exe"), [
      "-c",
      "import sys;print(sys.executable)",
    ], { encoding: "utf8", timeout: 30_000 });
    if (probe.status === 0 && probe.stdout.trim()) return path.resolve(probe.stdout.trim());
  }

  const explicit = process.env.DFLSN_TEST_PYTHON;
  const executable = explicit || (process.platform === "win32" ? "python.exe" : "python3");
  const probe = spawnSync(executable, [
    "-c",
    "import sys;print(sys.executable)",
  ], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    fail(
      "A Python runtime with numpy and opencv-python is required for isolated DFL fixtures. "
        + "Set DFLSN_TEST_PYTHON to its executable when it is not on PATH.",
      probe,
    );
  }
  return path.resolve(probe.stdout.trim());
}

async function mapPythonRuntime(pythonExecutable, internalRoot) {
  const pythonCommon = path.join(internalRoot, "python_common");
  if (process.platform === "win32") {
    await createJunction(path.dirname(pythonExecutable), pythonCommon);
    return;
  }

  // Product paths intentionally point at python_common/python.exe on every
  // platform. Keep that layout in the hermetic repository while using the
  // exact interpreter discovered from sys.executable to build the fixture.
  await mkdir(pythonCommon, { recursive: true });
  await symlink(pythonExecutable, path.join(pythonCommon, "python.exe"), "file");
}

async function copyWebui(source, destination) {
  const excluded = new Set(["node_modules", "dist", ".runtime", "__pycache__"]);
  await cp(source, destination, {
    recursive: true,
    filter(candidate) {
      if (candidate === source) return true;
      return !excluded.has(path.basename(candidate));
    },
  });
}

async function createJunction(target, link) {
  if (!(await exists(target))) throw new Error(`Required test dependency is missing: ${target}`);
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(path.resolve(target), link, process.platform === "win32" ? "junction" : "dir");
}

async function prepareRepository(testRoot) {
  const repositoryRoot = path.join(testRoot, "repo");
  const webuiRoot = path.join(repositoryRoot, "webui");
  const internalRoot = path.join(repositoryRoot, "_internal");
  await mkdir(internalRoot, { recursive: true });
  await copyWebui(sourceWebuiRoot, webuiRoot);
  const pythonExecutable = discoverPythonExecutable();

  await Promise.all([
    cp(
      path.join(sourceRepositoryRoot, "启动 WebUI.bat"),
      path.join(repositoryRoot, "启动 WebUI.bat"),
    ),
    cp(
      path.join(sourceRepositoryRoot, "release"),
      path.join(repositoryRoot, "release"),
      { recursive: true },
    ),
    createJunction(
      path.join(sourceWebuiRoot, "node_modules"),
      path.join(webuiRoot, "node_modules"),
    ),
    createJunction(
      path.join(sourceRepositoryRoot, "_internal", "DeepFaceLab"),
      path.join(internalRoot, "DeepFaceLab"),
    ),
    createJunction(
      path.join(sourceRepositoryRoot, "_internal", "DeepFaceLab_old"),
      path.join(internalRoot, "DeepFaceLab_old"),
    ),
    createJunction(
      path.join(sourceRepositoryRoot, "_internal", "installers"),
      path.join(internalRoot, "installers"),
    ),
    mapPythonRuntime(pythonExecutable, internalRoot),
  ]);
  await Promise.all([
    mkdir(path.join(internalRoot, "_e", "t"), { recursive: true }),
    mkdir(path.join(internalRoot, "_e", "u", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(internalRoot, "_e", "u", "AppData", "Roaming"), { recursive: true }),
  ]);
  return { repositoryRoot, webuiRoot, internalRoot, pythonExecutable };
}

async function generateFixture(layout) {
  const fixtureScript = path.join(layout.webuiRoot, "tests", "create-dfl-fixture.py");
  const workspace = path.join(layout.repositoryRoot, "workspace");
  const result = spawnSync(layout.pythonExecutable, [
    fixtureScript,
    "--workspace",
    workspace,
    "--fixture-root",
    layout.repositoryRoot,
    "--dfl-root",
    path.join(layout.internalRoot, "DeepFaceLab"),
  ], {
    cwd: layout.repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (result.status !== 0) fail("Failed to create the isolated DFL fixture.", result);
}

async function listUnitTests(webuiRoot) {
  const entries = await readdir(path.join(webuiRoot, "tests"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .filter((entry) => entry.name !== "sites-worker.test.mjs")
    .map((entry) => path.join("tests", entry.name))
    .sort();
}

const testRoot = await mkdtemp(path.join(os.tmpdir(), "dflsn-webui-tests-"));
try {
  const layout = await prepareRepository(testRoot);
  await generateFixture(layout);
  const tests = await listUnitTests(layout.webuiRoot);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests,
  ], {
    cwd: layout.webuiRoot,
    stdio: "inherit",
    env: { ...process.env, DFLSN_ISOLATED_TEST_ROOT: testRoot },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
