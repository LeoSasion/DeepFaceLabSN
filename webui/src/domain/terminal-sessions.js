export const TERMINAL_SESSION_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
]);

export const ACTIVE_SESSION_STATES = new Set([
  "queued",
  "starting",
  "running",
  "waiting_input",
  "stopping",
]);

export const DEFAULT_TERMINAL_TAB_LIMIT = 7;

export function isTerminalSession(job) {
  return TERMINAL_SESSION_STATES.has(job?.state);
}

export function selectTerminalTabs(
  jobs,
  hiddenJobIds,
  {
    limit = DEFAULT_TERMINAL_TAB_LIMIT,
    selectedJobId = null,
    showAll = false,
  } = {},
) {
  const hidden = hiddenJobIds instanceof Set ? hiddenJobIds : new Set(hiddenJobIds);
  const available = jobs.filter((job) => !hidden.has(job.id));
  if (showAll || available.length <= limit) return available;

  const visibleIds = new Set(available.slice(0, limit).map((job) => job.id));
  for (const job of available) {
    if (ACTIVE_SESSION_STATES.has(job.state) || job.id === selectedJobId) {
      visibleIds.add(job.id);
    }
  }
  return available.filter((job) => visibleIds.has(job.id));
}

export function findAdjacentTerminalJobId(jobs, hiddenJobIds, closingJobId) {
  const hidden = hiddenJobIds instanceof Set ? hiddenJobIds : new Set(hiddenJobIds);
  const closingIndex = jobs.findIndex((job) => job.id === closingJobId);
  if (closingIndex < 0) return null;

  const isAvailable = (job) => job && job.id !== closingJobId && !hidden.has(job.id);
  const next = jobs.slice(closingIndex + 1).find(isAvailable);
  if (next) return next.id;
  return jobs.slice(0, closingIndex).reverse().find(isAvailable)?.id ?? null;
}
