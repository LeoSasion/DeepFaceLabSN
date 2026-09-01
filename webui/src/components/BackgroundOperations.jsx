import { useCallback, useEffect, useRef, useState } from "react";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

export function BackgroundOperations({ serviceOnline, onError }) {
  const { t } = useI18n();
  const [operations, setOperations] = useState([]);
  const [cancellingIds, setCancellingIds] = useState(() => new Set());
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const cancelOperation = useCallback(async (operationId) => {
    setCancellingIds((current) => new Set(current).add(operationId));
    try {
      await runtimeApi.cancelOperation(operationId);
    } catch (error) {
      setCancellingIds((current) => {
        const next = new Set(current);
        next.delete(operationId);
        return next;
      });
      onErrorRef.current?.(error);
    }
  }, []);

  useEffect(() => {
    if (!serviceOnline) {
      setOperations([]);
      setCancellingIds(new Set());
      return undefined;
    }
    return runtimeApi.watchOperations({
      onUpdate: (activeRecords) => {
        const cancellableIds = new Set(
          activeRecords
            .filter((item) => item.cancellable && ["queued", "running"].includes(item.status))
            .map((item) => item.id),
        );
        setOperations(activeRecords);
        setCancellingIds((current) => new Set([...current].filter((id) => cancellableIds.has(id))));
      },
      onError: (error) => onErrorRef.current?.(error),
    });
  }, [serviceOnline]);

  return operations.map((operation) => (
    <LoadingProgress
      key={operation.id}
      label={operation.label || t("后台分析")}
      detail={[operation.stage, operation.detail].filter(Boolean).join(" · ")}
      value={operation.percent}
      current={operation.current}
      total={operation.total}
      etaSeconds={operation.etaSeconds}
      startedAt={operation.startedAt || operation.createdAt}
      operationKey={operation.id}
      rememberDuration={false}
      tone={operation.status === "cancelling" ? "warning" : "green"}
      showDelayMs={0}
      onCancel={operation.cancellable && ["queued", "running"].includes(operation.status)
        ? () => void cancelOperation(operation.id)
        : undefined}
      cancelPending={cancellingIds.has(operation.id)}
    />
  ));
}
