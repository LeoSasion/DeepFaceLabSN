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
import { mapPythonRuntime, probePythonRuntime } from "./python-runtime.mjs";

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

async function discoverPythonRuntime() {
  // An explicit test interpreter must override a bundled production runtime.
  const explicit = process.env.DFLSN_TEST_PYTHON;
  if (explicit) return probePythonRuntime(explicit);
  const bundled = path.join(sourceRepositoryRoot, "_internal", "python_common");
  if (process.platform === "win32" && await exists(path.join(bundled, "python.exe"))) {
    return probePythonRuntime(path.join(bundled, "python.exe"));
  }
  return probePythonRuntime(process.platform === "win32" ? "python.exe" : "python3");
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
  const pythonRuntime = await discoverPythonRuntime();

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
    mapPythonRuntime(pythonRuntime, internalRoot),
  ]);
  const pythonExecutable = path.join(internalRoot, "python_common", "python.exe");
  // Validate the actual child-process layout before creating fixtures or jobs.
  probePythonRuntime(pythonExecutable);
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
    env: {
      ...process.env,
      DFLSN_TEST_PYTHON: layout.pythonExecutable,
      DFLSN_ISOLATED_TEST_ROOT: testRoot,
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
