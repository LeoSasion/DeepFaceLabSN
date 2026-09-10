export function preflightRecovery(error, command, t) {
  if (!error || !command) return null;
  if (["PARAMETER_INVALID", "PARAMETERS_INVALID", "PARAMETER_NOT_ALLOWED"].includes(error.code)) {
    return { target: "parameters", label: t("返回修改参数") };
  }
  if (["RUNTIME_MISSING", "PROJECT_INCOMPLETE", "BUNDLED_MODEL_MISSING"].includes(error.code)) {
    return { target: "settings", label: t("检查运行环境与修复说明") };
  }
  if (error.code === "MODEL_MISSING") {
    return { target: "training", label: t("检查训练模型") };
  }
  if (error.code === "XSEG_LABELS_MISSING") {
    return { target: "xseg", label: t("打开 XSeg 标注") };
  }
  if (error.code === "RESOURCE_LOCKED") {
    return { target: "console", label: t("查看占用任务") };
  }
  if (["INPUT_MISSING", "INPUT_EMPTY", "OUTPUT_MISSING", "OUTPUT_EMPTY"].includes(error.code)) {
    const targetByStage = {
      material: ["workspace", "打开工作区导入素材"],
      frames: ["workspace", "打开工作区导入素材"],
      faces: ["frames", "先提取视频帧"],
      sort: ["faces", "检查 aligned 人脸"],
      mask: ["xseg", "打开 XSeg 标注"],
      train: ["faces", "检查 aligned 人脸"],
      training: ["faces", "检查 aligned 人脸"],
      merge: ["training", "检查训练模型"],
      encode: ["merge", "先完成模型合成"],
    };
    const [target, label] = targetByStage[command.stage] ?? ["workspace", "检查工作区素材"];
    return { target, label: t(label) };
  }
  return { target: "workspace", label: t("检查工作区状态") };
}
