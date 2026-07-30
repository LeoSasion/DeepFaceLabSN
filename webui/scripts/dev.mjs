import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const serverEntry = path.join(webuiRoot, "server", "index.mjs");

const children = [
  spawn(process.execPath, [serverEntry], {
    cwd: webuiRoot,
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, [viteEntry, "--configLoader", "runner"], {
    cwd: webuiRoot,
    stdio: "inherit",
    env: process.env,
  }),
];

let stopping = false;
function stopChildren(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`[dev] child exited (${signal ?? code})`);
      stopChildren(code ?? 1);
    }
  });
  child.on("error", (error) => {
    console.error("[dev] unable to start child process", error);
    stopChildren(1);
  });
}

process.on("SIGINT", () => stopChildren(0));
process.on("SIGTERM", () => stopChildren(0));
