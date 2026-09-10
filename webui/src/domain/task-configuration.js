export function commandModelFamily(command) {
  if (command?.id === "xseg.train") return "XSEG";
  return /^(?:train|merge|export\.dfm)[._](saehd|me|amp|q384|q512)$/i.exec(command?.id ?? "")?.[1].toUpperCase() ?? null;
}

export function taskModels(command, models = []) {
  const family = commandModelFamily(command);
  return models.filter(model => {
    if (!family || model.type?.toUpperCase() !== family) return false;
    if (model.ready === false) return false;
    if (Array.isArray(model.files)) return model.files.some(file => /_data\.dat$/i.test(file));
    // Older runtimes represented the whole XSeg directory as a model name.
    return !(family === "XSEG" && model.name === "xseg_model");
  });
}

export function createTaskConfiguration(command, supplied = {}, models = []) {
  const schemas = command?.parameters ?? [];
  const parameters = Object.fromEntries(schemas.map(schema => [schema.id,
    Object.hasOwn(supplied ?? {}, schema.id) ? supplied[schema.id] : schema.default,
  ]));
  const hasModel = schemas.some(schema => schema.id === "forceModelName");
  const saved = taskModels(command, models);
  let newModel = false;
  if (hasModel && !Object.hasOwn(supplied ?? {}, "forceModelName") && saved.length === 1) {
    parameters.forceModelName = saved[0].name;
    if (Object.hasOwn(parameters, "silentStart")) parameters.silentStart = true;
  }
  if (hasModel && command.category === "training") {
    newModel = parameters.forceModelName
      ? !saved.some(model => model.name === parameters.forceModelName)
      : saved.length === 0 && !Object.hasOwn(supplied ?? {}, "forceModelName");
    if (newModel && Object.hasOwn(parameters, "silentStart")) parameters.silentStart = false;
  }
  if (parameters.cpuOnly && Object.hasOwn(parameters, "gpuIndexes")) parameters.gpuIndexes = "";
  return { parameters, newModel };
}

export function modelNameIssue(name, creating, models = []) {
  if (!creating) return null;
  const value = String(name ?? "");
  if (!value.trim()) return "empty";
  if (value.length > 64 || value.trim() !== value || /[/\\:*?"<>|\u0000-\u001f]/.test(value)) return "invalid";
  if (models.some(model => model.name?.toLocaleLowerCase() === value.toLocaleLowerCase())) return "duplicate";
  return null;
}

export function searchTaskCommands(commands, query = "") {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const content = `${command.label ?? ""} ${command.shortLabel ?? ""} ${command.description ?? ""} ${command.id}`.toLocaleLowerCase();
    return terms.every(term => content.includes(term));
  });
}

// Presentation only: these paths never become executable task arguments.
export function taskOutputLocations(command, workspace = {}) {
  const id = command?.id ?? "";
  const side = ["src", "dst"].includes(command?.side) ? command.side : null;
  if (id === "runtime.prepare_vision") return { paths: [], note: "runtime" };
  if (id === "xseg.train") return { paths: ["xseg_model"] };
  if (["training", "model"].includes(command?.category)) return { paths: ["model"] };
  if (command?.category === "merge") return { paths: ["data_dst/merged", "data_dst/merged_mask"] };
  if (command?.category === "encode") {
    const extension = id === "encode.avi" ? "avi" : id === "encode.mov_lossless" ? "mov" : "mp4";
    return { paths: [`result.${extension}`, `result_mask.${extension}`], note: "overwrite-video" };
  }
  if (side && id.startsWith("video.cut_")) {
    const extension = /\.[a-z0-9]+$/i.exec(workspace.materials?.[side]?.name ?? "")?.[0] ?? ".*";
    return { paths: [`data_${side}_cut${extension}`] };
  }
  if (side && (id.endsWith("extract_frames") || id.endsWith("denoise_frames"))) return { paths: [`data_${side}`] };
  if (side && id.endsWith("faces_enhance")) return { paths: [`data_${side}/aligned_enhanced`], note: "merge-back" };
  if (side && id.endsWith("faces_resize")) return { paths: [`data_${side}/aligned_resized`], note: "merge-back" };
  if (side && id.endsWith("fetch_labels")) return { paths: [`data_${side}/aligned_xseg`] };
  if (side) return { paths: [`data_${side}/aligned`] };
  return { paths: [""] };
}

export function displayWorkspacePath(workspacePath, relativePath) {
  if (!relativePath) return workspacePath;
  const separator = workspacePath?.includes("\\") ? "\\" : "/";
  return `${String(workspacePath ?? "").replace(/[\\/]+$/, "")}${separator}${relativePath.replaceAll("/", separator)}`;
}
