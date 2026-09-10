import { useCallback, useEffect, useRef, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { runtimeApi } from "../runtime/api.js";
import { cancelOperationAndCheck } from "../runtime/operation-cancellation.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

export function BackgroundOperations({ projectId, serviceOnline, onError, onNotice }) {
  const { t } = useI18n();
  const [operations, setOperations] = useState([]);
  const [cancellations, setCancellations] = useState({});
  const [connection, setConnection] = useState("connecting");
  const [monitorError, setMonitorError] = useState(null);
  const [checking, setChecking] = useState(false);
  const handlers = useRef({ onError, onNotice, t });
  handlers.current = { onError, onNotice, t };
  const monitor = useRef(null);
  const requests = useRef(new Map());
  const operationsRef = useRef(operations);
  operationsRef.current = operations;
  const stale = !serviceOnline || connection !== "online";

  const cancelOperation = useCallback(async operationId => {
    if (requests.current.has(operationId)) return;
    const controller = new AbortController();
    requests.current.set(operationId, controller);
    setCancellations(current => ({ ...current, [operationId]: { phase: "sending" } }));
    try {
      const result = await cancelOperationAndCheck(operationId, {
        cancel: runtimeApi.cancelOperation, read: runtimeApi.operation, signal: controller.signal,
      });
      if (!controller.signal.aborted && operationsRef.current.some(item => item.id === operationId)) {
        setCancellations(current => ({ ...current, [operationId]: { phase: result.status === "cancelling" ? "accepted" : "finishing" } }));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setCancellations(current => ({ ...current, [operationId]: { phase: error.code === "OPERATION_CANCEL_UNCONFIRMED" ? "unconfirmed" : "rejected", message: error.message } }));
        handlers.current.onError?.(error);
      }
    } finally {
      requests.current.delete(operationId);
      if (!controller.signal.aborted) void monitor.current?.refresh();
    }
  }, []);

  useEffect(() => {
    if (!projectId) return undefined;
    const dispose = runtimeApi.watchOperations({
      onUpdate: activeRecords => {
        operationsRef.current = activeRecords;
        setOperations(activeRecords);
        const ids = new Set(activeRecords.filter(item => ["queued", "running"].includes(item.status)).map(item => item.id));
        setCancellations(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
      },
      onConnectionChange: state => {
        setConnection(state);
        if (state === "online") setMonitorError(null);
      },
      onError: setMonitorError,
      onSettled: operation => {
        const { t: translate, onNotice: notice, onError: error } = handlers.current;
        const label = operation.label || translate("后台分析");
        if (operation.status === "succeeded") notice?.(translate("后台操作已完成：{label}", { label }));
        else if (operation.status === "cancelled") notice?.(translate("后台操作已取消：{label}", { label }));
        else error?.(new Error(translate("后台操作需要检查：{label}", { label }) + " · "
          + translate(operation.error?.message || "操作记录暂不可用，结果需要重新确认。")));
      },
    });
    monitor.current = dispose;
    return () => {
      monitor.current = null;
      dispose();
      requests.current.forEach(controller => controller.abort());
      requests.current.clear();
    };
  }, [projectId]);

  const checkProgress = async () => {
    const current = monitor.current;
    if (!current) return;
    setChecking(true);
    try { await current.refresh(); }
    finally { if (monitor.current === current) setChecking(false); }
  };
  return <>
    {monitorError || (operations.length > 0 && stale) ? <div className="background-operation-notice" role="status">
      <div><strong>{t("后台进度连接中断")}</strong><span>{t("正在自动重连；操作是否结束仍需确认。")}</span></div>
      <button type="button" className="button secondary" disabled={checking} onClick={() => void checkProgress()}><IconRefresh size={15}/>{checking ? t("检查中…") : t("检查进度")}</button>
    </div> : null}
    {operations.map(operation => {
      const cancellation = cancellations[operation.id];
      const cancelling = operation.status === "cancelling" || ["sending", "accepted"].includes(cancellation?.phase);
      const uncertain = ["unconfirmed", "rejected"].includes(cancellation?.phase);
      const statusText = stale ? t("状态未确认") : uncertain ? (cancellation.phase === "rejected" ? t("取消未完成") : t("取消未确认")) : cancelling ? t("正在取消")
        : cancellation?.phase === "finishing" ? t("正在更新结果") : operation.percent === 100 ? t("正在收尾") : undefined;
      const detail = stale ? t("保留上次进度，实际结果待确认。") : uncertain ? t(cancellation.message)
        : cancellation?.phase === "sending" ? t("正在提交取消请求…")
          : cancelling ? t("取消请求已收到，正在等待操作结束。")
            : [operation.stage, operation.detail].filter(Boolean).join(" · ");
      return <LoadingProgress
        key={operation.id}
        label={operation.label || t("后台分析")}
        detail={detail}
        value={operation.percent}
        current={operation.current}
        total={operation.total}
        etaSeconds={operation.etaSeconds}
        estimateRemaining={!stale && !cancelling && !uncertain && cancellation?.phase !== "finishing"}
        statusText={statusText}
        startedAt={operation.startedAt || operation.createdAt}
        operationKey={operation.id}
        rememberDuration={false}
        tone={statusText ? "amber" : "green"}
        showDelayMs={0}
        onCancel={!stale && !["accepted", "finishing"].includes(cancellation?.phase) && operation.cancellable && ["queued", "running"].includes(operation.status)
          ? () => void cancelOperation(operation.id) : undefined}
        cancelPending={cancellation?.phase === "sending"}
      />;
    })}
  </>;
}
