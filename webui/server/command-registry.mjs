import { readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buildDflEnvironment } from "./environment.mjs";
import { summarizeXSegLabels } from "./asset-manager.mjs";
import { PATHS, pathExists } from "./paths.mjs";
import { createTrainingModelKey } from "./training-evaluation-manager.mjs";
import { getGpuTelemetry } from "./telemetry.mjs";

const GPU_PARAMETERS = [
  {
    id: "gpuIndexes",
    label: "GPU 索引",
    type: "text",
    default: "",
    placeholder: "留空自动选择，例如 0 或 0,1",
    help: "仅接受逗号分隔的数字；留空时交给 DFL 自动选择。",
    format: "gpu-indexes",
    advanced: true,
  },
  {
    id: "cpuOnly",
    label: "仅使用 CPU",
    type: "boolean",
    default: false,
    help: "调试兼容性时使用；速度通常明显更慢。",
    advanced: true,
  },
];

const FRAME_PARAMETERS = [
  {
    id: "outputExt",
    label: "帧图片格式",
    type: "select",
    default: "png",
    options: [
      { value: "png", label: "PNG（推荐）" },
      { value: "jpg", label: "JPG（更省空间）" },
    ],
  },
  {
    id: "fps",
    label: "每秒提取帧数",
    type: "number",
    default: 0,
    min: 0,
    max: 240,
    integer: true,
    help: "0 表示沿用原视频完整帧率。",
  },
];

const FACE_PARAMETERS = [
  {
    id: "detector",
    label: "检测器",
    type: "select",
    default: "s3fd",
    options: [
      { value: "s3fd", label: "S3FD（推荐）" },
      { value: "manual", label: "手动" },
    ],
  },
  {
    id: "faceType",
    label: "人脸类型",
    type: "select",
    default: "whole_face",
    options: [
      { value: "whole_face", label: "whole_face" },
      { value: "full_face", label: "full_face" },
      { value: "half_face", label: "half_face" },
      { value: "head", label: "head" },
      { value: "mark_only", label: "mark_only" },
    ],
  },
  {
    id: "imageSize",
    label: "人脸图片尺寸",
    type: "select",
    default: 512,
    options: [
      { value: 128, label: "128 px（快速测试）" },
      { value: 256, label: "256 px" },
      { value: 512, label: "512 px（推荐）" },
      { value: 768, label: "768 px" },
      { value: 1024, label: "1024 px" },
    ],
  },
  {
    id: "maxFaces",
    label: "每帧最大人脸数",
    type: "number",
    default: 1,
    min: 1,
    max: 32,
    integer: true,
  },
  {
    id: "jpegQuality",
    label: "JPEG 质量",
    type: "number",
    default: 90,
    min: 50,
    max: 100,
    integer: true,
    advanced: true,
  },
  ...GPU_PARAMETERS,
];

const SORT_PARAMETERS = [
  {
    id: "method",
    label: "排序方式",
    type: "select",
    default: "final-fast",
    options: [
      { value: "final-fast", label: "final-fast（推荐）" },
      { value: "final", label: "final" },
      { value: "origname", label: "origname（恢复原顺序）" },
      { value: "blur", label: "blur" },
      { value: "motion-blur", label: "motion-blur" },
      { value: "face-yaw", label: "face-yaw" },
      { value: "face-pitch", label: "face-pitch" },
      { value: "face-source-rect-size", label: "face-source-rect-size" },
      { value: "hist", label: "hist" },
      { value: "hist-dissim", label: "hist-dissim" },
      { value: "brightness", label: "brightness" },
      { value: "hue", label: "hue" },
      { value: "black", label: "black" },
      { value: "oneface", label: "oneface" },
      { value: "absdiff", label: "absdiff" },
    ],
  },
];

const TRAIN_PARAMETERS = [
  {
    id: "targetIterations",
    label: "目标迭代数",
    type: "number",
    default: 100000,
    min: 1,
    max: 100000000,
    integer: true,
    help: "仅用于 Web 估算剩余时间，不改变 DFL 的训练停止条件。",
  },
  {
    id: "forceModelName",
    label: "指定模型名称",
    type: "text",
    default: "",
    placeholder: "留空时由 DFL 询问或选择",
    format: "model-name",
    advanced: true,
  },
  {
    id: "silentStart",
    label: "静默继续最近模型",
    type: "boolean",
    default: false,
    help: "自动选择最佳 GPU 和最近使用的模型。",
  },
  ...GPU_PARAMETERS,
];

async function inspectTrainingResources(parameters = {}) {
  if (parameters.cpuOnly) {
    return {
      available: true,
      mode: "cpu",
      severity: "warning",
      summary: "CPU 模式可用于兼容性验证，但不适合长时间训练",
      recommendation: { resolution: 128, batchSize: 2 },
    };
  }
  const telemetry = await getGpuTelemetry().catch(() => null);
  if (!telemetry?.available || !telemetry.gpus?.length) {
    return {
      available: false,
      mode: "gpu",
      severity: "warning",
      summary: telemetry?.error ?? "无法读取 GPU 显存，请在终端确认训练配置",
      recommendation: { resolution: 128, batchSize: 2 },
    };
  }
  const requested = String(parameters.gpuIndexes ?? "")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter(Number.isInteger);
  const candidates = requested.length
    ? telemetry.gpus.filter((gpu) => requested.includes(gpu.index))
    : telemetry.gpus;
  const gpu = [...(candidates.length ? candidates : telemetry.gpus)]
    .sort((left, right) => (right.memoryTotalMiB ?? 0) - (left.memoryTotalMiB ?? 0))[0];
  const totalGiB = Math.max(0, Number(gpu.memoryTotalMiB ?? 0) / 1024);
  const freeGiB = Math.max(0, Number(gpu.memoryTotalMiB ?? 0) - Number(gpu.memoryUsedMiB ?? 0)) / 1024;
  const recommendation = totalGiB < 6
    ? { resolution: 128, batchSize: 2 }
    : totalGiB < 8
      ? { resolution: 160, batchSize: 4 }
      : totalGiB < 12
        ? { resolution: 192, batchSize: 4 }
        : totalGiB < 16
          ? { resolution: 256, batchSize: 4 }
          : { resolution: 320, batchSize: 6 };
  return {
    available: true,
    mode: "gpu",
    severity: freeGiB < 2 ? "warning" : "info",
    summary: freeGiB < 2
      ? "当前空闲显存偏低，建议关闭占用 GPU 的程序后再启动"
      : "建议值是安全起点，最终配置仍以 DFL 实际显存占用为准",
    gpu: {
      index: gpu.index,
      name: gpu.name,
      totalGiB: Number(totalGiB.toFixed(1)),
      freeGiB: Number(freeGiB.toFixed(1)),
    },
    recommendation,
  };
}

const MERGE_PARAMETERS = [
  {
    id: "forceModelName",
    label: "指定模型名称",
    type: "text",
    default: "",
    placeholder: "留空时在终端选择",
    format: "model-name",
  },
  {
    id: "mode",
    label: "合成模式",
    type: "select",
    default: "overlay",
    options: [
      { value: "overlay", label: "overlay（推荐）" },
      { value: "hist-match", label: "hist-match" },
      { value: "seamless", label: "seamless" },
      { value: "seamless-hist-match", label: "seamless-hist-match" },
      { value: "raw-rgb", label: "raw-rgb" },
      { value: "raw-predict", label: "raw-predict" },
      { value: "original", label: "original" },
    ],
  },
  {
    id: "maskMode",
    label: "遮罩模式",
    type: "select",
    default: 7,
    options: [
      { value: 1, label: "dst" },
      { value: 2, label: "learned-prd" },
      { value: 3, label: "learned-dst" },
      { value: 4, label: "learned-prd × learned-dst" },
      { value: 5, label: "learned-prd + learned-dst" },
      { value: 6, label: "XSeg-prd" },
      { value: 7, label: "XSeg-dst（推荐）" },
      { value: 8, label: "XSeg-prd × XSeg-dst" },
      { value: 9, label: "learned × XSeg 组合" },
    ],
  },
  {
    id: "workers",
    label: "工作线程",
    type: "number",
    default: 8,
    min: 1,
    max: 128,
    integer: true,
  },
  {
    id: "erodeMask",
    label: "遮罩侵蚀",
    type: "number",
    default: 0,
    min: -400,
    max: 400,
    integer: true,
    advanced: true,
  },
  {
    id: "blurMask",
    label: "遮罩羽化",
    type: "number",
    default: 0,
    min: 0,
    max: 400,
    integer: true,
    advanced: true,
  },
  {
    id: "motionBlur",
    label: "动态模糊",
    type: "number",
    default: 0,
    min: 0,
    max: 100,
    integer: true,
    advanced: true,
  },
  {
    id: "faceScale",
    label: "头像缩放",
    type: "number",
    default: 0,
    min: -50,
    max: 50,
    integer: true,
    advanced: true,
  },
  {
    id: "colorTransfer",
    label: "颜色迁移",
    type: "select",
    default: "none",
    options: [
      { value: "none", label: "关闭" },
      { value: "rct", label: "rct" },
      { value: "lct", label: "lct" },
      { value: "mkl", label: "mkl" },
      { value: "mkl-m", label: "mkl-m" },
      { value: "idt", label: "idt" },
      { value: "idt-m", label: "idt-m" },
      { value: "sot-m", label: "sot-m" },
      { value: "mix-m", label: "mix-m" },
    ],
    advanced: true,
  },
  {
    id: "sharpenMode",
    label: "锐化模式",
    type: "select",
    default: 0,
    options: [
      { value: 0, label: "关闭" },
      { value: 1, label: "box" },
      { value: 2, label: "gaussian" },
    ],
    advanced: true,
  },
  {
    id: "sharpenAmount",
    label: "锐化力度",
    type: "number",
    default: 0,
    min: -100,
    max: 100,
    integer: true,
    advanced: true,
  },
  {
    id: "superResolution",
    label: "超分辨率",
    type: "number",
    default: 0,
    min: 0,
    max: 100,
    integer: true,
    advanced: true,
  },
  {
    id: "imageDenoise",
    label: "图片降噪",
    type: "number",
    default: 0,
    min: 0,
    max: 500,
    integer: true,
    advanced: true,
  },
  {
    id: "bicubicDegrade",
    label: "双三次降低",
    type: "number",
    default: 0,
    min: 0,
    max: 100,
    integer: true,
    advanced: true,
  },
  {
    id: "colorDegrade",
    label: "颜色降低",
    type: "number",
    default: 0,
    min: 0,
    max: 100,
    integer: true,
    advanced: true,
  },
  ...GPU_PARAMETERS,
];

const CUT_PARAMETERS = [
  {
    id: "fromTime",
    label: "开始时间",
    type: "text",
    default: "00:00:00.000",
    placeholder: "00:00:00.000",
    format: "time-code",
  },
  {
    id: "toTime",
    label: "结束时间",
    type: "text",
    default: "",
    placeholder: "留空直到视频结尾",
    format: "time-code",
  },
  {
    id: "audioTrackId",
    label: "音轨编号",
    type: "number",
    default: 0,
    min: 0,
    max: 32,
    integer: true,
    advanced: true,
  },
  {
    id: "bitrate",
    label: "视频码率",
    type: "number",
    default: 16,
    min: 1,
    max: 200,
    integer: true,
    suffix: "Mbps",
  },
];

const DENOISE_PARAMETERS = [
  {
    id: "factor",
    label: "降噪强度",
    type: "number",
    default: 5,
    min: 1,
    max: 20,
    integer: true,
  },
];

const PACK_PARAMETERS = [
  {
    id: "archiveType",
    label: "打包格式",
    type: "select",
    default: "pak",
    options: [
      { value: "pak", label: "PAK（DFL 原生）" },
      { value: "zip", label: "ZIP" },
    ],
  },
];

export class CommandValidationError extends Error {
  constructor(message, code = "COMMAND_VALIDATION_FAILED", details) {
    super(message);
    this.name = "CommandValidationError";
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

function appendValue(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function appendBoolean(args, flag, value) {
  if (value === true) args.push(flag);
}

function buildMergeEnvironment(profile, context) {
  if (context.launchMode !== "guided") return buildDflEnvironment(profile);
  const parameters = context.parameters;
  return buildDflEnvironment(profile, {
    DFL_WEB_MERGE_CONFIG: JSON.stringify({
      mode: parameters.mode,
      maskMode: parameters.maskMode,
      workers: parameters.workers,
      erodeMask: parameters.erodeMask,
      blurMask: parameters.blurMask,
      motionBlur: parameters.motionBlur,
      faceScale: parameters.faceScale,
      colorTransfer: parameters.colorTransfer,
      sharpenMode: parameters.sharpenMode,
      sharpenAmount: parameters.sharpenAmount,
      superResolution: parameters.superResolution,
      imageDenoise: parameters.imageDenoise,
      bicubicDegrade: parameters.bicubicDegrade,
      colorDegrade: parameters.colorDegrade,
    }),
  });
}

async function requireFile(target, message) {
  if (!(await pathExists(target)) || !(await stat(target)).isFile()) {
    throw new CommandValidationError(message, "INPUT_MISSING", { path: target });
  }
}

async function requireDirectoryWithFiles(target, message) {
  if (!(await pathExists(target)) || !(await stat(target)).isDirectory()) {
    throw new CommandValidationError(message, "INPUT_MISSING", { path: target });
  }
  const entries = await readdir(target);
  if (!entries.some((entry) => !entry.startsWith("."))) {
    throw new CommandValidationError(message, "INPUT_EMPTY", { path: target });
  }
}

async function requireNonEmptyFile(target, message) {
  if (!(await pathExists(target))) {
    throw new CommandValidationError(message, "OUTPUT_MISSING", { path: target });
  }
  const fileStat = await stat(target);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new CommandValidationError(message, "OUTPUT_EMPTY", { path: target });
  }
}

async function requireDirectoryMatching(target, pattern, message) {
  await requireDirectoryWithFiles(target, message);
  const entries = await readdir(target);
  if (!entries.some((entry) => pattern.test(entry))) {
    throw new CommandValidationError(message, "INPUT_MISSING", { path: target });
  }
}

export function validateXSegTrainingLabels(srcSummary, dstSummary) {
  const srcCount = Number(srcSummary?.usableLabelCount) || 0;
  const dstCount = Number(dstSummary?.usableLabelCount) || 0;
  if (srcCount + dstCount === 0) {
    throw new CommandValidationError(
      "未检测到可训练的 XSeg 标注。请先在 SRC 或 DST 数据集中打开 XSeg Web 遮罩编辑器，至少保存 1 张多边形标注；也可以使用已写入图片的 XSeg 遮罩。",
      "XSEG_LABELS_MISSING",
      { srcLabelCount: srcCount, dstLabelCount: dstCount },
    );
  }
  return { srcLabelCount: srcCount, dstLabelCount: dstCount };
}

function findWorkspaceVideo(name) {
  const entries = readdirSync(PATHS.workspaceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && new RegExp(`^${name}\\.[^.]+$`, "i").test(entry.name))
    .map((entry) => path.join(PATHS.workspaceRoot, entry.name))
    .sort((a, b) => a.localeCompare(b))[0];
}

function datasetDirectory(side) {
  return path.join(PATHS.workspaceRoot, `data_${side}`, "aligned");
}

function buildDatasetUtility({
  id,
  label,
  shortLabel,
  side,
  args,
  parameters = [],
  locks,
}) {
  return {
    id,
    label,
    shortLabel,
    description: `${side.toUpperCase()} aligned 的固定白名单工具。`,
    profile: "current",
    category: "dataset",
    stage: "clean",
    side,
    interactive: true,
    parameters,
    controls: [],
    locks: locks ?? [`workspace:data_${side}_aligned`],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        datasetDirectory(side),
        `${side.toUpperCase()} aligned 人脸集不存在或为空`,
      );
    },
    build(context) {
      return {
        executable: PATHS.python,
        args: [PATHS.currentMain, ...args(datasetDirectory(side), context.parameters)],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        datasetDirectory(side),
        `${side.toUpperCase()} aligned 工具已结束，但数据集为空`,
      );
    },
  };
}

function createDatasetUtilityDefinitions() {
  const result = {};
  for (const side of ["src", "dst"]) {
    const upper = side.toUpperCase();
    const add = (suffix, options) => {
      const id = `${side}.${suffix}`;
      result[id] = buildDatasetUtility({ id, side, ...options });
    };
    add("landmarks_debug", {
      label: `${upper} landmarks 检查图`,
      shortLabel: `${upper} 检查图`,
      args: (directory) => [
        "util", "--input-dir", directory, "--add-landmarks-debug-images",
      ],
    });
    add("faces_resize", {
      label: `调整 ${upper} aligned 尺寸`,
      shortLabel: `${upper} 缩放`,
      args: (directory) => ["facesettool", "resize", "--input-dir", directory],
    });
    add("faces_enhance", {
      label: `高清修复 ${upper} aligned`,
      shortLabel: `${upper} 修复`,
      parameters: GPU_PARAMETERS,
      locks: [`workspace:data_${side}_aligned`, "gpu"],
      args: (directory, parameters) => {
        const values = ["facesettool", "enhance", "--input-dir", directory];
        appendValue(values, "--force-gpu-idxs", parameters.gpuIndexes);
        appendBoolean(values, "--cpu-only", parameters.cpuOnly);
        return values;
      },
    });
    add("faces_pack", {
      label: `打包 ${upper} aligned`,
      shortLabel: `${upper} 打包`,
      parameters: PACK_PARAMETERS,
      args: (directory, parameters) => [
        "util",
        "--input-dir",
        directory,
        "--pack-faceset",
        "--archive-type",
        parameters.archiveType,
      ],
    });
    add("faces_unpack", {
      label: `解包 ${upper} aligned`,
      shortLabel: `${upper} 解包`,
      args: (directory) => ["util", "--input-dir", directory, "--unpack-faceset"],
    });
    add("recover_names", {
      label: `恢复 ${upper} 原始文件名`,
      shortLabel: `${upper} 恢复名`,
      args: (directory) => [
        "util", "--input-dir", directory, "--recover-original-aligned-filename",
      ],
    });
    add("metadata_save", {
      label: `保存 ${upper} faceset 元数据`,
      shortLabel: `${upper} 元数据保存`,
      args: (directory) => ["util", "--input-dir", directory, "--save-faceset-metadata"],
    });
    add("metadata_restore", {
      label: `恢复 ${upper} faceset 元数据`,
      shortLabel: `${upper} 元数据恢复`,
      args: (directory) => ["util", "--input-dir", directory, "--restore-faceset-metadata"],
    });
  }
  return result;
}

function buildXsegUtility({ id, label, shortLabel, side, action, modelDirectory }) {
  const requiresModel = action === "apply";
  return {
    id,
    label,
    shortLabel,
    description: `${side.toUpperCase()} aligned 的 XSeg ${label}操作。`,
    profile: "current",
    category: "mask",
    stage: "mask",
    side,
    interactive: true,
    parameters: [],
    controls: [],
    locks: [
      `workspace:data_${side}_aligned`,
      ...(requiresModel ? [modelDirectory === "custom" ? "workspace:xseg_model" : "gpu"] : []),
    ],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        datasetDirectory(side),
        `${side.toUpperCase()} aligned 人脸集不存在或为空`,
      );
      if (requiresModel) {
        const directory = modelDirectory === "custom"
          ? path.join(PATHS.workspaceRoot, "xseg_model")
          : path.join(PATHS.internalRoot, "model_generic_xseg");
        await requireDirectoryMatching(
          directory,
          /^XSeg_(?:256|data)/i,
          `${modelDirectory === "custom" ? "自定义" : "内置"} XSeg 模型不存在`,
        );
      }
    },
    build() {
      const values = [PATHS.currentMain, "xseg", action, "--input-dir", datasetDirectory(side)];
      if (requiresModel) {
        values.push(
          "--model-dir",
          modelDirectory === "custom"
            ? path.join(PATHS.workspaceRoot, "xseg_model")
            : path.join(PATHS.internalRoot, "model_generic_xseg"),
        );
      }
      return {
        executable: PATHS.python,
        args: values,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        datasetDirectory(side),
        `${side.toUpperCase()} aligned 操作已结束，但数据集为空`,
      );
    },
  };
}

function createXsegUtilityDefinitions() {
  const result = {};
  for (const side of ["src", "dst"]) {
    const upper = side.toUpperCase();
    const entries = [
      ["apply_builtin", `应用内置 XSeg 到 ${upper}`, `${upper} 内置遮罩`, "apply", "builtin"],
      ["remove_labels", `移除 ${upper} 手绘标签`, `${upper} 移除手绘`, "remove_labels"],
      ["remove_mask", `移除 ${upper} 应用遮罩`, `${upper} 移除遮罩`, "remove"],
      ["fetch_labels", `提取 ${upper} 已标注人脸`, `${upper} 提取标注`, "fetch"],
    ];
    for (const [suffix, label, shortLabel, action, modelDirectory] of entries) {
      const id = `xseg.${side}_${suffix}`;
      result[id] = buildXsegUtility({
        id,
        label,
        shortLabel,
        side,
        action,
        modelDirectory,
      });
    }
  }
  return result;
}

function buildCurrentTrainer(model, label, pretrainedDirectory) {
  const id = `train.${model.toLowerCase()}`;
  return {
    id,
    label: `训练 ${label}`,
    shortLabel: label,
    description: `使用 current DFL 训练 ${label}；完整 CLI 问答保留在 Web 终端。`,
    profile: "current",
    category: "training",
    stage: "train",
    side: "both",
    interactive: true,
    parameters: TRAIN_PARAMETERS,
    controls: [],
    locks: ["workspace:model", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(datasetDirectory("src"), "SRC aligned 人脸集不存在或为空");
      await requireDirectoryWithFiles(datasetDirectory("dst"), "DST aligned 人脸集不存在或为空");
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "train",
        "--training-data-src-dir",
        datasetDirectory("src"),
        "--training-data-dst-dir",
        datasetDirectory("dst"),
        "--pretraining-data-dir",
        path.join(PATHS.workspaceRoot, "pretrain_faces"),
        "--model-dir",
        path.join(PATHS.workspaceRoot, "model"),
        "--model",
        model,
        "--no-preview",
      ];
      if (pretrainedDirectory) {
        appendValue(args, "--pretrained-model-dir", path.join(PATHS.internalRoot, pretrainedDirectory));
      }
      if (model === "ME") args.push("--auto-gen-config");
      appendValue(args, "--force-model-name", context.parameters.forceModelName);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      appendBoolean(args, "--silent-start", context.parameters.silentStart);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "model"),
        `${label} 训练已结束，但 workspace/model 中没有模型文件`,
      );
    },
  };
}

function buildModelExport(model, profile, label) {
  const id = `export.dfm_${model.toLowerCase()}`;
  return {
    id,
    label: `导出 ${label} DFM`,
    shortLabel: `${label} DFM`,
    description: `把 ${label} 模型导出为 DeepFaceLive 可用的 DFM。`,
    profile,
    category: "model",
    stage: "encode",
    side: "both",
    interactive: true,
    parameters: [],
    controls: [],
    locks: ["workspace:model", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(
        profile === "legacy" ? PATHS.legacyMain : PATHS.currentMain,
        `${profile} DeepFaceLab 入口不存在`,
      );
      await requireDirectoryMatching(
        path.join(PATHS.workspaceRoot, "model"),
        new RegExp(`_${model}_`, "i"),
        `未找到 ${label} 模型`,
      );
    },
    build() {
      return {
        executable: PATHS.python,
        args: [
          profile === "legacy" ? PATHS.legacyMain : PATHS.currentMain,
          "exportdfm",
          "--model-dir",
          path.join(PATHS.workspaceRoot, "model"),
          "--model",
          model,
        ],
        env: buildDflEnvironment(profile),
      };
    },
    async postflight() {
      await requireDirectoryMatching(
        path.join(PATHS.workspaceRoot, "model"),
        /\.dfm$/i,
        `${label} DFM 导出结束，但没有找到 .dfm 文件`,
      );
    },
  };
}

function buildModelMerge(model, profile, label) {
  const id = `merge.${model.toLowerCase()}`;
  return {
    id,
    label: `合成 ${label} 人脸`,
    shortLabel: `${label} 合成`,
    description: `使用 ${label} 模型生成 merged 与 merged_mask 图片序列。`,
    profile,
    category: "merge",
    stage: "merge",
    side: "dst",
    interactive: true,
    parameters: MERGE_PARAMETERS,
    controls: [],
    locks: ["workspace:model", "workspace:data_dst_merged", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(
        profile === "legacy" ? PATHS.legacyMain : PATHS.currentMain,
        `${profile} DeepFaceLab 入口不存在`,
      );
      await requireDirectoryWithFiles(path.join(PATHS.workspaceRoot, "data_dst"), "DST 视频帧不存在");
      await requireDirectoryWithFiles(datasetDirectory("dst"), "DST aligned 人脸集不存在或为空");
      await requireDirectoryMatching(
        path.join(PATHS.workspaceRoot, "model"),
        new RegExp(`_${model}_`, "i"),
        `未找到 ${label} 模型`,
      );
      await requireDirectoryMatching(
        path.join(PATHS.internalRoot, "model_generic_xseg"),
        /^XSeg_(?:256|data)/i,
        "内置 XSeg 模型不存在",
      );
    },
    build(context) {
      const args = [
        profile === "legacy" ? PATHS.legacyMain : PATHS.currentMain,
        "merge",
        "--input-dir",
        path.join(PATHS.workspaceRoot, "data_dst"),
        "--output-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "merged"),
        "--output-mask-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
        "--aligned-dir",
        datasetDirectory("dst"),
        "--model-dir",
        path.join(PATHS.workspaceRoot, "model"),
        "--xseg-dir",
        path.join(PATHS.internalRoot, "model_generic_xseg"),
        "--model",
        model,
      ];
      appendValue(args, "--force-model-name", context.parameters.forceModelName);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      return {
        executable: PATHS.python,
        args,
        env: buildMergeEnvironment(profile, context),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged"),
        `${label} 合成结束，但 merged 目录没有图片`,
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
        `${label} 合成结束，但 merged_mask 目录没有图片`,
      );
    },
  };
}

function buildAdditionalEncode(id, label, mode, extension) {
  return {
    id,
    label,
    shortLabel: label,
    description: `生成 result.${extension} 与 result_mask.${extension}。`,
    profile: "current",
    category: "encode",
    stage: "encode",
    side: "dst",
    interactive: true,
    parameters: [],
    controls: [],
    locks: ["workspace:data_dst_merged", "workspace:result"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      if (!(await findWorkspaceVideo("data_dst"))) {
        throw new CommandValidationError("未找到 workspace/data_dst.* 参考视频", "INPUT_MISSING");
      }
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged"),
        "merged 图片序列不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
        "merged_mask 图片序列不存在或为空",
      );
    },
    build() {
      return {
        executable: process.execPath,
        args: [path.join(PATHS.serverDirectory, "encode-mp4.mjs"), mode],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireNonEmptyFile(
        path.join(PATHS.workspaceRoot, `result.${extension}`),
        `编码结束，但 result.${extension} 不存在或为空`,
      );
      await requireNonEmptyFile(
        path.join(PATHS.workspaceRoot, `result_mask.${extension}`),
        `编码结束，但 result_mask.${extension} 不存在或为空`,
      );
    },
  };
}

function buildVideoCut(side) {
  const upper = side.toUpperCase();
  return {
    id: `video.cut_${side}`,
    label: `剪切 ${upper} 视频`,
    shortLabel: `${upper} 剪切`,
    description: `剪切 workspace/data_${side}.*；DFL 会在工作区生成剪切结果。`,
    profile: "current",
    category: "video",
    stage: "material",
    side,
    interactive: true,
    parameters: CUT_PARAMETERS,
    controls: [],
    locks: [`workspace:data_${side}`],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      if (!(await findWorkspaceVideo(`data_${side}`))) {
        throw new CommandValidationError(`未找到 ${upper} 视频`, "INPUT_MISSING");
      }
    },
    build(context) {
      const inputFile = findWorkspaceVideo(`data_${side}`);
      if (!inputFile) {
        throw new CommandValidationError(`未找到 ${upper} 视频`, "INPUT_MISSING");
      }
      const args = [
        PATHS.currentMain,
        "videoed",
        "cut-video",
        "--input-file",
        inputFile,
      ];
      appendValue(args, "--from-time", context.parameters.fromTime);
      appendValue(args, "--to-time", context.parameters.toTime);
      appendValue(args, "--audio-track-id", context.parameters.audioTrackId);
      appendValue(args, "--bitrate", context.parameters.bitrate);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {},
  };
}

const definitions = Object.freeze({
  "src.extract_frames": {
    id: "src.extract_frames",
    label: "提取 SRC 视频帧",
    shortLabel: "SRC 拆帧",
    description: "从 workspace/data_src.* 提取源视频帧。",
    profile: "current",
    category: "extract",
    stage: "frames",
    side: "src",
    interactive: true,
    parameters: FRAME_PARAMETERS,
    controls: [],
    locks: ["workspace:data_src"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      const sourceVideo = await findWorkspaceVideo("data_src");
      if (!sourceVideo) {
        throw new CommandValidationError(
          "未找到 workspace/data_src.* 源视频",
          "INPUT_MISSING",
          { path: path.join(PATHS.workspaceRoot, "data_src.*") },
        );
      }
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "videoed",
        "extract-video",
        "--input-file",
        path.join(PATHS.workspaceRoot, "data_src.*"),
        "--output-dir",
        path.join(PATHS.workspaceRoot, "data_src"),
      ];
      appendValue(args, "--output-ext", context.parameters.outputExt);
      appendValue(args, "--fps", context.parameters.fps);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src"),
        "SRC 拆帧命令已结束，但没有生成视频帧",
      );
    },
  },
  "src.extract_faces": {
    id: "src.extract_faces",
    label: "提取 SRC 人脸",
    shortLabel: "SRC 人脸",
    description: "使用 S3FD 从 SRC 帧提取 aligned 人脸。",
    profile: "current",
    category: "extract",
    stage: "faces",
    side: "src",
    interactive: true,
    parameters: FACE_PARAMETERS,
    controls: [],
    locks: ["workspace:data_src_aligned", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src"),
        "workspace/data_src 不存在或没有帧",
      );
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "extract",
        "--input-dir",
        path.join(PATHS.workspaceRoot, "data_src"),
        "--output-dir",
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
      ];
      appendValue(args, "--detector", context.parameters.detector);
      appendValue(args, "--face-type", context.parameters.faceType);
      appendValue(args, "--image-size", context.parameters.imageSize);
      appendValue(args, "--max-faces-from-image", context.parameters.maxFaces);
      appendValue(args, "--jpeg-quality", context.parameters.jpegQuality);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "SRC 人脸提取命令已结束，但 aligned 目录没有产物",
      );
    },
  },
  "dst.extract_frames": {
    id: "dst.extract_frames",
    label: "提取 DST 视频帧",
    shortLabel: "DST 拆帧",
    description: "从 workspace/data_dst.* 提取目标视频帧。",
    profile: "current",
    category: "extract",
    stage: "frames",
    side: "dst",
    interactive: true,
    parameters: FRAME_PARAMETERS,
    controls: [],
    locks: ["workspace:data_dst"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      const targetVideo = await findWorkspaceVideo("data_dst");
      if (!targetVideo) {
        throw new CommandValidationError(
          "未找到 workspace/data_dst.* 目标视频",
          "INPUT_MISSING",
          { path: path.join(PATHS.workspaceRoot, "data_dst.*") },
        );
      }
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "videoed",
        "extract-video",
        "--input-file",
        path.join(PATHS.workspaceRoot, "data_dst.*"),
        "--output-dir",
        path.join(PATHS.workspaceRoot, "data_dst"),
      ];
      appendValue(args, "--output-ext", context.parameters.outputExt);
      appendValue(args, "--fps", context.parameters.fps);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst"),
        "DST 拆帧命令已结束，但没有生成视频帧",
      );
    },
  },
  "dst.extract_faces": {
    id: "dst.extract_faces",
    label: "提取 DST 人脸",
    shortLabel: "DST 人脸",
    description: "使用 S3FD 从 DST 帧提取 aligned 人脸。",
    profile: "current",
    category: "extract",
    stage: "faces",
    side: "dst",
    interactive: true,
    parameters: FACE_PARAMETERS,
    controls: [],
    locks: ["workspace:data_dst_aligned", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst"),
        "workspace/data_dst 不存在或没有帧",
      );
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "extract",
        "--input-dir",
        path.join(PATHS.workspaceRoot, "data_dst"),
        "--output-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
      ];
      appendValue(args, "--detector", context.parameters.detector);
      appendValue(args, "--face-type", context.parameters.faceType);
      appendValue(args, "--image-size", context.parameters.imageSize);
      appendValue(args, "--max-faces-from-image", context.parameters.maxFaces);
      appendValue(args, "--jpeg-quality", context.parameters.jpegQuality);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST 人脸提取命令已结束，但 aligned 目录没有产物",
      );
    },
  },
  "train.saehd": {
    id: "train.saehd",
    label: "训练 SAEHD",
    shortLabel: "SAEHD",
    description: "使用 legacy DFL 训练 SAEHD，在 Web 中提供模型控制和预览。",
    profile: "legacy",
    category: "training",
    stage: "train",
    side: "both",
    interactive: true,
    parameters: TRAIN_PARAMETERS,
    controls: ["save", "backup", "preview", "evaluate", "close"],
    locks: ["workspace:model", "gpu"],
    async preflight(context = {}) {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.legacyMain, "legacy DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "SRC aligned 人脸集不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST aligned 人脸集不存在或为空",
      );
      const resources = await inspectTrainingResources(context.parameters);
      const modelName = context.parameters?.forceModelName;
      if (!modelName) {
        return {
          resources,
          evaluation: {
            enabled: false,
            reason: "姿态评测需要在引导模式中明确指定 SAEHD 模型名称",
          },
        };
      }
      if (!context.trainingEvaluationManager) {
        return {
          resources,
          evaluation: {
            enabled: false,
            reason: "本地姿态评测管理器不可用",
          },
        };
      }
      try {
        const modelKey = createTrainingModelKey(modelName, "SAEHD");
        const manifest = await context.trainingEvaluationManager.createOrReuseManifest(
          modelKey,
          { modelName, modelClass: "SAEHD" },
        );
        const existing = await context.trainingEvaluationManager.listSnapshots(modelKey);
        return {
          resources,
          evaluation: {
            enabled: true,
            modelKey,
            manifestId: manifest.manifestId,
            manifestPath: context.trainingEvaluationManager.manifestPath(
              modelKey,
              manifest.manifestId,
            ),
            evaluationRoot: context.trainingEvaluationManager.modelDirectory(modelKey),
            existingSnapshotIds: existing.snapshots.map((snapshot) => snapshot.snapshotId),
          },
        };
      } catch (error) {
        return {
          resources,
          evaluation: {
            enabled: false,
            reason: error instanceof Error ? error.message : "姿态评测集生成失败",
          },
        };
      }
    },
    build(context) {
      const args = [
        PATHS.legacyMain,
        "train",
        "--training-data-src-dir",
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "--training-data-dst-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "--pretraining-data-dir",
        path.join(PATHS.workspaceRoot, "pretrain_faces"),
        "--model-dir",
        path.join(PATHS.workspaceRoot, "model"),
        "--model",
        "SAEHD",
        "--no-preview",
      ];
      appendValue(args, "--force-model-name", context.parameters.forceModelName);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      appendBoolean(args, "--silent-start", context.parameters.silentStart);
      const evaluation = context.preflight?.evaluation ?? {
        enabled: false,
        reason: "姿态评测预检尚未运行",
      };
      const evaluationEnvironment = evaluation.enabled
        ? {
            DFL_WEB_EVAL_MANIFEST: evaluation.manifestPath,
            DFL_WEB_EVAL_ROOT: evaluation.evaluationRoot,
            DFL_WEB_EVAL_MODEL_KEY: evaluation.modelKey,
            DFL_WEBUI_PYTHON: path.join(PATHS.webuiRoot, "python"),
          }
        : {};
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("legacy", {
          DFL_WEB_CONTROL_FILE: context.controlFile,
          DFL_WEB_PREVIEW_FILE: context.previewFile,
          ...evaluationEnvironment,
        }),
        evaluation: evaluation.enabled
          ? {
              enabled: true,
              modelKey: evaluation.modelKey,
              manifestId: evaluation.manifestId,
              existingSnapshotIds: evaluation.existingSnapshotIds,
            }
          : { enabled: false, reason: evaluation.reason },
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "model"),
        "SAEHD 训练已结束，但 workspace/model 中没有模型文件",
      );
    },
  },
  "src.sort_faces": {
    id: "src.sort_faces",
    label: "排序 SRC aligned",
    shortLabel: "SRC 排序",
    description: "整理 SRC aligned 人脸；未在向导中指定时保留 DFL 的 CLI 问答。",
    profile: "current",
    category: "sort",
    stage: "clean",
    side: "src",
    interactive: true,
    parameters: SORT_PARAMETERS,
    controls: [],
    locks: ["workspace:data_src_aligned"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "SRC aligned 人脸集不存在或为空",
      );
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "sort",
        "--input-dir",
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
      ];
      appendValue(args, "--by", context.parameters.method);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "SRC 排序已结束，但 aligned 目录为空",
      );
    },
  },
  "dst.sort_faces": {
    id: "dst.sort_faces",
    label: "排序 DST aligned",
    shortLabel: "DST 排序",
    description: "整理 DST aligned 人脸；未在向导中指定时保留 DFL 的 CLI 问答。",
    profile: "current",
    category: "sort",
    stage: "clean",
    side: "dst",
    interactive: true,
    parameters: SORT_PARAMETERS,
    controls: [],
    locks: ["workspace:data_dst_aligned"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST aligned 人脸集不存在或为空",
      );
    },
    build(context) {
      const args = [
        PATHS.currentMain,
        "sort",
        "--input-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
      ];
      appendValue(args, "--by", context.parameters.method);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST 排序已结束，但 aligned 目录为空",
      );
    },
  },
  "xseg.train": {
    id: "xseg.train",
    label: "训练 XSeg",
    shortLabel: "XSeg 训练",
    description: "使用 SRC 与 DST aligned 人脸训练自定义遮罩模型。",
    profile: "legacy",
    category: "training",
    stage: "mask",
    side: "both",
    interactive: true,
    parameters: TRAIN_PARAMETERS,
    controls: ["save", "backup", "preview", "close"],
    locks: ["workspace:xseg_model", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.legacyMain, "legacy DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "SRC aligned 人脸集不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST aligned 人脸集不存在或为空",
      );
      const [srcLabels, dstLabels] = await Promise.all([
        summarizeXSegLabels("src"),
        summarizeXSegLabels("dst"),
      ]);
      return { xsegLabels: validateXSegTrainingLabels(srcLabels, dstLabels) };
    },
    build(context) {
      const args = [
        PATHS.legacyMain,
        "train",
        "--training-data-src-dir",
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "--training-data-dst-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "--pretraining-data-dir",
        path.join(PATHS.workspaceRoot, "pretrain_faces"),
        "--model-dir",
        path.join(PATHS.workspaceRoot, "xseg_model"),
        "--model",
        "XSeg",
        "--no-preview",
      ];
      appendValue(args, "--force-model-name", context.parameters.forceModelName);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      appendBoolean(args, "--silent-start", context.parameters.silentStart);
      return {
        executable: PATHS.python,
        args,
        env: buildDflEnvironment("legacy", {
          DFL_WEB_CONTROL_FILE: context.controlFile,
          DFL_WEB_PREVIEW_FILE: context.previewFile,
        }),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "xseg_model"),
        "XSeg 训练已结束，但 workspace/xseg_model 中没有模型文件",
      );
    },
  },
  "xseg.apply_src": {
    id: "xseg.apply_src",
    label: "应用 XSeg 到 SRC",
    shortLabel: "XSeg → SRC",
    description: "把 workspace/xseg_model 中的自定义遮罩应用到 SRC aligned。",
    profile: "current",
    category: "mask",
    stage: "mask",
    side: "src",
    interactive: true,
    parameters: [],
    controls: [],
    locks: ["workspace:data_src_aligned", "workspace:xseg_model", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "SRC aligned 人脸集不存在或为空",
      );
      await requireDirectoryMatching(
        path.join(PATHS.workspaceRoot, "xseg_model"),
        /^XSeg_(?:256|data)/i,
        "XSeg 模型目录不存在或为空",
      );
    },
    build() {
      return {
        executable: PATHS.python,
        args: [
          PATHS.currentMain,
          "xseg",
          "apply",
          "--input-dir",
          path.join(PATHS.workspaceRoot, "data_src", "aligned"),
          "--model-dir",
          path.join(PATHS.workspaceRoot, "xseg_model"),
        ],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_src", "aligned"),
        "XSeg SRC 应用已结束，但 aligned 目录为空",
      );
    },
  },
  "xseg.apply_dst": {
    id: "xseg.apply_dst",
    label: "应用 XSeg 到 DST",
    shortLabel: "XSeg → DST",
    description: "把 workspace/xseg_model 中的自定义遮罩应用到 DST aligned。",
    profile: "current",
    category: "mask",
    stage: "mask",
    side: "dst",
    interactive: true,
    parameters: [],
    controls: [],
    locks: ["workspace:data_dst_aligned", "workspace:xseg_model", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST aligned 人脸集不存在或为空",
      );
      await requireDirectoryMatching(
        path.join(PATHS.workspaceRoot, "xseg_model"),
        /^XSeg_(?:256|data)/i,
        "XSeg 模型目录不存在或为空",
      );
    },
    build() {
      return {
        executable: PATHS.python,
        args: [
          PATHS.currentMain,
          "xseg",
          "apply",
          "--input-dir",
          path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
          "--model-dir",
          path.join(PATHS.workspaceRoot, "xseg_model"),
        ],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "XSeg DST 应用已结束，但 aligned 目录为空",
      );
    },
  },
  "merge.saehd": {
    id: "merge.saehd",
    label: "合成 SAEHD 人脸",
    shortLabel: "SAEHD 合成",
    description: "使用 legacy SAEHD 模型生成 merged 与 merged_mask 图片序列。",
    profile: "legacy",
    category: "merge",
    stage: "merge",
    side: "dst",
    interactive: true,
    parameters: MERGE_PARAMETERS,
    controls: [],
    locks: ["workspace:model", "workspace:data_dst_merged", "gpu"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.legacyMain, "legacy DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst"),
        "DST 视频帧目录不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "DST aligned 人脸集不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "model"),
        "SAEHD 模型目录不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.internalRoot, "model_generic_xseg"),
        "内置 XSeg 模型目录不存在或为空",
      );
    },
    build(context) {
      const args = [
        PATHS.legacyMain,
        "merge",
        "--input-dir",
        path.join(PATHS.workspaceRoot, "data_dst"),
        "--output-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "merged"),
        "--output-mask-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
        "--aligned-dir",
        path.join(PATHS.workspaceRoot, "data_dst", "aligned"),
        "--model-dir",
        path.join(PATHS.workspaceRoot, "model"),
        "--xseg-dir",
        path.join(PATHS.internalRoot, "model_generic_xseg"),
        "--model",
        "SAEHD",
      ];
      appendValue(args, "--force-model-name", context.parameters.forceModelName);
      appendValue(args, "--force-gpu-idxs", context.parameters.gpuIndexes);
      appendBoolean(args, "--cpu-only", context.parameters.cpuOnly);
      return {
        executable: PATHS.python,
        args,
        env: buildMergeEnvironment("legacy", context),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged"),
        "SAEHD 合成已结束，但 merged 目录没有图片",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
        "SAEHD 合成已结束，但 merged_mask 目录没有图片",
      );
    },
  },
  "encode.mp4": {
    id: "encode.mp4",
    label: "导出 MP4",
    shortLabel: "MP4 导出",
    description: "依次编码 result.mp4（含原视频音频）和无损 result_mask.mp4。",
    profile: "current",
    category: "encode",
    stage: "encode",
    side: "dst",
    interactive: true,
    parameters: [
      {
        id: "bitrate",
        label: "视频码率",
        type: "number",
        default: 16,
        min: 1,
        max: 200,
        integer: true,
        suffix: "Mbps",
      },
    ],
    controls: [],
    locks: ["workspace:data_dst_merged", "workspace:result"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireFile(
        path.join(PATHS.serverDirectory, "encode-mp4.mjs"),
        "Web Runtime 编码器入口不存在",
      );
      const targetVideo = await findWorkspaceVideo("data_dst");
      if (!targetVideo) {
        throw new CommandValidationError(
          "未找到 workspace/data_dst.* 参考视频",
          "INPUT_MISSING",
          { path: path.join(PATHS.workspaceRoot, "data_dst.*") },
        );
      }
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged"),
        "merged 图片序列不存在或为空",
      );
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst", "merged_mask"),
        "merged_mask 图片序列不存在或为空",
      );
    },
    build(context) {
      return {
        executable: process.execPath,
        args: [
          path.join(PATHS.serverDirectory, "encode-mp4.mjs"),
          "standard",
          String(context.parameters.bitrate ?? ""),
        ],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireNonEmptyFile(
        path.join(PATHS.workspaceRoot, "result.mp4"),
        "编码已结束，但 result.mp4 不存在或为空",
      );
      await requireNonEmptyFile(
        path.join(PATHS.workspaceRoot, "result_mask.mp4"),
        "编码已结束，但 result_mask.mp4 不存在或为空",
      );
    },
  },
  "encode.mp4_lossless": {
    id: "encode.mp4_lossless",
    label: "导出无损 MP4",
    shortLabel: "无损 MP4",
    description: "以无损模式依次编码 result.mp4 和 result_mask.mp4。",
    profile: "current",
    category: "encode",
    stage: "encode",
    side: "dst",
    interactive: true,
    parameters: [],
    controls: [],
    locks: ["workspace:data_dst_merged", "workspace:result"],
    async preflight() {
      await definitions["encode.mp4"].preflight();
    },
    build() {
      return {
        executable: process.execPath,
        args: [path.join(PATHS.serverDirectory, "encode-mp4.mjs"), "lossless"],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await definitions["encode.mp4"].postflight();
    },
  },
  ...createDatasetUtilityDefinitions(),
  ...createXsegUtilityDefinitions(),
  "video.cut_src": buildVideoCut("src"),
  "video.cut_dst": buildVideoCut("dst"),
  "dst.denoise_frames": {
    id: "dst.denoise_frames",
    label: "降噪 DST 图片帧",
    shortLabel: "DST 降噪",
    description: "使用 DFL 视频工具对 data_dst 图片序列做时域降噪。",
    profile: "current",
    category: "video",
    stage: "frames",
    side: "dst",
    interactive: true,
    parameters: DENOISE_PARAMETERS,
    controls: [],
    locks: ["workspace:data_dst"],
    async preflight() {
      await requireFile(PATHS.python, "内置 Python 不存在");
      await requireFile(PATHS.currentMain, "current DeepFaceLab 入口不存在");
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst"),
        "DST 图片帧不存在或为空",
      );
    },
    build(context) {
      return {
        executable: PATHS.python,
        args: [
          PATHS.currentMain,
          "videoed",
          "denoise-image-sequence",
          "--input-dir",
          path.join(PATHS.workspaceRoot, "data_dst"),
          "--factor",
          String(context.parameters.factor),
        ],
        env: buildDflEnvironment("current"),
      };
    },
    async postflight() {
      await requireDirectoryWithFiles(
        path.join(PATHS.workspaceRoot, "data_dst"),
        "DST 降噪结束，但图片帧目录为空",
      );
    },
  },
  "train.me": buildCurrentTrainer("ME", "ME"),
  "train.q384": buildCurrentTrainer("Q384", "Quick384", "pretrain_Quick384"),
  "train.q512": buildCurrentTrainer("Q512", "Quick512", "pretrain_Quick512"),
  "export.dfm_me": buildModelExport("ME", "current", "ME"),
  "export.dfm_q384": buildModelExport("Q384", "current", "Quick384"),
  "export.dfm_q512": buildModelExport("Q512", "current", "Quick512"),
  "export.dfm_saehd": buildModelExport("SAEHD", "legacy", "SAEHD"),
  "merge.amp": buildModelMerge("AMP", "current", "AMP"),
  "merge.me": buildModelMerge("ME", "current", "ME"),
  "merge.q384": buildModelMerge("Q384", "current", "Quick384"),
  "merge.q512": buildModelMerge("Q512", "current", "Quick512"),
  "encode.avi": buildAdditionalEncode("encode.avi", "导出 AVI", "avi", "avi"),
  "encode.mov_lossless": buildAdditionalEncode(
    "encode.mov_lossless",
    "导出无损 MOV",
    "mov-lossless",
    "mov",
  ),
});

export function listCommands() {
  return Object.values(definitions).map((definition) => ({
    id: definition.id,
    label: definition.label,
    shortLabel: definition.shortLabel,
    description: definition.description,
    profile: definition.profile,
    category: definition.category,
    stage: definition.stage,
    side: definition.side,
    interactive: definition.interactive,
    parameters: definition.parameters ?? [],
    controls: definition.controls,
    locks: definition.locks,
  }));
}

function requireDefinition(commandId) {
  if (typeof commandId !== "string" || !Object.hasOwn(definitions, commandId)) {
    throw new CommandValidationError("不支持的命令", "COMMAND_NOT_ALLOWED");
  }
  return definitions[commandId];
}

export async function preflightCommand(commandId, context = {}) {
  const definition = requireDefinition(commandId);
  const result = await definition.preflight(context);
  return { definition, result };
}

function validateParameterValue(schema, value) {
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new CommandValidationError(`${schema.label} 必须是布尔值`, "PARAMETER_INVALID");
    }
    return value;
  }

  if (schema.type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) {
      throw new CommandValidationError(`${schema.label} 必须是数字`, "PARAMETER_INVALID");
    }
    if (schema.integer && !Number.isInteger(number)) {
      throw new CommandValidationError(`${schema.label} 必须是整数`, "PARAMETER_INVALID");
    }
    if (schema.min !== undefined && number < schema.min) {
      throw new CommandValidationError(
        `${schema.label} 不能小于 ${schema.min}`,
        "PARAMETER_OUT_OF_RANGE",
      );
    }
    if (schema.max !== undefined && number > schema.max) {
      throw new CommandValidationError(
        `${schema.label} 不能大于 ${schema.max}`,
        "PARAMETER_OUT_OF_RANGE",
      );
    }
    return number;
  }

  if (schema.type === "select") {
    const option = schema.options.find((candidate) => String(candidate.value) === String(value));
    if (!option) {
      throw new CommandValidationError(`${schema.label} 的选项不受支持`, "PARAMETER_INVALID");
    }
    return option.value;
  }

  if (schema.type === "text") {
    if (typeof value !== "string" || value.length > 120) {
      throw new CommandValidationError(`${schema.label} 的格式不合法`, "PARAMETER_INVALID");
    }
    if (value === "") return value;
    if (schema.format === "gpu-indexes" && !/^\d+(,\d+)*$/.test(value)) {
      throw new CommandValidationError(
        `${schema.label} 只接受 0 或 0,1 这类格式`,
        "PARAMETER_INVALID",
      );
    }
    if (
      schema.format === "time-code"
      && !/^(?:\d{1,3}:)?[0-5]?\d:[0-5]\d(?:\.\d{1,3})?$/.test(value)
    ) {
      throw new CommandValidationError(
        `${schema.label} 需使用 HH:MM:SS.mmm 格式`,
        "PARAMETER_INVALID",
      );
    }
    if (
      schema.format === "model-name"
      && (/[/\\:*?"<>|\u0000-\u001f]/.test(value) || value.trim() !== value)
    ) {
      throw new CommandValidationError(
        `${schema.label} 包含不允许的字符`,
        "PARAMETER_INVALID",
      );
    }
    return value;
  }

  throw new CommandValidationError(`未知参数类型：${schema.type}`, "PARAMETER_SCHEMA_INVALID");
}

export function validateCommandParameters(commandId, rawParameters = {}, launchMode = "cli") {
  const definition = requireDefinition(commandId);
  if (!["cli", "guided"].includes(launchMode)) {
    throw new CommandValidationError("启动模式不受支持", "LAUNCH_MODE_INVALID");
  }
  if (rawParameters === null || typeof rawParameters !== "object" || Array.isArray(rawParameters)) {
    throw new CommandValidationError("任务参数必须是对象", "PARAMETERS_INVALID");
  }
  const schemas = definition.parameters ?? [];
  const allowedIds = new Set(schemas.map((schema) => schema.id));
  const unknown = Object.keys(rawParameters).find((key) => !allowedIds.has(key));
  if (unknown) {
    throw new CommandValidationError(`不支持的任务参数：${unknown}`, "PARAMETER_NOT_ALLOWED");
  }
  if (launchMode === "cli") return {};

  return Object.fromEntries(schemas.map((schema) => {
    const value = Object.hasOwn(rawParameters, schema.id)
      ? rawParameters[schema.id]
      : schema.default;
    return [schema.id, validateParameterValue(schema, value)];
  }));
}

export async function prepareCommand(commandId, options = {}) {
  const launchMode = options.launchMode ?? "cli";
  const parameters = validateCommandParameters(
    commandId,
    options.parameters ?? {},
    launchMode,
  );
  const { definition, result: preflight } = await preflightCommand(commandId, {
    launchMode,
    parameters,
    trainingEvaluationManager: options.trainingEvaluationManager,
  });
  return { definition, launchMode, parameters, preflight };
}

export function buildCommand(definition, context) {
  const launch = definition.build(context);
  return {
    definition,
    launch: {
      ...launch,
      cwd: PATHS.repositoryRoot,
    },
  };
}

export async function resolveCommand(commandId, context) {
  const { definition, result: preflight } = await preflightCommand(commandId, context);
  return buildCommand(definition, { ...context, preflight });
}

export function getCommandDefinition(commandId) {
  return definitions[commandId] ?? null;
}

export function formatCommand(executable, args) {
  const quote = (value) => (/\s|"/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
  return [executable, ...args].map(quote).join(" ");
}
