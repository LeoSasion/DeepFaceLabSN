import { withRequestDeadline } from "./request-deadline.js";

const confirmedStates = new Set(["cancelling", "cancelled", "succeeded", "failed", "interrupted"]);

export async function cancelOperationAndCheck(id, { cancel, read, signal, timeoutMs = 10_000 }) {
  try {
    const operation = await withRequestDeadline(activeSignal => cancel(id, { signal: activeSignal }), { signal, timeoutMs });
    if (operation?.id === id && confirmedStates.has(operation.status)) return operation;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.status >= 400 && error.status < 500 && ![408, 425].includes(error.status)) throw error;
  }
  // The cancel may have been accepted before the response was lost. Read once;
  // only an explicit subsequent action may submit another cancellation.
  let operation;
  try {
    operation = await withRequestDeadline(activeSignal => read(id, { signal: activeSignal }), { signal, timeoutMs });
    if (operation?.id === id && confirmedStates.has(operation.status)) return operation;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
  }
  throw Object.assign(new Error(operation?.id === id && ["queued", "running"].includes(operation.status)
    ? "取消尚未确认；操作仍在运行，可再次取消。"
    : "取消结果尚未确认，请先检查后台进度。"), { code: "OPERATION_CANCEL_UNCONFIRMED" });
}
