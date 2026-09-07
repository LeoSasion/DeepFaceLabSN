import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mapPythonRuntime, probePythonRuntime } from "./python-runtime.mjs";

test("mapped venv preserves its own packages without PYTHONPATH and survives cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-python-layout-"));
  try {
    const source = process.env.DFLSN_TEST_PYTHON || (process.platform === "win32" ? "python.exe" : "python3");
    const venv = path.join(root, "venv with spaces");
    const created = spawnSync(source, ["-m", "venv", "--without-pip", venv], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const executable = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const runtime = probePythonRuntime(executable, { checkDependencies: false });
    const site = spawnSync(executable, ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr);
    const marker = path.join(site.stdout.trim(), "dfl_fixture_marker.py");
    await writeFile(marker, "VALUE = 'venv-only-package'\n");
    const internalRoot = path.join(root, "mapped internal");
    await mkdir(internalRoot);
    const mapped = await mapPythonRuntime(runtime, internalRoot);
    const result = spawnSync(mapped, ["-c", "import dfl_fixture_marker; print(dfl_fixture_marker.VALUE)"], {
      encoding: "utf8", env: { ...process.env, PYTHONHOME: "", PYTHONPATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "venv-only-package");
    assert.throws(() => probePythonRuntime(mapped), /webui\/tests\/requirements.txt/);
    await rm(internalRoot, { recursive: true, force: true });
    assert.match(await readFile(marker, "utf8"), /venv-only-package/);
    assert.equal(probePythonRuntime(executable, { checkDependencies: false }).prefix, runtime.prefix);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Python executable gives an actionable setup error", () => {
  assert.throws(() => probePythonRuntime(path.join(os.tmpdir(), "missing-dfl-python", "python.exe")),
    /DFLSN_TEST_PYTHON.*requirements.txt/s);
});
