function aborted(signal) {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(aborted(signal));
  }
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(aborted(signal)); };
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return; }
    const stop = () => { clearTimeout(timer); reject(aborted(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function withinDeadline(action, signal, timeoutMs, code) {
  const controller = new AbortController();
  const stop = () => controller.abort(aborted(signal));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const error = Object.assign(new Error("尚未确认目标项目就绪，可继续检查服务状态"), { code });
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  try {
    if (controller.signal.aborted) throw aborted(controller.signal);
    return await abortable(action(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}

export async function waitForProject(targetId, {
  readHealth, signal, onStatus = () => {}, timeoutMs = 45_000, intervalMs = 800, delay = pause,
}) {
  return withinDeadline(async activeSignal => {
    while (!activeSignal.aborted) {
      try {
        const health = await abortable(readHealth({ signal: activeSignal }), activeSignal);
        if (activeSignal.aborted) throw aborted(activeSignal);
        if (health.project?.id === targetId && health.runtime?.workspaceAvailable === true) return health;
        onStatus({ phase: "waiting", runningId: health.project?.id ?? null });
      } catch (error) {
        if (activeSignal.aborted) throw aborted(activeSignal);
        onStatus({ phase: "reconnecting" });
      }
      await abortable(delay(intervalMs, activeSignal), activeSignal);
    }
    throw aborted(activeSignal);
  }, signal, timeoutMs, "PROJECT_SWITCH_UNCONFIRMED");
}

export async function switchProjectAndWait(targetId, {
  activate, readHealth, signal, onStatus = () => {}, checkOnly = false,
  activationTimeoutMs = 10_000, ...waitOptions
}) {
  if (signal?.aborted) throw aborted(signal);
  if (!checkOnly) {
    onStatus({ phase: "requesting" });
    try {
      await withinDeadline(activeSignal => activate(targetId, { signal: activeSignal }), signal,
        activationTimeoutMs, "PROJECT_SWITCH_RESPONSE_LOST");
    } catch (error) {
      if (signal?.aborted) throw aborted(signal);
      // A lost response may follow a committed project selection. Check only;
      // never repeat the activation request without a new explicit user action.
      if (error.status >= 400 && error.status < 500 && ![408, 425].includes(error.status)) throw error;
    }
  }
  return waitForProject(targetId, { readHealth, signal, onStatus, ...waitOptions });
}
