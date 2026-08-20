import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InstallView } from "./components/InstallView.jsx";
import { ReadyView } from "./components/ReadyView.jsx";
import { TitleBar } from "./components/TitleBar.jsx";
import { launcherBridge, previewState } from "./bridge.js";

function normalizeState(input) {
  const fallback = previewState();
  if (!input || typeof input !== "object") return fallback;
  return {
    ...fallback,
    ...input,
    steps: Array.isArray(input.steps) ? input.steps : fallback.steps,
    runtimeItems: Array.isArray(input.runtimeItems) ? input.runtimeItems : fallback.runtimeItems,
  };
}

function normalizeLog(entry) {
  if (typeof entry === "string") return { text: entry };
  return { ...entry, text: entry.text || entry.line || entry.message || "" };
}

export function App() {
  const initial = useMemo(() => previewState(), []);
  const [state, setState] = useState(() => normalizeState(initial));
  const [logs, setLogs] = useState(() => initial.logs || []);
  const [busyAction, setBusyAction] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const offState = launcherBridge.on("state", (next) => {
      setState((current) => normalizeState({ ...current, ...next }));
    });
    const offProgress = launcherBridge.on("progress", (progress) => {
      setState((current) => ({
        ...current,
        runtimeItems: current.runtimeItems.map((item) => item.id === progress.id ? { ...item, ...progress } : item),
      }));
    });
    const offLog = launcherBridge.on("log", (entry) => {
      setLogs((current) => [...current.slice(-499), normalizeLog(entry)]);
    });

    launcherBridge.request("getState").then((result) => {
      if (!mounted.current || !result) return;
      const next = result.state || result;
      setState((current) => normalizeState({ ...current, ...next }));
      if (Array.isArray(next.logs)) setLogs(next.logs.map(normalizeLog));
    }).catch((error) => {
      setLogs((current) => [...current, { level: "error", text: error.message }]);
    });

    return () => {
      mounted.current = false;
      offState();
      offProgress();
      offLog();
    };
  }, []);
  const runAction = useCallback(async (method, parameters = {}) => {
    if (busyAction) return false;
    setBusyAction(method);
    try {
      const result = await launcherBridge.request(method, {
        installPath: state.installPath,
        mirror: state.mirror,
        ...parameters,
      });
      if (result && result.state) {
        setState((current) => normalizeState({ ...current, ...result.state }));
      } else if (result && typeof result === "object") {
        setState((current) => normalizeState({ ...current, ...result }));
      }
      return true;
    } catch (error) {
      setLogs((current) => [...current, {
        level: "error",
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        tag: "ERROR",
        text: error && error.message ? error.message : "操作未完成，请查看终端详情。",
      }]);
      return false;
    } finally {
      if (mounted.current) setBusyAction("");
    }
  }, [busyAction, state.installPath, state.mirror]);

  const content = state.mode === "install"
    ? (
      <InstallView
        state={state}
        logs={logs}
        busy={Boolean(busyAction)}
        onAction={runAction}
        onClearLogs={() => setLogs([])}
      />
    )
    : <ReadyView state={state} logs={logs} busyAction={busyAction} onAction={runAction} />;

  return (
    <div className={"launcher-shell mode-" + state.mode}>
      <TitleBar state={state} />
      {content}
    </div>
  );
}
