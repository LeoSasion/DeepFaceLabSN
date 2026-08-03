import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n.jsx";

const HISTORY_STORAGE_KEY = "dfl-webui-progress-history-v1";
const MAX_HISTORY_KEYS = 48;
const MAX_SAMPLES_PER_KEY = 7;
const MIN_RECORDED_DURATION_MS = 1000;
const MAX_RECORDED_DURATION_MS = 6 * 60 * 60 * 1000;

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
  className = "",
}) {
  const { language, t } = useI18n();
  const labelId = useId();
  const determinate = Number.isFinite(value);
  const progress = determinate ? clampProgress(value) : null;
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
  const ariaValueText = [percent, measuredEta != null ? timingText : null].filter(Boolean).join(" · ");

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
        {...(determinate ? { "aria-valuenow": Math.round(progress), "aria-valuetext": ariaValueText } : {})}
      >
        <span style={determinate ? { width: `${progress}%` } : undefined} />
      </div>
    </div>
  );
}
