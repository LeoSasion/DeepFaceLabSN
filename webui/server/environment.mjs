import path from "node:path";
import { PATHS } from "./paths.mjs";

const delimiter = path.delimiter;

export function buildDflEnvironment(profile, additions = {}) {
  if (!["current", "legacy"].includes(profile)) {
    throw new Error(`未知 DFL 运行时：${profile}`);
  }

  const internal = PATHS.internalRoot;
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  const pythonRoot = path.join(internal, "python_common");
  const localProfile = path.join(internal, "_e", "u");
  const runtimePaths = [
    pythonRoot,
    path.join(pythonRoot, "Scripts"),
    path.join(internal, "CUDA"),
    path.join(internal, "CUDNN"),
    path.join(internal, "CUDNN", "Win6.x"),
    path.join(internal, "XnViewMP"),
    path.join(internal, "ffmpeg"),
    process.env.PATH ?? "",
  ];

  return {
    ...inheritedEnvironment,
    TMP: path.join(internal, "_e", "t"),
    TEMP: path.join(internal, "_e", "t"),
    USERPROFILE: localProfile,
    HOMEPATH: localProfile,
    LOCALAPPDATA: path.join(localProfile, "AppData", "Local"),
    APPDATA: path.join(localProfile, "AppData", "Roaming"),
    PYTHONHOME: "",
    PYTHONPATH: "",
    PYTHONEXECUTABLE: PATHS.python,
    PYTHONWEXECUTABLE: path.join(pythonRoot, "pythonw.exe"),
    PYTHON_EXECUTABLE: PATHS.python,
    PYTHONW_EXECUTABLE: path.join(pythonRoot, "pythonw.exe"),
    PYTHON_BIN_PATH: PATHS.python,
    PYTHON_LIB_PATH: path.join(pythonRoot, "Lib", "site-packages"),
    QT_QPA_PLATFORM_PLUGIN_PATH: path.join(pythonRoot, "Lib", "site-packages", "PyQt5", "Qt", "plugins"),
    XNVIEWMP_PATH: path.join(internal, "XnViewMP"),
    FFMPEG_PATH: path.join(internal, "ffmpeg"),
    WORKSPACE: PATHS.workspaceRoot,
    DFL_ROOT: profile === "legacy" ? PATHS.legacyDflRoot : PATHS.currentDflRoot,
    PYTHONIOENCODING: "utf-8",
    PATH: runtimePaths.filter(Boolean).join(delimiter),
    ...additions,
  };
}

export function describeEnvironment(profile) {
  const env = buildDflEnvironment(profile);
  return {
    profile,
    python: PATHS.python,
    dflRoot: env.DFL_ROOT,
    workspace: env.WORKSPACE,
  };
}
