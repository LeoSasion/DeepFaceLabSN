import { useCallback, useEffect, useRef, useState } from "react";
import { activeJobStates, mergeMetricHistory } from "../domain/job-presentation.js";
import { runtimeApi } from "./api.js";
import { createTrainingHistoryReader } from "./training-history-reader.js";

// Training history is independent from the terminal tab selected by the user.
export function useTrainingHistory(job) {
  const [result, setResult] = useState({ jobId: null, points: [], error: null });
  const readerRef = useRef(null);
  const resultRef = useRef(result);
  const metricRef = useRef(job?.latestMetric);
  resultRef.current = result;
  metricRef.current = job?.latestMetric;
  const jobId = job?.id;
  const active = activeJobStates.has(job?.state);
  const retry = useCallback(() => void readerRef.current?.refresh(), []);
  useEffect(() => {
    if (!jobId) return undefined;
    const reader = createTrainingHistoryReader({
      active,
      readEvents: cursor => runtimeApi.events(jobId, cursor),
      points: mergeMetricHistory(resultRef.current.jobId === jobId ? resultRef.current.points : [], [
        { type: "job.metric", payload: metricRef.current },
      ]),
      onChange: value => setResult({ ...value, jobId }),
    });
    readerRef.current = reader;
    void reader.refresh();
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    return () => {
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = null;
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
    };
  }, [jobId, active, job?.endedAt, retry]);
  return { ...(result.jobId === jobId ? result : { points: [], error: null }), retry };
}
