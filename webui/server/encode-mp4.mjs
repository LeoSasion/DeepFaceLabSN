import { spawn } from "node:child_process";
import path from "node:path";
import { PATHS } from "./paths.mjs";

const mode = process.argv[2];
if (!["standard", "lossless", "avi", "mov-lossless"].includes(mode)) {
  process.stderr.write("[WEB] 编码模式无效；只允许 standard、lossless、avi 或 mov-lossless。\r\n");
  process.exit(2);
}
const bitrate = process.argv[3] ?? "";
if (bitrate && (!/^\d{1,3}$/.test(bitrate) || Number(bitrate) < 1 || Number(bitrate) > 200)) {
  process.stderr.write("[WEB] 视频码率必须是 1–200 Mbps 的整数。\r\n");
  process.exit(2);
}

const common = [
  PATHS.currentMain,
  "videoed",
  "video-from-sequence",
];
const extension = mode === "avi" ? "avi" : mode === "mov-lossless" ? "mov" : "mp4";
const resultIsLossless = ["lossless", "mov-lossless"].includes(mode);

const steps = [
  {
    label: `正在生成 result.${extension}`,
    args: [
      ...common,
      "--input-dir",
      path.join(PATHS.workspaceRoot, "data_dst", "merged"),
      "--output-file",
      path.join(PATHS.workspaceRoot, `result.${extension}`),
      "--reference-file",
      path.join(PATHS.workspaceRoot, "data_dst.*"),
      "--include-audio",
      ...(bitrate ? ["--bitrate", bitrate] : []),
      ...(resultIsLossless ? ["--lossless"] : []),
    ],
  },
  {
    label: `正在生成 result_mask.${extension}`,
    args: [
      ...common,
      "--input-dir",
      path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
      "--output-file",
      path.join(PATHS.workspaceRoot, `result_mask.${extension}`),
      "--reference-file",
      path.join(PATHS.workspaceRoot, "data_dst.*"),
      "--lossless",
    ],
  },
];

function runStep(step, index) {
  return new Promise((resolve, reject) => {
    process.stdout.write(
      `\r\n\u001b[38;2;44;227;159m[WEB ${index + 1}/${steps.length}]\u001b[0m ${step.label}\r\n`,
    );
    const child = spawn(PATHS.python, step.args, {
      cwd: PATHS.repositoryRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `${step.label} 被信号 ${signal} 终止`
          : `${step.label} 失败（退出码 ${code ?? "unknown"}）`,
      ));
    });
  });
}

try {
  for (const [index, step] of steps.entries()) {
    await runStep(step, index);
  }
  process.stdout.write(
    `\r\n\u001b[38;2;44;227;159m[WEB]\u001b[0m 两个 ${extension.toUpperCase()} 文件均已生成。\r\n`,
  );
} catch (error) {
  process.stderr.write(
    `\r\n\u001b[38;2;255;122;122m[WEB]\u001b[0m ${error instanceof Error ? error.message : String(error)}\r\n`,
  );
  process.exitCode = 1;
}
