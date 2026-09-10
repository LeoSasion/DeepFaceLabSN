export const activeJobStates = new Set(["queued", "starting", "running", "waiting_input", "stopping"]);

export function jobPresentation(job) {
  if (job?.state === "cancelled") {
    if (job.stopReason === "safe-stop-before-start") return { label: "启动前已停止", tone: "muted" };
    if (job.stopReason === "safe-stop-timeout") return { label: "停止超时，保存未确认", tone: "amber" };
    if (job.stopReason === "force-kill") return { label: "已强制停止", tone: "amber" };
    if (job.stopReason === "safe-stop") return { label: "已安全停止", tone: "green" };
    return { label: "已停止", tone: "muted" };
  }
  if (job?.state === "stopping" && ["force-kill", "safe-stop-timeout", "safe-stop-before-start"].includes(job.stopReason)) {
    return { label: "正在停止", tone: "amber" };
  }
  const labels = {
    queued: "排队中", starting: "启动中", running: "运行中", waiting_input: "等待输入",
    stopping: "保存并停止中", succeeded: "已完成", failed: "失败", orphaned: "连接已丢失", idle: "等待任务",
  };
  const state = job?.state ?? "idle";
  return {
    label: labels[state] ?? state,
    tone: ["failed", "orphaned"].includes(state) ? "danger"
      : ["waiting_input", "stopping"].includes(state) ? "amber"
        : state === "idle" ? "muted" : "green",
  };
}

export function isFailedJob(job) {
  return ["failed", "orphaned"].includes(job?.state);
}

export function mergeMetricHistory(current, events) {
  const valid = (iteration, srcLoss, dstLoss) => Number.isInteger(iteration) && iteration >= 0
    && [srcLoss, dstLoss].every(value => Number.isFinite(value) && value >= 0);
  const points = new Map(current.filter(point => valid(point.iteration, point.gLoss, point.dLoss))
    .map(point => [point.iteration, point]));
  for (const event of events) {
    if (event.type !== "job.metric") continue;
    const { iteration, srcLoss, dstLoss } = event.payload ?? {};
    if (!valid(iteration, srcLoss, dstLoss)) continue;
    points.set(iteration, { iteration, gLoss: srcLoss, dLoss: dstLoss });
  }
  return [...points.values()].sort((a, b) => a.iteration - b.iteration).slice(-400);
}
