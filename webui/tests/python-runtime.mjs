import { spawnSync } from "node:child_process";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";

const fixtureImports = "import numpy, cv2, PIL, scipy, numexpr, colorama, tqdm";

export function probePythonRuntime(executable, { checkDependencies = true } = {}) {
  const result = spawnSync(executable, ["-c", [
    "import json, sys",
    ...(checkDependencies ? [fixtureImports] : []),
    "print(json.dumps(dict(executable=sys.executable, prefix=sys.prefix, basePrefix=sys.base_prefix)))",
  ].join("\n")], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Test Python could not start or import fixture dependencies: ${executable}\n`
      + "Set DFLSN_TEST_PYTHON to a working interpreter and install webui/tests/requirements.txt with that interpreter.\n"
      + details,
    );
  }
  return JSON.parse(result.stdout.trim());
}

export async function mapPythonRuntime(runtime, internalRoot) {
  const pythonCommon = path.join(internalRoot, "python_common");
  const mappedExecutable = path.join(pythonCommon, "python.exe");
  const isVenv = path.resolve(runtime.prefix) !== path.resolve(runtime.basePrefix);
  if (process.platform === "win32" && !isVenv) {
    await symlink(path.dirname(runtime.executable), pythonCommon, "junction");
  } else {
    await mkdir(pythonCommon, { recursive: true });
    if (process.platform === "win32") {
      // Preserve the venv redirector, not the unrelated base interpreter.
      await copyFile(runtime.executable, mappedExecutable);
    } else {
      await symlink(runtime.executable, mappedExecutable, "file");
    }
    if (isVenv) {
      // Python 3.10 site.py treats the executable's parent directory as the
      // venv prefix. Here python_common takes the place of Scripts/bin, so
      // pyvenv.cfg and the package library belong in internalRoot.
      await copyFile(path.join(runtime.prefix, "pyvenv.cfg"), path.join(internalRoot, "pyvenv.cfg"));
      const library = process.platform === "win32" ? "Lib" : "lib";
      await symlink(path.join(runtime.prefix, library), path.join(internalRoot, library),
        process.platform === "win32" ? "junction" : "dir");
    }
  }
  return mappedExecutable;
}
