import { mergeMetricHistory } from "../domain/job-presentation.js";

// The events endpoint returns a bounded recent tail, not numbered pages. Advance
// only from sequences actually received, and retain already loaded metric points.
export function createTrainingHistoryReader({
  readEvents,
  onChange,
  active = false,
  points = [],
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelSchedule = timer => globalThis.clearTimeout(timer),
}) {
  let cursor = 0;
  let cancelled = false;
  let inFlight = false;
  let timer;
  let failures = 0;

  const refresh = async () => {
    if (cancelled || inFlight) return;
    cancelSchedule(timer);
    timer = undefined;
    inFlight = true;
    let retryDelay = null;
    try {
      const events = await readEvents(cursor);
      if (cancelled) return;
      for (const event of events) {
        if (Number.isInteger(event.sequence)) cursor = Math.max(cursor, event.sequence);
      }
      points = mergeMetricHistory(points, events);
      failures = 0;
      onChange({ points, error: null });
      if (active) retryDelay = 4000;
    } catch (error) {
      if (cancelled) return;
      failures += 1;
      onChange({ points, error: error.message });
      // Completed jobs also recover from temporary service loss. A missing or
      // archived job waits for an explicit retry instead of polling forever.
      if (error.retryable !== false && ![400, 401, 403, 404, 410].includes(error.status)) {
        retryDelay = Math.min(30_000, 4000 * 2 ** Math.min(failures - 1, 3));
      }
    } finally {
      inFlight = false;
      if (!cancelled && retryDelay !== null) timer = schedule(refresh, retryDelay);
    }
  };

  return {
    refresh,
    dispose() {
      cancelled = true;
      cancelSchedule(timer);
    },
  };
}
