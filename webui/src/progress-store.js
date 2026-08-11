const DEFAULT_SHOW_DELAY_MS = 240;
const DEFAULT_MIN_VISIBLE_MS = 520;
const DEFAULT_EXIT_MS = 160;

function toFiniteNumber(value) {
  if (
    value == null
    || typeof value === "boolean"
    || (typeof value === "string" && value.trim() === "")
  ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function deriveProgressValue(value, current, total) {
  const explicit = toFiniteNumber(value);
  if (explicit != null) return Math.max(0, Math.min(100, explicit));

  const resolvedCurrent = toFiniteNumber(current);
  const resolvedTotal = toFiniteNumber(total);
  if (resolvedCurrent == null || resolvedTotal == null || resolvedTotal <= 0) return null;
  return Math.max(0, Math.min(100, (resolvedCurrent / resolvedTotal) * 100));
}

function publicEntry(entry) {
  const {
    showTimer: _showTimer,
    removeTimer: _removeTimer,
    ...value
  } = entry;
  return value;
}

export function createProgressStore({
  now = () => Date.now(),
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (timer) => window.clearTimeout(timer),
  showDelayMs = DEFAULT_SHOW_DELAY_MS,
  minVisibleMs = DEFAULT_MIN_VISIBLE_MS,
  exitMs = DEFAULT_EXIT_MS,
} = {}) {
  const entries = new Map();
  const listeners = new Set();
  let snapshot = [];

  const publish = () => {
    snapshot = [...entries.values()]
      .filter((entry) => entry.visible)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicEntry);
    listeners.forEach((listener) => listener());
  };

  const clearEntryTimers = (entry) => {
    if (entry.showTimer != null) cancel(entry.showTimer);
    if (entry.removeTimer != null) cancel(entry.removeTimer);
    entry.showTimer = null;
    entry.removeTimer = null;
  };

  const show = (id) => {
    const entry = entries.get(id);
    if (!entry || entry.visible) return;
    entry.showTimer = null;
    entry.visible = true;
    entry.visibleAt = now();
    entry.phase = "active";
    publish();
  };

  const register = (id, data) => {
    const existing = entries.get(id);
    if (existing) {
      if (existing.removeTimer != null) cancel(existing.removeTimer);
      existing.removeTimer = null;
      existing.phase = "active";
      existing.updatedAt = now();
      Object.assign(existing, data);
      if (existing.visible) publish();
      return;
    }

    const createdAt = now();
    const entry = {
      id,
      ...data,
      createdAt,
      updatedAt: createdAt,
      visible: false,
      visibleAt: null,
      phase: "pending",
      showTimer: null,
      removeTimer: null,
    };
    entries.set(id, entry);
    const delay = Number.isFinite(data.showDelayMs) ? Math.max(0, data.showDelayMs) : showDelayMs;
    entry.showTimer = schedule(() => show(id), delay);
  };

  const update = (id, data) => {
    const entry = entries.get(id);
    if (!entry) {
      register(id, data);
      return;
    }
    Object.assign(entry, data, { updatedAt: now() });
    if (entry.visible) publish();
  };

  const unregister = (id) => {
    const entry = entries.get(id);
    if (!entry) return;

    if (!entry.visible) {
      clearEntryTimers(entry);
      entries.delete(id);
      return;
    }

    if (entry.showTimer != null) cancel(entry.showTimer);
    entry.showTimer = null;
    const visibleFor = Math.max(0, now() - entry.visibleAt);
    const remaining = Math.max(0, minVisibleMs - visibleFor);
    entry.removeTimer = schedule(() => {
      const current = entries.get(id);
      if (!current) return;
      current.phase = "leaving";
      current.removeTimer = schedule(() => {
        const latest = entries.get(id);
        if (!latest || latest.phase !== "leaving") return;
        entries.delete(id);
        publish();
      }, exitMs);
      publish();
    }, remaining);
  };

  const destroy = () => {
    entries.forEach(clearEntryTimers);
    entries.clear();
    publish();
  };

  return {
    register,
    update,
    unregister,
    destroy,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    getServerSnapshot() {
      return [];
    },
  };
}

export function selectVisibleProgressTasks(entries, maximum = 3) {
  const grouped = new Map();
  entries.forEach((entry) => {
    const key = entry.operationKey ? `operation:${entry.operationKey}` : `instance:${entry.id}`;
    const existing = grouped.get(key);
    const existingIsActive = existing?.phase !== "leaving";
    const entryIsActive = entry.phase !== "leaving";
    if (
      !existing
      || (!existingIsActive && entryIsActive)
      || (existingIsActive === entryIsActive && entry.updatedAt >= existing.updatedAt)
    ) {
      grouped.set(key, entry);
    }
  });

  const ordered = [...grouped.values()].sort((left, right) => left.createdAt - right.createdAt);
  const limit = Math.max(1, Number(maximum) || 1);
  return {
    tasks: ordered.slice(-limit),
    overflow: Math.max(0, ordered.length - limit),
  };
}
