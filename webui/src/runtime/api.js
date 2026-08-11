async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: { message: `本地服务返回了无法解析的响应（HTTP ${response.status}）` },
  }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error?.message ?? `请求失败（HTTP ${response.status}）`);
    error.code = payload.error?.code ?? "REQUEST_FAILED";
    error.details = payload.error?.details;
    throw error;
  }
  return payload.data;
}

async function uploadVideoWithFetch(side, file, replace) {
  const query = replace ? "?replace=1" : "";
  const response = await fetch(`/api/workspace/import/${side}${query}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: { message: `视频导入返回了无法解析的响应（HTTP ${response.status}）` },
  }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error?.message ?? `视频导入失败（HTTP ${response.status}）`);
    error.code = payload.error?.code ?? "IMPORT_FAILED";
    error.details = payload.error?.details;
    throw error;
  }
  return payload.data;
}

async function uploadVideo(side, file, { replace = false, onProgress } = {}) {
  if (typeof XMLHttpRequest === "undefined" || typeof onProgress !== "function") {
    return uploadVideoWithFetch(side, file, replace);
  }

  const query = replace ? "?replace=1" : "";
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/workspace/import/${side}${query}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      onProgress({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
        percent: event.lengthComputable && event.total > 0
          ? (event.loaded / event.total) * 100
          : null,
      });
    });
    request.addEventListener("load", () => {
      let payload;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        payload = { ok: false, error: { message: `视频导入返回了无法解析的响应（HTTP ${request.status}）` } };
      }
      if (request.status < 200 || request.status >= 300 || payload.ok === false) {
        const error = new Error(payload.error?.message ?? `视频导入失败（HTTP ${request.status}）`);
        error.code = payload.error?.code ?? "IMPORT_FAILED";
        error.details = payload.error?.details;
        reject(error);
        return;
      }
      onProgress({ loaded: file.size, total: file.size, percent: 100 });
      resolve(payload.data);
    });
    request.addEventListener("error", () => reject(new Error("视频上传连接中断，请检查本地服务后重试")));
    request.addEventListener("abort", () => reject(new Error("视频上传已取消")));
    request.send(file);
  });
}

export const runtimeApi = {
  health: () => request("/api/health"),
  telemetry: () => request("/api/telemetry"),
  commands: () => request("/api/commands"),
  workspace: () => request("/api/workspace"),
  projects: () => request("/api/projects"),
  createProject: (payload) => request("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  activateProject: (id) => request(`/api/projects/${encodeURIComponent(id)}/activate`, {
    method: "POST",
  }),
  alignedAssets: (side, { offset = 0, limit = 60 } = {}) => request(
    `/api/assets/${side}/aligned?offset=${offset}&limit=${limit}`,
  ),
  alignedPoseAtlas: (side) => request(`/api/assets/${side}/pose-atlas`),
  trainingEvaluationManifests: (modelKey) => request(
    `/api/training-evaluations/${encodeURIComponent(modelKey)}/manifests`,
  ),
  trainingEvaluationSnapshots: (modelKey) => request(
    `/api/training-evaluations/${encodeURIComponent(modelKey)}/snapshots`,
  ),
  trainingEvaluationSnapshot: (modelKey, snapshotId) => request(
    `/api/training-evaluations/${encodeURIComponent(modelKey)}`
      + `/snapshots/${encodeURIComponent(snapshotId)}`,
  ),
  alignedAudit: (side, { refresh = false, offset = 0, limit = 120 } = {}) => request(
    `/api/tools/assets/${side}/audit?offset=${offset}&limit=${limit}${refresh ? "&refresh=1" : ""}`,
  ),
  alignedSimilarity: (side, { refresh = false, threshold = 0.86, limit = 500 } = {}) => request(
    `/api/tools/assets/${side}/similarity?threshold=${encodeURIComponent(threshold)}`
      + `&limit=${encodeURIComponent(limit)}${refresh ? "&refresh=1" : ""}`,
  ),
  alignedPack: (side, { refresh = false } = {}) => request(
    `/api/tools/assets/${side}/pack${refresh ? "?refresh=1" : ""}`,
  ),
  extractionCoverage: (side, { refresh = false, offset = 0, limit = 120 } = {}) => request(
    `/api/tools/assets/${side}/coverage?offset=${offset}&limit=${limit}${refresh ? "&refresh=1" : ""}`,
  ),
  mergeReview: ({ offset = 0, limit = 120 } = {}) => request(
    `/api/tools/merge-review?offset=${offset}&limit=${limit}`,
  ),
  exportPreflight: () => request("/api/tools/export-preflight"),
  alignedAnnotation: (side, name) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/annotation`,
  ),
  saveAlignedAnnotation: (side, name, polygons) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/annotation`,
    {
      method: "PUT",
      body: JSON.stringify({ polygons }),
    },
  ),
  previewAlignedRepair: (side, name, landmarks) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/alignment-preview`,
    { method: "POST", body: JSON.stringify({ landmarks }) },
  ),
  applyAlignedRepair: (side, name, landmarks) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/alignment-apply`,
    { method: "POST", body: JSON.stringify({ landmarks }) },
  ),
  alignedRepairBackups: (side) => request(`/api/assets/${side}/alignment-backups`),
  restoreAlignedRepair: (side, token, name) => request(
    `/api/assets/${side}/alignment-backups/${encodeURIComponent(token)}/${encodeURIComponent(name)}/restore`,
    { method: "POST" },
  ),
  quarantineAligned: (side, name) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/quarantine`,
    { method: "POST" },
  ),
  quarantineAlignedBatch: (side, names) => request(
    `/api/assets/${side}/aligned/quarantine-batch`,
    { method: "POST", body: JSON.stringify({ names }) },
  ),
  alignedQuarantine: (side, { offset = 0, limit = 60 } = {}) => request(
    `/api/assets/${side}/quarantine?offset=${offset}&limit=${limit}`,
  ),
  quarantinedAnnotation: (side, token, name) => request(
    `/api/assets/${side}/quarantine/${encodeURIComponent(token)}`
      + `/${encodeURIComponent(name)}/annotation`,
  ),
  restoreAligned: (side, token, name) => request(
    `/api/assets/${side}/quarantine/${encodeURIComponent(token)}/${encodeURIComponent(name)}/restore`,
    { method: "POST" },
  ),
  importVideo: uploadVideo,
  videoTimeline: (side) => request(`/api/tools/video/${side}/timeline`),
  detectVideoScenes: (side, threshold) => request(`/api/tools/video/${side}/detect-scenes`, {
    method: "POST",
    body: JSON.stringify({ threshold }),
  }),
  saveVideoSegments: (side, segments) => request(`/api/tools/video/${side}/segments`, {
    method: "PUT",
    body: JSON.stringify({ segments }),
  }),
  extractVideoSegments: (side, segments, fps = 0) => request(
    `/api/tools/video/${side}/extract-segments`,
    { method: "POST", body: JSON.stringify({ segments, fps }) },
  ),
  frameArchives: (side) => request(`/api/tools/video/${side}/frame-archives`),
  restoreFrameArchive: (side, token) => request(
    `/api/tools/video/${side}/frame-archives/${encodeURIComponent(token)}/restore`,
    { method: "POST" },
  ),
  archiveCompletedJobs: () => request("/api/jobs/archive-completed", { method: "POST" }),
  preflight: (commandId, options = {}) => request(
    `/api/commands/${encodeURIComponent(commandId)}/preflight`,
    {
      method: "POST",
      body: JSON.stringify(options),
    },
  ),
  jobs: () => request("/api/jobs"),
  events: (jobId, after = 0) => request(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`),
  start: (commandId, options = {}) => request("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ commandId, ...options }),
  }),
  input: (jobId, input) => request(`/api/jobs/${encodeURIComponent(jobId)}/input`, {
    method: "POST",
    body: JSON.stringify({ input }),
  }),
  control: (jobId, operation) => request(`/api/jobs/${encodeURIComponent(jobId)}/control`, {
    method: "POST",
    body: JSON.stringify({ operation }),
  }),
  retry: (jobId) => request(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
};

export function runtimeWebSocketUrl(jobId, after = 0) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ jobId, after: String(after) });
  return `${protocol}//${window.location.host}/ws?${query}`;
}
