export const workflowStages = [
  { id: "material", label: "素材", state: "waiting" },
  { id: "frames", label: "提帧", state: "waiting" },
  { id: "faces", label: "切脸", state: "waiting" },
  { id: "clean", label: "清洗", state: "waiting" },
  { id: "mask", label: "遮罩", state: "waiting" },
  { id: "train", label: "训练", state: "waiting" },
  { id: "diagnose", label: "诊断", state: "waiting" },
  { id: "merge", label: "合成", state: "waiting" },
  { id: "encode", label: "封装", state: "waiting" },
];

export const workflowStageDestinations = Object.freeze({
  material: { nav: "video" },
  frames: { nav: "workflow.frames", task: "extract" },
  faces: { nav: "workflow.faces", task: "src" },
  clean: { nav: "workflow.clean", task: "sort" },
  mask: { nav: "xseg", task: "xseg" },
  train: { nav: "overview", task: "saehd" },
  diagnose: { nav: "diagnostics", task: "diagnose" },
  merge: { nav: "merge", task: "merge" },
  encode: { nav: "export", task: "export" },
});

export const navigationWorkflowStages = Object.freeze({
  overview: "train",
  video: "material",
  src: "faces",
  dst: "faces",
  xseg: "mask",
  training: "train",
  diagnostics: "diagnose",
  merge: "merge",
  export: "encode",
});

export const pipelineTasks = [
  { id: "extract", index: 1, label: "提取 SRC / DST 视频帧", time: "未运行", state: "waiting", tone: "default", supported: true },
  { id: "src", index: 2, label: "提取 SRC 人脸", time: "未运行", state: "waiting", tone: "default", supported: true },
  { id: "dst", index: 3, label: "提取 DST 人脸", time: "未运行", state: "waiting", tone: "default", supported: true },
  { id: "sort", index: 4, label: "SRC / DST aligned 排序", time: "未运行", state: "waiting", tone: "default", supported: true },
  { id: "xseg", index: 5, label: "XSeg 训练与应用", time: "未运行", state: "waiting", tone: "violet", supported: true },
  { id: "saehd", index: 6, label: "训练 SAEHD", time: "未运行", state: "waiting", tone: "green", supported: true },
  { id: "diagnose", index: 7, label: "质量诊断", time: "等待评估快照", state: "waiting", tone: "green", supported: true },
  { id: "merge", index: 8, label: "合成 SAEHD 人脸", time: "未运行", state: "waiting", tone: "amber", supported: true },
  { id: "export", index: 9, label: "导出 MP4", time: "未运行", state: "waiting", tone: "amber", supported: true },
];

export const taskTypes = [
  { id: "src.extract_frames", label: "提取 SRC 视频帧" },
  { id: "dst.extract_frames", label: "提取 DST 视频帧" },
  { id: "src.extract_faces", label: "提取 SRC 人脸" },
  { id: "dst.extract_faces", label: "提取 DST 人脸" },
  { id: "src.sort_faces", label: "排序 SRC aligned" },
  { id: "dst.sort_faces", label: "排序 DST aligned" },
  { id: "xseg.train", label: "训练 XSeg" },
  { id: "xseg.apply_src", label: "应用 XSeg 到 SRC" },
  { id: "xseg.apply_dst", label: "应用 XSeg 到 DST" },
  { id: "train.saehd", label: "训练 SAEHD" },
  { id: "merge.saehd", label: "合成 SAEHD 人脸" },
  { id: "encode.mp4", label: "导出 MP4" },
  { id: "encode.mp4_lossless", label: "导出无损 MP4" },
];

export const modelOptions = ["SAEHD"];
