import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconBoxModel2,
  IconCamera,
  IconChartDots3,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconRefresh,
} from "@tabler/icons-react";
import {
  buildTrainingPoseRegression,
  REGRESSION_METRICS,
} from "../domain/training-pose-regression.js";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const OUTPUT_MODES = [
  {
    id: "dst-reconstruction",
    label: "DST 重建",
    side: "dst",
    channel: "reconstruction",
    imageVariant: "reconstruction",
    metrics: ["maskedMse", "eyesMouthMse", "maskDice", "sharpnessRatio"],
  },
  {
    id: "src-reconstruction",
    label: "SRC 重建",
    side: "src",
    channel: "reconstruction",
    imageVariant: "reconstruction",
    metrics: ["maskedMse", "eyesMouthMse", "sharpnessRatio"],
  },
  {
    id: "dst-swap",
    label: "DST 换脸",
    side: "dst",
    channel: "swap",
    imageVariant: "swap",
    metrics: ["maskDice", "sharpnessRatio"],
  },
];

const STATUS_LABELS = {
  improved: "改善",
  regressed: "回归",
  stable: "稳定",
  empty: "无样本",
};

function formatAngle(value) {
  if (value > 0) return `+${value}°`;
  if (value === 0) return "0°";
  return `${value}°`;
}

function formatMetric(value, metricKey) {
  if (!Number.isFinite(value)) return "—";
  if (metricKey === "maskDice" || metricKey === "sharpnessRatio") return value.toFixed(3);
  return value.toFixed(value < 0.01 ? 5 : 4);
}

function formatDelta(value, metricKey) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMetric(value, metricKey)}`;
}

function formatDate(value, language) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function snapshotImageUrl(modelKey, snapshotId, sampleId, variant) {
  return `/api/training-evaluations/${encodeURIComponent(modelKey)}`
    + `/snapshots/${encodeURIComponent(snapshotId)}`
    + `/samples/${encodeURIComponent(sampleId)}/${encodeURIComponent(variant)}`;
}

function findDefaultPair(snapshots) {
  if (snapshots.length < 2) return [snapshots[0]?.snapshotId ?? null, snapshots[0]?.snapshotId ?? null];
  const current = snapshots[snapshots.length - 1];
  const baseline = [...snapshots]
    .slice(0, -1)
    .reverse()
    .find((snapshot) => (
      snapshot.manifestId === current.manifestId
      && snapshot.metricSchemaVersion === current.metricSchemaVersion
    )) ?? snapshots[snapshots.length - 2];
  return [baseline.snapshotId, current.snapshotId];
}

function stateCopy(status, t) {
  return t(STATUS_LABELS[status] ?? STATUS_LABELS.empty);
}

function MetricSignal({ metric }) {
  if (!metric) return <span className="diagnostic-signal is-empty">—</span>;
  const Icon = metric.status === "improved"
    ? IconArrowDown
    : metric.status === "regressed" ? IconArrowUp : IconArrowRight;
  return (
    <span className={`diagnostic-signal is-${metric.status}`}>
      {formatDelta(metric.rawDelta, metric.key)} <Icon size={13} stroke={2.2} />
    </span>
  );
}

function ComparisonGate({ checks, t }) {
  return (
    <section className="diagnostic-context-card" aria-label={t("比较前提") }>
      <header><strong>{t("比较前提")}</strong><span>{checks.filter((check) => check.passed).length}/4</span></header>
      <div className="diagnostic-checks">
        {checks.map((check) => (
          <div className={check.passed ? "is-passed" : "is-blocked"} key={check.id} title={t(check.detail)}>
            {check.passed ? <IconCheck size={14} stroke={2.4} /> : <IconAlertTriangle size={14} stroke={2} />}
            <span>{t(check.label)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DiagnosticsState({ icon: Icon = IconChartDots3, title, detail, action, loading = false }) {
  return (
    <div className={`quality-diagnostics-state${loading ? " is-loading" : ""}`} role={loading ? undefined : "status"}>
      {loading ? <LoadingProgress label={title} detail={detail} /> : (
        <>
          <Icon size={34} stroke={1.4} />
          <strong>{title}</strong>
          <span>{detail}</span>
          {action}
        </>
      )}
    </div>
  );
}

export function QualityDiagnosticsView({
  evaluationJob,
  refreshKey,
  onEvaluate,
  onOpenTraining,
  onOpenPoseAtlas,
  onError,
  onNotice,
  onSnapshotCount,
}) {
  const { language, t } = useI18n();
  const modelKey = evaluationJob?.evaluation?.modelKey ?? null;
  const [catalog, setCatalog] = useState({ snapshots: [], manifests: [] });
  const [baselineId, setBaselineId] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [current, setCurrent] = useState(null);
  const [modeId, setModeId] = useState("dst-reconstruction");
  const [metricKey, setMetricKey] = useState("maskedMse");
  const [selectedCellId, setSelectedCellId] = useState(null);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestVersion = useRef(0);

  const snapshots = useMemo(
    () => [...catalog.snapshots].sort((left, right) => (
      left.iteration - right.iteration || left.createdAt.localeCompare(right.createdAt)
    )),
    [catalog.snapshots],
  );
  const mode = OUTPUT_MODES.find((candidate) => candidate.id === modeId) ?? OUTPUT_MODES[0];
  const selectedManifest = catalog.manifests.find((manifest) => (
    manifest.manifestId === current?.manifestId
  )) ?? null;

  const loadCatalog = useCallback(async () => {
    if (!modelKey) {
      setCatalog({ snapshots: [], manifests: [] });
      setBaselineId(null);
      setCurrentId(null);
      onSnapshotCount?.(0);
      return;
    }
    const request = requestVersion.current + 1;
    requestVersion.current = request;
    setLoading(true);
    setLoadError(null);
    try {
      const [snapshotResult, manifestResult] = await Promise.all([
        runtimeApi.trainingEvaluationSnapshots(modelKey),
        runtimeApi.trainingEvaluationManifests(modelKey),
      ]);
      if (request !== requestVersion.current) return;
      const ordered = [...snapshotResult.snapshots].sort((left, right) => (
        left.iteration - right.iteration || left.createdAt.localeCompare(right.createdAt)
      ));
      setCatalog({ snapshots: ordered, manifests: manifestResult.manifests });
      onSnapshotCount?.(ordered.length);
      setBaselineId((existingBaseline) => {
        const [fallbackBaseline] = findDefaultPair(ordered);
        return ordered.some((snapshot) => snapshot.snapshotId === existingBaseline)
          ? existingBaseline
          : fallbackBaseline;
      });
      setCurrentId((existingCurrent) => {
        const [, fallbackCurrent] = findDefaultPair(ordered);
        return ordered.some((snapshot) => snapshot.snapshotId === existingCurrent)
          ? existingCurrent
          : fallbackCurrent;
      });
    } catch (error) {
      if (request !== requestVersion.current) return;
      setLoadError(error);
      onError(error);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [modelKey, onError, onSnapshotCount]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, refreshKey, reloadNonce]);

  useEffect(() => () => {
    requestVersion.current += 1;
  }, []);

  useEffect(() => {
    if (!modelKey || !baselineId || !currentId || baselineId === currentId) {
      setBaseline(null);
      setCurrent(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      runtimeApi.trainingEvaluationSnapshot(modelKey, baselineId),
      runtimeApi.trainingEvaluationSnapshot(modelKey, currentId),
    ]).then(([nextBaseline, nextCurrent]) => {
      if (cancelled) return;
      setBaseline(nextBaseline);
      setCurrent(nextCurrent);
      setLoadError(null);
    }).catch((error) => {
      if (cancelled) return;
      setLoadError(error);
      onError(error);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [baselineId, currentId, modelKey, onError]);

  useEffect(() => {
    if (!mode.metrics.includes(metricKey)) setMetricKey(mode.metrics[0]);
  }, [metricKey, mode]);

  const comparison = useMemo(() => buildTrainingPoseRegression({
    baseline,
    current,
    manifest: selectedManifest,
    side: mode.side,
    channel: mode.channel,
    metricKey,
  }), [baseline, current, metricKey, mode, selectedManifest]);

  useEffect(() => {
    setSelectedCellId((existing) => {
      if (comparison.cells.some((cell) => cell.id === existing && cell.sampleCount)) return existing;
      return comparison.cells.find((cell) => cell.status === "regressed" && cell.sampleCount)?.id
        ?? comparison.cells.find((cell) => cell.sampleCount)?.id
        ?? null;
    });
  }, [comparison.cells]);

  useEffect(() => setSampleIndex(0), [selectedCellId, modeId]);

  const selectedCell = comparison.cells.find((cell) => cell.id === selectedCellId) ?? null;
  const selectedSampleId = selectedCell?.sampleIds[sampleIndex] ?? null;
  const baselineSample = baseline?.samples?.find((sample) => sample.id === selectedSampleId) ?? null;
  const currentSample = current?.samples?.find((sample) => sample.id === selectedSampleId) ?? null;
  const selectedMetrics = mode.metrics.map((key) => selectedCell?.metrics[key]).filter(Boolean);
  const selectedSnapshotIndex = new Map(snapshots.map((snapshot, index) => [snapshot.snapshotId, index]));
  const baselineIndex = selectedSnapshotIndex.get(baselineId) ?? -1;
  const currentIndex = selectedSnapshotIndex.get(currentId) ?? -1;
  const canEvaluate = Boolean(
    evaluationJob
    && ["starting", "running", "waiting_input"].includes(evaluationJob.state)
    && evaluationJob.controls?.includes("evaluate"),
  );

  const handleEvaluate = async () => {
    if (!canEvaluate || evaluating) return;
    setEvaluating(true);
    try {
      await onEvaluate();
      onNotice(t("评估请求已发送，快照完成后会自动刷新"));
    } catch {
      // The caller already presents the runtime error.
    } finally {
      setEvaluating(false);
    }
  };

  const handleBaseline = (snapshotId) => {
    const nextIndex = selectedSnapshotIndex.get(snapshotId);
    if (!Number.isInteger(nextIndex)) return;
    setBaselineId(snapshotId);
    if (nextIndex >= currentIndex) {
      setCurrentId(snapshots[Math.min(snapshots.length - 1, nextIndex + 1)]?.snapshotId ?? snapshotId);
    }
  };

  const handleCurrent = (snapshotId) => {
    const nextIndex = selectedSnapshotIndex.get(snapshotId);
    if (!Number.isInteger(nextIndex)) return;
    setCurrentId(snapshotId);
    if (nextIndex <= baselineIndex) {
      setBaselineId(snapshots[Math.max(0, nextIndex - 1)]?.snapshotId ?? snapshotId);
    }
  };

  if (!modelKey) {
    return (
      <section className="quality-diagnostics-view">
        <DiagnosticsState
          title={t("尚未建立训练评估上下文")}
          detail={t("从引导模式启动 SAEHD 并明确模型名称后，训练器才能生成确定性姿势快照。")}
          action={(
            <div className="diagnostics-empty-actions">
              <button className="button primary" type="button" onClick={onOpenTraining}>
                <IconBoxModel2 size={16}/>{t("前往模型训练")}
              </button>
              <small>{t("先启动 SAEHD，再从训练预览生成至少两次评估快照。")}</small>
            </div>
          )}
        />
      </section>
    );
  }

  if (loading && !snapshots.length) {
    return (
      <section className="quality-diagnostics-view">
        <DiagnosticsState loading title={t("正在读取评估快照…")} detail={t("只读取本地内容寻址快照，不会触碰训练权重。")}/>
      </section>
    );
  }

  if (loadError && !snapshots.length) {
    return (
      <section className="quality-diagnostics-view">
        <DiagnosticsState
          icon={IconAlertTriangle}
          title={t("评估快照读取失败")}
          detail={t(loadError.message)}
          action={<button className="button secondary" type="button" onClick={() => setReloadNonce((value) => value + 1)}><IconRefresh size={15}/>{t("重试")}</button>}
        />
      </section>
    );
  }

  if (snapshots.length < 2) {
    return (
      <section className="quality-diagnostics-view">
        <div className="quality-diagnostics-empty-shell">
          <header>
            <div><span>{t("新增流程 · 7")}</span><h2>{t("质量诊断")}</h2></div>
            <button className="button primary" type="button" onClick={handleEvaluate} disabled={!canEvaluate || evaluating}><IconCamera size={15}/>{t(evaluating ? "正在生成…" : "生成评估快照")}</button>
          </header>
          {evaluating ? <LoadingProgress compact label={t("正在生成只读评估快照…")} detail={t("Trainer 完成后会自动加入时间线")} operationKey="diagnostics-evaluate" /> : null}
          <DiagnosticsState
            title={t("至少需要两个可比较快照")}
            detail={t("当前已有 {count} 个。训练中生成基线与当前快照后，才会计算姿势回归。", { count: snapshots.length })}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="quality-diagnostics-view" aria-labelledby="quality-diagnostics-title">
      <header className="diagnostics-toolbar">
        <div className="diagnostics-title">
          <span>{t("新增流程 · 7")}</span>
          <h2 id="quality-diagnostics-title">{t("姿势回归诊断")}</h2>
          <i className={comparison.comparable ? "is-ready" : "is-blocked"}/>
          <small>{comparison.comparable ? t("快照可比较") : t("比较条件未满足")}</small>
        </div>
        <div className="diagnostics-selectors">
          <label>
            <span>{t("基线")}</span>
            <select value={baselineId ?? ""} onChange={(event) => handleBaseline(event.target.value)}>
              {snapshots.filter((snapshot, index) => index < currentIndex).map((snapshot) => (
                <option key={snapshot.snapshotId} value={snapshot.snapshotId}>{t("迭代 {count}", { count: snapshot.iteration.toLocaleString() })}</option>
              ))}
            </select>
          </label>
          <IconArrowRight size={16} stroke={1.6}/>
          <label>
            <span>{t("当前")}</span>
            <select value={currentId ?? ""} onChange={(event) => handleCurrent(event.target.value)}>
              {snapshots.filter((snapshot, index) => index > baselineIndex).map((snapshot) => (
                <option key={snapshot.snapshotId} value={snapshot.snapshotId}>{t("迭代 {count}", { count: snapshot.iteration.toLocaleString() })}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="button primary" type="button" onClick={handleEvaluate} disabled={!canEvaluate || evaluating} title={!canEvaluate ? t("仅运行中的受控 SAEHD 任务可以生成快照") : ""}>
          <IconCamera size={15}/>{t(evaluating ? "正在生成…" : "生成评估快照")}
        </button>
      </header>
      {evaluating ? (
        <LoadingProgress compact label={t("正在生成只读评估快照…")} detail={t("当前诊断结果保持可见")} operationKey="diagnostics-evaluate"/>
      ) : loading ? (
        <LoadingProgress compact label={t("正在刷新评估快照…")} detail={t("当前诊断结果保持可见")} operationKey="diagnostics-refresh"/>
      ) : null}

      <div className="diagnostics-timeline" aria-label={t("评估快照时间线") }>
        <div className="diagnostics-timeline-line" aria-hidden="true"/>
        {snapshots.map((snapshot, index) => {
          const role = snapshot.snapshotId === baselineId ? "baseline" : snapshot.snapshotId === currentId ? "current" : "other";
          return (
            <button
              className={`diagnostics-timeline-node is-${role}`}
              key={snapshot.snapshotId}
              type="button"
              aria-pressed={role !== "other"}
              onClick={() => (index < currentIndex ? handleBaseline(snapshot.snapshotId) : handleCurrent(snapshot.snapshotId))}
            >
              <i/>
              <strong>{role === "baseline" ? t("基线") : role === "current" ? t("当前") : ""}</strong>
              <span>{t("迭代 {count}", { count: snapshot.iteration.toLocaleString() })}</span>
              <small>{formatDate(snapshot.createdAt, language)}</small>
            </button>
          );
        })}
      </div>

      <div className="diagnostics-workspace">
        <aside className="diagnostics-metric-tabs" aria-label={t("回归指标") }>
          <div className="diagnostics-mode-tabs" role="group" aria-label={t("评估模式") }>
            {OUTPUT_MODES.map((candidate) => (
              <button className={modeId === candidate.id ? "is-active" : ""} key={candidate.id} type="button" aria-pressed={modeId === candidate.id} onClick={() => setModeId(candidate.id)}>{t(candidate.label)}</button>
            ))}
          </div>
          <span>{t("回归指标")}</span>
          {mode.metrics.map((key) => (
            <button className={metricKey === key ? "is-active" : ""} key={key} type="button" aria-pressed={metricKey === key} onClick={() => setMetricKey(key)}>{t(REGRESSION_METRICS[key].label)}</button>
          ))}
          <div className="diagnostics-legend">
            {Object.entries(STATUS_LABELS).map(([status, label]) => <span className={`is-${status}`} key={status}><i/>{t(label)}</span>)}
          </div>
        </aside>

        <div className="diagnostics-map-stack">
          {!comparison.comparable ? (
            <div className="diagnostics-map-blocked">
              <IconAlertTriangle size={26}/><strong>{t("这两个快照不能直接比较")}</strong><span>{t("请选择满足右侧四项条件的快照组合。")}</span>
            </div>
          ) : (
            <>
              <div className="regression-map-heading"><span>Yaw</span><small>{t("格内箭头表示相对基线的质量方向")}</small></div>
              <div className="regression-map">
                <div className="regression-pitch-title">Pitch</div>
                <div className="regression-yaw-labels" style={{ gridTemplateColumns: `repeat(${comparison.yawTicks.length}, minmax(44px, 1fr))` }}>
                  {comparison.yawTicks.map((yaw) => <span key={yaw}>{formatAngle(yaw)}</span>)}
                </div>
                <div className="regression-pitch-labels" style={{ gridTemplateRows: `repeat(${comparison.pitchTicks.length}, 31px)` }}>
                  {comparison.pitchTicks.map((pitch) => <span key={pitch}>{formatAngle(pitch)}</span>)}
                </div>
                <div className="regression-cells" style={{ gridTemplateColumns: `repeat(${comparison.yawTicks.length}, minmax(44px, 1fr))`, gridTemplateRows: `repeat(${comparison.pitchTicks.length}, 31px)` }}>
                  {comparison.cells.map((cell) => {
                    const Arrow = cell.status === "improved" ? IconArrowDown : cell.status === "regressed" ? IconArrowUp : IconArrowRight;
                    return (
                      <button
                        className={`regression-cell is-${cell.status} ${selectedCellId === cell.id ? "is-selected" : ""}`}
                        key={cell.id}
                        type="button"
                        disabled={!cell.sampleCount}
                        aria-pressed={selectedCellId === cell.id}
                        aria-label={t("Yaw {yaw}，Pitch {pitch}，{status}，{count} 个样本", { yaw: formatAngle(cell.yaw), pitch: formatAngle(cell.pitch), status: stateCopy(cell.status, t), count: cell.sampleCount })}
                        onClick={() => setSelectedCellId(cell.id)}
                        style={{ "--regression-level": cell.level.toFixed(3) }}
                      >
                        {cell.sampleCount ? <><Arrow size={14} stroke={2.4}/><span>{cell.sampleCount}</span></> : <span>—</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="diagnostics-coverage">
                <div><strong>{t("置信度与样本覆盖")}</strong><small>{t("单独展示，不参与回归严重度")}</small></div>
                <div className="coverage-yaw-spacer"/>
                <div className="coverage-bars" style={{ gridTemplateColumns: `repeat(${comparison.yawTicks.length}, minmax(44px, 1fr))` }}>
                  {comparison.coverageByYaw.map((coverage) => (
                    <div key={coverage.yaw} title={t("Yaw {yaw}：{count} 个共同样本", { yaw: formatAngle(coverage.yaw), count: coverage.sampleCount })}>
                      <span>{coverage.sampleCount || "—"}</span>
                      <i><b style={{ height: `${Math.max(4, coverage.confidence * 100)}%` }}/></i>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <aside className="diagnostics-context">
          <ComparisonGate checks={comparison.checks} t={t}/>
          <section className="diagnostic-context-card">
            <header><strong>{t("比较摘要")}</strong><span>{comparison.sharedSampleCount}</span></header>
            <dl>
              <div><dt>{t("模型键")}</dt><dd>{modelKey.split("-saehd-")[0]}</dd></div>
              <div><dt>{t("分辨率")}</dt><dd>{current?.modelSignature?.resolution ? `${current.modelSignature.resolution}px` : "—"}</dd></div>
              <div><dt>{t("改善姿势格")}</dt><dd className="is-improved">{comparison.totals.improved}</dd></div>
              <div><dt>{t("回归姿势格")}</dt><dd className="is-regressed">{comparison.totals.regressed}</dd></div>
              <div><dt>{t("稳定姿势格")}</dt><dd>{comparison.totals.stable}</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      <section className="diagnostics-inspector" aria-label={t("已选姿势格证据") }>
        <div className="diagnostics-cell-metrics">
          <header>
            <span>{t("选中姿势格")}</span>
            <strong>{selectedCell ? `yaw ${formatAngle(selectedCell.yaw)} · pitch ${formatAngle(selectedCell.pitch)}` : t("未选择")}</strong>
          </header>
          <div className="diagnostics-metric-table">
            <div className="is-heading"><span>{t("指标")}</span><span>{t("基线")}</span><span>{t("当前")}</span><span>Δ</span></div>
            {selectedMetrics.map((metric) => (
              <div key={metric.key}><span>{t(metric.label)}</span><span>{formatMetric(metric.baseline, metric.key)}</span><span>{formatMetric(metric.current, metric.key)}</span><MetricSignal metric={metric}/></div>
            ))}
          </div>
        </div>

        <div className="diagnostics-evidence">
          <div className="diagnostics-evidence-heading">
            <span>{t("同一评测样本")}</span>
            <div>
              <button type="button" aria-label={t("上一个样本")} disabled={!selectedCell?.sampleIds.length || sampleIndex <= 0} onClick={() => setSampleIndex((value) => Math.max(0, value - 1))}><IconChevronLeft size={15}/></button>
              <small>{selectedCell?.sampleIds.length ? `${sampleIndex + 1} / ${selectedCell.sampleIds.length}` : "0 / 0"}</small>
              <button type="button" aria-label={t("下一个样本")} disabled={!selectedCell?.sampleIds.length || sampleIndex >= selectedCell.sampleIds.length - 1} onClick={() => setSampleIndex((value) => Math.min((selectedCell?.sampleIds.length ?? 1) - 1, value + 1))}><IconChevronRight size={15}/></button>
            </div>
          </div>
          <div className="diagnostics-evidence-grid">
            {selectedSampleId ? (
              [
                [t("输入"), currentSample?.variants?.includes("input") ? snapshotImageUrl(modelKey, currentId, selectedSampleId, "input") : null],
                [t("基线重建"), baselineSample?.variants?.includes(mode.imageVariant) ? snapshotImageUrl(modelKey, baselineId, selectedSampleId, mode.imageVariant) : null],
                [t("当前重建"), currentSample?.variants?.includes(mode.imageVariant) ? snapshotImageUrl(modelKey, currentId, selectedSampleId, mode.imageVariant) : null],
              ].map(([label, url]) => (
                <figure key={label}>
                  <figcaption>{label}</figcaption>
                  {url ? <img src={url} alt={`${label} · ${selectedSampleId}`} decoding="async"/> : <div><IconCamera size={22}/><span>{t("图像不可用")}</span></div>}
                </figure>
              ))
            ) : <div className="diagnostics-evidence-empty">{t("选择有共同样本的姿势格以查看证据")}</div>}
          </div>
        </div>

        <aside className="diagnostics-cell-context">
          <div><span>{t("共同样本")}</span><strong>{selectedCell?.sampleCount ?? 0} / 3</strong></div>
          <div><span>{t("置信度")}</span><strong className={(selectedCell?.confidence ?? 0) < 0.67 ? "is-warning" : ""}>{selectedCell?.confidence >= 1 ? t("高") : selectedCell?.confidence >= 0.67 ? t("中") : t("低")}</strong></div>
          {(selectedCell?.confidence ?? 0) < 0.67 ? <p><IconAlertTriangle size={14}/>{t("样本较少，仅作趋势提示")}</p> : null}
          {selectedCell && (Math.abs(selectedCell.yaw) >= 75 || Math.abs(selectedCell.pitch) >= 45) ? <p><IconAlertTriangle size={14}/>{t("边缘姿势，优先检查数据覆盖")}</p> : null}
          <button className="diagnostics-data-link" type="button" disabled={!selectedCell} onClick={() => onOpenPoseAtlas(selectedCell.id)}>
            {t("查看数据原因")}<IconExternalLink size={14}/>
          </button>
        </aside>
      </section>
    </section>
  );
}
