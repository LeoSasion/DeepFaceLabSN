import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconActivityHeartbeat, IconChevronRight } from "@tabler/icons-react";
import { useI18n } from "../i18n.jsx";
import {
  createProgressStore,
  deriveProgressValue,
  selectVisibleProgressTasks,
} from "../progress-store.js";

const HISTORY_STORAGE_KEY = "dfl-webui-progress-history-v1";
const MAX_HISTORY_KEYS = 48;
const MAX_SAMPLES_PER_KEY = 7;
const MIN_RECORDED_DURATION_MS = 1000;
const MAX_RECORDED_DURATION_MS = 6 * 60 * 60 * 1000;
const EMPTY_PROGRESS_SNAPSHOT = [];
const ProgressFeedbackContext = createContext(null);

const subscribeToNothing = () => () => {};
const getEmptyProgressSnapshot = () => EMPTY_PROGRESS_SNAPSHOT;

function clampProgress(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function normalizeHistoryKey(value) {
  const key = typeof value === "string" ? value.trim().slice(0, 96) : "";
  return key || null;
}

function readHistoryStore() {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readDurationSamples(key) {
  if (!key) return [];
  const samples = readHistoryStore()[key]?.samples;
  return Array.isArray(samples)
    ? samples.filter((value) => Number.isFinite(value) && value >= MIN_RECORDED_DURATION_MS)
    : [];
}

function recordDurationSample(key, durationMs) {
  if (
    !key
    || !Number.isFinite(durationMs)
    || durationMs < MIN_RECORDED_DURATION_MS
    || durationMs > MAX_RECORDED_DURATION_MS
    || typeof window === "undefined"
  ) return;
  try {
    const store = readHistoryStore();
    const previous = Array.isArray(store[key]?.samples) ? store[key].samples : [];
    store[key] = {
      samples: [...previous, Math.round(durationMs)].slice(-MAX_SAMPLES_PER_KEY),
      updatedAt: Date.now(),
    };
    const entries = Object.entries(store)
      .sort((left, right) => (right[1]?.updatedAt ?? 0) - (left[1]?.updatedAt ?? 0))
      .slice(0, MAX_HISTORY_KEYS);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Timing history is optional when browser storage is unavailable.
  }
}

function summarizeDurationSamples(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const low = sorted[Math.floor((sorted.length - 1) * 0.25)];
  const high = sorted[Math.ceil((sorted.length - 1) * 0.75)];
  return { lowSeconds: Math.round(low / 1000), highSeconds: Math.round(high / 1000) };
}

function formatClockDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? [hours, minutes, remaining].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, remaining].map((part) => String(part).padStart(2, "0")).join(":");
}

function useProgressClock(historyKey, startedAt) {
  const mountedAtRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const [samples, setSamples] = useState(() => readDurationSamples(historyKey));

  useEffect(() => {
    const mountedAt = Date.now();
    mountedAtRef.current = mountedAt;
    setNow(mountedAt);
    setSamples(readDurationSamples(historyKey));
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
      recordDurationSample(historyKey, Date.now() - mountedAt);
    };
  }, [historyKey]);

  const parsedStartedAt = typeof startedAt === "string" || typeof startedAt === "number"
    ? new Date(startedAt).getTime()
    : Number.NaN;
  const effectiveStartedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : mountedAtRef.current;
  return {
    elapsedSeconds: Math.max(0, (now - effectiveStartedAt) / 1000),
    history: summarizeDurationSamples(samples),
  };
}

function normalizeDomId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "");
}

export function ProgressFeedbackProvider({ children }) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createProgressStore();

  return (
    <ProgressFeedbackContext.Provider value={storeRef.current}>
      {children}
    </ProgressFeedbackContext.Provider>
  );
}

function ProgressHudCard({ entry, compact = false }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const labelId = `progress-hud-label-${normalizeDomId(entry.id)}`;
  const determinate = Number.isFinite(entry.progress);
  const expandable = Boolean(entry.detail || entry.countText);
  const metaText = [entry.countText, entry.timingText].filter(Boolean).join(" · ");
  const accessibleValueText = [
    determinate ? `${Math.round(entry.progress)}%` : t("进行中"),
    entry.countText,
    entry.timingText,
  ].filter(Boolean).join(" · ");

  return (
    <article
      className={`progress-hud-card is-${entry.tone}${compact ? " is-compact" : ""}${expanded ? " is-expanded" : ""}${entry.phase === "leaving" ? " is-leaving" : ""}`}
      aria-busy={entry.phase !== "leaving"}
      aria-labelledby={labelId}
    >
      <span className="visually-hidden" role="status" aria-live="polite">
        {[entry.label, entry.detail].filter(Boolean).join("。")}
      </span>
      <div className="progress-hud-heading">
        <span className="progress-hud-icon" aria-hidden="true">
          <IconActivityHeartbeat size={19} stroke={1.9} />
        </span>
        <div className="progress-hud-copy">
          <strong id={labelId} title={entry.label}>{entry.label}</strong>
          {entry.detail ? <span title={entry.detail}>{entry.detail}</span> : null}
        </div>
        <b className={determinate ? "is-value" : "is-state"}>
          {determinate ? `${Math.round(entry.progress)}%` : t("进行中")}
        </b>
        {expandable ? (
          <button
            className="progress-hud-toggle"
            type="button"
            aria-expanded={expanded}
            aria-label={t(expanded ? "收起进度详情" : "展开进度详情")}
            onClick={() => setExpanded((current) => !current)}
          >
            <IconChevronRight size={18} stroke={1.8} />
          </button>
        ) : <span className="progress-hud-toggle-placeholder" aria-hidden="true" />}
      </div>
      <div
        className={`progress-hud-track${determinate ? " is-determinate" : " is-indeterminate"}`}
        role="progressbar"
        aria-label={entry.label}
        aria-valuemin="0"
        aria-valuemax="100"
        {...(determinate
          ? {
              "aria-valuenow": Math.round(entry.progress),
              "aria-valuetext": accessibleValueText,
            }
          : { "aria-valuetext": accessibleValueText })}
      >
        <span style={determinate ? { width: `${entry.progress}%` } : undefined} />
      </div>
      {metaText ? (
        <div className="progress-hud-footer" aria-hidden="true">
          <span>{entry.countText}</span>
          <small>{entry.timingText}</small>
        </div>
      ) : null}
      {expanded && entry.detail ? (
        <p className="progress-hud-detail">{entry.detail}</p>
      ) : null}
    </article>
  );
}

export function ProgressHud({ maximum = 3 }) {
  const { t } = useI18n();
  const store = useContext(ProgressFeedbackContext);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.getSnapshot ?? getEmptyProgressSnapshot,
    store?.getServerSnapshot ?? getEmptyProgressSnapshot,
  );
  const { tasks, overflow } = useMemo(
    () => selectVisibleProgressTasks(snapshot, maximum),
    [maximum, snapshot],
  );

  if (!store || (!tasks.length && !overflow)) return null;

  return (
    <section className="progress-hud" aria-label={t("后台任务进度")}>
      <div className="progress-hud-list">
        {tasks.map((entry, index) => (
          <ProgressHudCard
            key={entry.id}
            entry={entry}
            compact={tasks.length > 1 && index < tasks.length - 1}
          />
        ))}
      </div>
      {overflow ? (
        <div className="progress-hud-overflow" role="status">
          {t("另有 {count} 项后台任务", { count: overflow })}
        </div>
      ) : null}
    </section>
  );
}

export function LoadingProgress({
  label,
  detail,
  value,
  current,
  total,
  etaSeconds,
  startedAt,
  operationKey,
  rememberDuration = true,
  tone = "green",
  compact = false,
  inline = false,
  className = "",
  showDelayMs,
}) {
  const { language, t } = useI18n();
  const store = useContext(ProgressFeedbackContext);
  const registrationStore = inline ? null : store;
  const labelId = useId();
  const registrationId = useMemo(() => `progress-${normalizeDomId(labelId)}`, [labelId]);
  const derivedProgress = deriveProgressValue(value, current, total);
  const determinate = derivedProgress != null;
  const progress = determinate ? clampProgress(derivedProgress) : null;
  const percent = determinate ? `${Math.round(progress)}%` : null;
  const historyKey = useMemo(
    () => rememberDuration ? normalizeHistoryKey(operationKey ?? label) : null,
    [label, operationKey, rememberDuration],
  );
  const { elapsedSeconds, history } = useProgressClock(historyKey, startedAt);
  const measuredEta = Number.isFinite(etaSeconds) && etaSeconds >= 0
    ? etaSeconds
    : determinate && progress > 0 && progress < 100 && elapsedSeconds >= 1
      ? Math.min(MAX_RECORDED_DURATION_MS / 1000, elapsedSeconds * ((100 - progress) / progress))
      : null;
  const timingText = measuredEta != null && progress !== 100
    ? t("预计还需 {duration}", { duration: formatClockDuration(measuredEta) })
    : history
      ? `${t(progress === 100 ? "已用时 {duration}" : "已等待 {duration}", { duration: formatClockDuration(elapsedSeconds) })} · ${history.lowSeconds === history.highSeconds
        ? t("近期约 {duration}", { duration: formatClockDuration(history.lowSeconds) })
        : t("近期 {min}–{max}", {
          min: formatClockDuration(history.lowSeconds),
          max: formatClockDuration(history.highSeconds),
        })}`
      : t(progress === 100 ? "已用时 {duration}" : "已等待 {duration}", { duration: formatClockDuration(elapsedSeconds) });
  const countText = Number.isFinite(current) && Number.isFinite(total) && total > 0
    ? `${Number(current).toLocaleString(language === "zh" ? "zh-CN" : "en-US")} / ${Number(total).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}`
    : null;
  const supportText = [detail, countText].filter(Boolean).join(" · ");
  const ariaValueText = [percent ?? t("进行中"), timingText].filter(Boolean).join(" · ");
  const entry = useMemo(() => ({
    label,
    detail,
    progress,
    countText,
    timingText,
    tone,
    operationKey,
    showDelayMs,
  }), [countText, detail, label, operationKey, progress, showDelayMs, timingText, tone]);
  const entryRef = useRef(entry);
  entryRef.current = entry;

  useEffect(() => {
    if (!registrationStore) return undefined;
    registrationStore.register(registrationId, entryRef.current);
    return () => registrationStore.unregister(registrationId);
  }, [registrationId, registrationStore]);

  useEffect(() => {
    if (registrationStore) registrationStore.update(registrationId, entry);
  }, [entry, registrationId, registrationStore]);

  if (registrationStore) return null;

  return (
    <div
      className={`loading-progress is-${tone}${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-labelledby={labelId}
    >
      <div className="loading-progress-copy">
        <strong id={labelId}>{label}</strong>
        {supportText ? <span title={supportText}>{supportText}</span> : null}
        <div className="loading-progress-measure" aria-hidden="true">
          {percent ? <b>{percent}</b> : null}
          <small>{timingText}</small>
        </div>
      </div>
      <div
        className={`loading-progress-track${determinate ? " is-determinate" : " is-indeterminate"}`}
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        {...(determinate
          ? { "aria-valuenow": Math.round(progress), "aria-valuetext": ariaValueText }
          : { "aria-valuetext": ariaValueText })}
      >
        <span style={determinate ? { width: `${progress}%` } : undefined} />
      </div>
    </div>
  );
}
