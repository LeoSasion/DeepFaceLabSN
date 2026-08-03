import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runtimeApi, runtimeWebSocketUrl } from "./api.js";

const MAX_CLIENT_EVENTS = 1400;

export function mergeJobs(current, incoming) {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const existing = byId.get(job.id);
    if (
      existing
      && Number.isFinite(existing.sequence)
      && Number.isFinite(job.sequence)
      && existing.sequence > job.sequence
    ) continue;
    byId.set(job.id, { ...existing, ...job });
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function appendUniqueEvents(current, incoming) {
  if (!incoming.length) return current;
  const sequences = new Set(current.map((event) => event.sequence));
  const merged = [...current];
  for (const event of incoming) {
    if (event.sequence > 0 && sequences.has(event.sequence)) continue;
    merged.push(event);
    if (event.sequence > 0) sequences.add(event.sequence);
  }
  merged.sort((a, b) => a.sequence - b.sequence);
  return merged.slice(-MAX_CLIENT_EVENTS);
}

export function applyEventToJob(job, event) {
  if (job.id !== event.jobId) return job;
  if (
    Number.isFinite(job.sequence)
    && Number.isFinite(event.sequence)
    && event.sequence <= job.sequence
  ) return job;
  if (event.type === "job.state") return { ...job, ...event.payload, sequence: event.sequence };
  if (event.type === "job.metric") {
    return { ...job, latestMetric: event.payload, sequence: event.sequence };
  }
  if (event.type === "job.progress") {
    return { ...job, latestProgress: event.payload, sequence: event.sequence };
  }
  if (event.type === "terminal.prompt") {
    return { ...job, latestPrompt: event.payload.prompt, sequence: event.sequence };
  }
  if (event.type === "job.artifact") {
    if (event.payload.kind === "training-evaluation") {
      return {
        ...job,
        latestEvaluationSnapshotId: event.payload.snapshotId,
        sequence: event.sequence,
      };
    }
    return { ...job, previewVersion: event.payload.version, sequence: event.sequence };
  }
  if (event.type === "job.finished") {
    return {
      ...job,
      ...event.payload,
      endedAt: event.timestamp,
      sequence: event.sequence,
    };
  }
  return { ...job, sequence: Math.max(job.sequence ?? 0, event.sequence ?? 0) };
}

export function useRuntime() {
  const [serviceState, setServiceState] = useState("loading");
  const [health, setHealth] = useState(null);
  const [commands, setCommands] = useState([]);
  const [telemetry, setTelemetry] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [eventsByJob, setEventsByJob] = useState({});
  const [socketState, setSocketState] = useState("disconnected");
  const [lastError, setLastError] = useState(null);
  const socketRef = useRef(null);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setServiceState("loading");
    try {
      const nextHealth = await runtimeApi.health();
      const [nextCommands, nextJobs] = await Promise.all([
        runtimeApi.commands(),
        runtimeApi.jobs(),
      ]);
      setHealth(nextHealth);
      setCommands(nextCommands);
      setJobs((current) => mergeJobs(current, nextJobs));
      setSelectedJobId((current) => (
        current && nextJobs.some((job) => job.id === current)
          ? current
          : nextJobs.find((job) => ["running", "waiting_input", "starting", "stopping"].includes(job.state))?.id
            ?? nextJobs[0]?.id
            ?? null
      ));
      setServiceState("online");
      setLastError(null);
      return nextJobs;
    } catch (error) {
      setServiceState("offline");
      setSocketState("disconnected");
      setLastError(error);
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const delay = serviceState === "online" ? 5000 : 2000;
    const interval = window.setInterval(() => void refresh({ quiet: true }), delay);
    return () => window.clearInterval(interval);
  }, [refresh, serviceState]);

  useEffect(() => {
    if (serviceState !== "online") {
      setTelemetry(null);
      return undefined;
    }
    let cancelled = false;
    const sample = async () => {
      try {
        const next = await runtimeApi.telemetry();
        if (!cancelled) setTelemetry(next);
      } catch {
        if (!cancelled) setTelemetry({ available: false, gpus: [], error: "GPU 遥测暂时不可用" });
      }
    };
    void sample();
    const interval = window.setInterval(sample, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [serviceState]);

  const applyEvent = useCallback((event) => {
    if (!event?.jobId) return;
    setEventsByJob((current) => ({
      ...current,
      [event.jobId]: appendUniqueEvents(current[event.jobId] ?? [], [event]),
    }));
    setJobs((current) => current.map((job) => applyEventToJob(job, event)));
  }, []);

  useEffect(() => {
    if (serviceState !== "online" || !selectedJobId) {
      socketRef.current?.close();
      socketRef.current = null;
      setSocketState("disconnected");
      return undefined;
    }

    let cancelled = false;
    let reconnectTimer;
    let retry = 0;

    const connect = async () => {
      setSocketState(retry ? "reconnecting" : "connecting");
      let after = 0;
      try {
        const existing = eventsByJob[selectedJobId] ?? [];
        after = existing.at(-1)?.sequence ?? 0;
        const backlog = await runtimeApi.events(selectedJobId, after);
        if (cancelled) return;
        setEventsByJob((current) => ({
          ...current,
          [selectedJobId]: appendUniqueEvents(current[selectedJobId] ?? [], backlog),
        }));
        after = Math.max(after, backlog.at(-1)?.sequence ?? 0);
      } catch (error) {
        if (!cancelled) setLastError(error);
      }

      if (cancelled) return;
      const socket = new WebSocket(runtimeWebSocketUrl(selectedJobId, after));
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        retry = 0;
        setSocketState("connected");
      });
      socket.addEventListener("message", (message) => {
        try {
          const data = JSON.parse(message.data);
          if (data.type === "snapshot") {
            setJobs((current) => mergeJobs(current, [data.payload]));
          } else {
            applyEvent(data);
          }
        } catch {
          setLastError(new Error("终端收到无效消息"));
        }
      });
      socket.addEventListener("close", () => {
        if (cancelled) return;
        setSocketState("reconnecting");
        const delay = Math.min(800 * (2 ** retry), 5000);
        retry += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket.close());
    };

    void connect();
    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
    // Events are intentionally excluded: the connection owns its sequence cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyEvent, selectedJobId, serviceState]);

  const startJob = useCallback(async (commandId, options = {}) => {
    const job = await runtimeApi.start(commandId, options);
    setJobs((current) => mergeJobs(current, [job]));
    setSelectedJobId(job.id);
    setEventsByJob((current) => ({ ...current, [job.id]: [] }));
    return job;
  }, []);

  const sendInput = useCallback(async (input) => {
    if (!selectedJobId) throw new Error("尚未选择任务");
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "terminal.input", input }));
      return;
    }
    await runtimeApi.input(selectedJobId, input);
  }, [selectedJobId]);

  const resize = useCallback((cols, rows) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "terminal.resize", cols, rows }));
    }
  }, []);

  const control = useCallback(async (operation, jobId = selectedJobId) => {
    if (!jobId) throw new Error("尚未选择任务");
    const job = await runtimeApi.control(jobId, operation);
    setJobs((current) => mergeJobs(current, [job]));
    return job;
  }, [selectedJobId]);

  const retryJob = useCallback(async (jobId) => {
    if (!jobId) throw new Error("尚未选择任务");
    const job = await runtimeApi.retry(jobId);
    setJobs((current) => mergeJobs(current, [job]));
    setSelectedJobId(job.id);
    setEventsByJob((current) => ({ ...current, [job.id]: [] }));
    return job;
  }, []);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const selectedEvents = selectedJobId ? eventsByJob[selectedJobId] ?? [] : [];
  const metricHistory = useMemo(
    () => selectedEvents
      .filter((event) => event.type === "job.metric")
      .map((event) => ({
        iteration: event.payload.iteration,
        gLoss: event.payload.srcLoss,
        dLoss: event.payload.dstLoss,
      }))
      .slice(-200),
    [selectedEvents],
  );

  return {
    serviceState,
    health,
    commands,
    telemetry,
    jobs,
    selectedJob,
    selectedJobId,
    selectedEvents,
    metricHistory,
    socketState,
    lastError,
    refresh,
    preflight: runtimeApi.preflight,
    selectJob: setSelectedJobId,
    startJob,
    sendInput,
    resize,
    control,
    retryJob,
  };
}
