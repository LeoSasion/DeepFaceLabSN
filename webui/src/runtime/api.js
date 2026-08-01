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

async function uploadVideo(side, file, { replace = false } = {}) {
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

export const runtimeApi = {
  health: () => request("/api/health"),
  telemetry: () => request("/api/telemetry"),
  commands: () => request("/api/commands"),
  workspace: () => request("/api/workspace"),
  alignedAssets: (side, { offset = 0, limit = 60 } = {}) => request(
    `/api/assets/${side}/aligned?offset=${offset}&limit=${limit}`,
  ),
  alignedPoseAtlas: (side) => request(`/api/assets/${side}/pose-atlas`),
  alignedAudit: (side, { refresh = false, offset = 0, limit = 120 } = {}) => request(
    `/api/tools/assets/${side}/audit?offset=${offset}&limit=${limit}${refresh ? "&refresh=1" : ""}`,
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
  quarantineAligned: (side, name) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/quarantine`,
    { method: "POST" },
  ),
  alignedQuarantine: (side) => request(`/api/assets/${side}/quarantine`),
  restoreAligned: (side, token, name) => request(
    `/api/assets/${side}/quarantine/${encodeURIComponent(token)}/${encodeURIComponent(name)}/restore`,
    { method: "POST" },
  ),
  importVideo: uploadVideo,
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
