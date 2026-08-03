export const DEFAULT_YAW_TICKS = Object.freeze([
  -90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90,
]);

export const DEFAULT_PITCH_TICKS = Object.freeze([60, 45, 30, 15, 0, -15, -30, -45, -60]);

export const REGRESSION_METRICS = Object.freeze({
  maskedMse: {
    label: "Masked MSE",
    direction: "lower",
    stableRatio: 0.02,
    absoluteFloor: 0.00001,
  },
  eyesMouthMse: {
    label: "眼口 MSE",
    direction: "lower",
    stableRatio: 0.02,
    absoluteFloor: 0.00001,
  },
  maskDice: {
    label: "Mask Dice",
    direction: "higher",
    stableRatio: 0.01,
    absoluteFloor: 0.005,
  },
  sharpnessRatio: {
    label: "清晰度",
    direction: "target-one",
    stableRatio: 0.02,
    absoluteFloor: 0.02,
  },
});

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
  );
}

function sameObject(left, right) {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function finiteMetric(sample, channel, metricKey) {
  const value = sample?.metrics?.[channel]?.[metricKey];
  return Number.isFinite(value) ? value : null;
}

function comparisonSignal(baseline, current, metric) {
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) {
    return { status: "empty", improvement: null, level: 0 };
  }
  const rawDelta = current - baseline;
  let improvement;
  let reference;
  if (metric.direction === "lower") {
    improvement = baseline - current;
    reference = Math.abs(baseline);
  } else if (metric.direction === "higher") {
    improvement = current - baseline;
    reference = Math.abs(baseline);
  } else {
    const baselineError = Math.abs(baseline - 1);
    const currentError = Math.abs(current - 1);
    improvement = baselineError - currentError;
    reference = Math.max(baselineError, metric.absoluteFloor);
  }
  const threshold = Math.max(metric.absoluteFloor, reference * metric.stableRatio);
  const status = improvement > threshold
    ? "improved"
    : improvement < -threshold ? "regressed" : "stable";
  return {
    status,
    rawDelta,
    improvement,
    level: Math.min(1, Math.abs(improvement) / Math.max(threshold * 4, metric.absoluteFloor)),
  };
}

function metricAggregate(baselineSamples, currentSamples, sampleIds, channel, metricKey) {
  const metric = REGRESSION_METRICS[metricKey];
  if (!metric) return null;
  const baselineValues = [];
  const currentValues = [];
  for (const id of sampleIds) {
    const baseline = finiteMetric(baselineSamples.get(id), channel, metricKey);
    const current = finiteMetric(currentSamples.get(id), channel, metricKey);
    if (baseline == null || current == null) continue;
    baselineValues.push(baseline);
    currentValues.push(current);
  }
  const baseline = average(baselineValues);
  const current = average(currentValues);
  if (baseline == null || current == null) return null;
  return {
    key: metricKey,
    label: metric.label,
    baseline,
    current,
    sampleCount: baselineValues.length,
    ...comparisonSignal(baseline, current, metric),
  };
}

export function snapshotCompatibility(baseline, current) {
  const checks = [
    {
      id: "model",
      label: "同一模型",
      passed: Boolean(baseline?.modelKey && baseline.modelKey === current?.modelKey),
      detail: "两个快照必须来自同一个受服务端约束的模型键。",
    },
    {
      id: "manifest",
      label: "同一评测样本清单",
      passed: Boolean(baseline?.manifestId && baseline.manifestId === current?.manifestId),
      detail: "必须使用内容寻址后的同一批确定性 SRC / DST 样本。",
    },
    {
      id: "metrics",
      label: "同一指标版本",
      passed: Number.isInteger(baseline?.metricSchemaVersion)
        && baseline.metricSchemaVersion === current?.metricSchemaVersion,
      detail: "指标定义变化后不能直接比较历史结果。",
    },
    {
      id: "signature",
      label: "同一模型结构",
      passed: Boolean(baseline?.modelSignature)
        && Boolean(current?.modelSignature)
        && sameObject(baseline.modelSignature, current.modelSignature),
      detail: "分辨率、脸型、架构和数据格式必须一致。",
    },
  ];
  return { comparable: checks.every((check) => check.passed), checks };
}

function samplesFor(snapshot, side) {
  return new Map(
    (snapshot?.samples ?? [])
      .filter((sample) => sample.side === side)
      .map((sample) => [sample.id, sample]),
  );
}

function defaultTicks(manifest, side, key, fallback) {
  const axis = key === "yawTicks" ? "yaw" : "pitch";
  const ticks = manifest?.poseBins?.[axis] ?? manifest?.probes?.[side]?.[key];
  return Array.isArray(ticks) && ticks.every(Number.isFinite) ? ticks : fallback;
}

export function buildTrainingPoseRegression({
  baseline,
  current,
  manifest,
  side = "dst",
  channel = "reconstruction",
  metricKey = "maskedMse",
} = {}) {
  const compatibility = snapshotCompatibility(baseline, current);
  const yawTicks = defaultTicks(manifest, side, "yawTicks", DEFAULT_YAW_TICKS);
  const pitchTicks = defaultTicks(manifest, side, "pitchTicks", DEFAULT_PITCH_TICKS);
  const baselineSamples = samplesFor(baseline, side);
  const currentSamples = samplesFor(current, side);
  const sharedIds = [...baselineSamples.keys()].filter((id) => currentSamples.has(id));
  const sharedByCell = new Map();
  for (const id of sharedIds) {
    const sample = currentSamples.get(id);
    if (!sharedByCell.has(sample.cellId)) sharedByCell.set(sample.cellId, []);
    sharedByCell.get(sample.cellId).push(id);
  }

  const cells = [];
  const totals = { improved: 0, regressed: 0, stable: 0, empty: 0 };
  for (const pitch of pitchTicks) {
    for (const yaw of yawTicks) {
      const id = `p${pitch}-y${yaw}`;
      const sampleIds = compatibility.comparable ? (sharedByCell.get(id) ?? []) : [];
      const metrics = Object.fromEntries(
        Object.keys(REGRESSION_METRICS).map((key) => [
          key,
          metricAggregate(baselineSamples, currentSamples, sampleIds, channel, key),
        ]),
      );
      const selectedMetric = metrics[metricKey];
      const status = compatibility.comparable && selectedMetric ? selectedMetric.status : "empty";
      totals[status] += 1;
      cells.push({
        id,
        yaw,
        pitch,
        sampleIds,
        sampleCount: selectedMetric?.sampleCount ?? 0,
        confidence: Math.min(1, (selectedMetric?.sampleCount ?? 0) / 3),
        status,
        level: selectedMetric?.level ?? 0,
        selectedMetric,
        metrics,
      });
    }
  }

  const coverageByYaw = yawTicks.map((yaw) => {
    const yawCells = cells.filter((cell) => cell.yaw === yaw);
    const sampleCount = yawCells.reduce((sum, cell) => sum + cell.sampleCount, 0);
    const availableCells = yawCells.filter((cell) => cell.sampleCount).length;
    return {
      yaw,
      sampleCount,
      availableCells,
      confidence: yawCells.length
        ? yawCells.reduce((sum, cell) => sum + cell.confidence, 0) / yawCells.length
        : 0,
    };
  });

  return {
    ...compatibility,
    side,
    channel,
    metricKey,
    yawTicks,
    pitchTicks,
    sharedSampleCount: sharedIds.length,
    cells,
    coverageByYaw,
    totals,
  };
}
