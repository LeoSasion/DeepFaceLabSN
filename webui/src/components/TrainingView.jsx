import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconCamera,
  IconChartDots3,
  IconCheck,
  IconCircle,
  IconDeviceFloppy,
  IconFileAnalytics,
  IconFolderOpen,
  IconMovie,
  IconRefresh,
  IconRoute,
  IconShieldX,
  IconSparkles,
  IconUsersGroup,
} from "@tabler/icons-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LoadingProgress } from "./ProgressFeedback.jsx";
import { pipelineTasks as defaultPipelineTasks } from "../data/dashboard.js";
import { useI18n } from "../i18n.jsx";

const taskIcons = {
  extract: IconMovie,
  src: IconUsersGroup,
  dst: IconUsersGroup,
  sort: IconAdjustmentsHorizontal,
  xseg: IconSparkles,
  saehd: IconFileAnalytics,
  diagnose: IconChartDots3,
  merge: IconRoute,
  export: IconFileAnalytics,
};

const trainingStateLabels = {
  idle: "等待任务",
  queued: "排队中",
  starting: "启动中",
  running: "训练中",
  waiting_input: "等待输入",
  stopping: "保存并停止中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已终止",
  orphaned: "连接已丢失",
};

const activeTrainingStates = new Set(["queued", "starting", "running", "waiting_input"]);

function formatIteration(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatRate(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K/h`;
  return `${Math.round(value)}/h`;
}

function formatEta(seconds, t) {
  if (!Number.isFinite(seconds)) return t("未设目标");
  if (seconds <= 0) return t("已达目标");
  const minutes = Math.max(1, Math.round(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  if (days) return t("{days}天 {hours}小时", { days, hours });
  if (hours) return t("{hours}小时 {minutes}分", { hours, minutes: remainingMinutes });
  return t("{minutes}分钟", { minutes: remainingMinutes });
}

export function PipelinePanel({ activeTask, tasks = defaultPipelineTasks, onSelectTask }) {
  const { t } = useI18n();
  return (
    <section className="panel pipeline-panel" aria-labelledby="pipeline-title">
      <div className="panel-heading">
        <h2 id="pipeline-title">{t("当前流水线")}</h2>
      </div>
      <div className="pipeline-list">
        {tasks.map((task) => {
          const Icon = taskIcons[task.id] ?? IconFileAnalytics;
          const selected = activeTask === task.id;
          return (
            <button
              className={`pipeline-row ${selected ? "is-selected" : ""} is-${task.tone}`}
              key={task.id}
              type="button"
              onClick={() => onSelectTask(task)}
            >
              <Icon size={22} stroke={1.55} className="pipeline-icon" />
              <span className="pipeline-copy">
                <strong>{task.index}. {task.label}</strong>
                <small>{task.time}</small>
              </span>
              {task.state === "done" ? (
                <span className="state-mark done" aria-label={t("已完成")}>
                  <IconCheck size={13} stroke={2.8} />
                </span>
              ) : task.state === "active" ? (
                <span className="state-pulse" aria-label={t("运行中")} />
              ) : (
                <span className="state-mark waiting" aria-label={t("等待中")}>
                  <IconCircle size={11} stroke={2} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{formatIteration(label)} iters</strong>
      <span>G_loss {payload[0]?.value}</span>
      <span>D_loss {payload[1]?.value}</span>
    </div>
  );
}

function TrainingChart({ iteration, lossHistory, className = "" }) {
  const { language, t } = useI18n();
  return (
    <div className={`chart-block ${className}`.trim()} aria-label={t("训练损失曲线")}>
      <div className="section-label-row">
        <strong>{t("训练损失曲线")}</strong>
        <span>{t("越低越好")}</span>
        <div className="chart-legend" aria-label={t("图例")}>
          <span><i className="legend-dot green" /> G_loss</span>
          <span><i className="legend-dot amber" /> D_loss</span>
        </div>
      </div>
      <div className="chart-canvas">
        {!lossHistory.length ? (
          <div className="chart-empty">{t("训练输出出现迭代数据后，将在此绘制真实损失曲线")}</div>
        ) : null}
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 640, height: 127 }}
        >
          <LineChart data={lossHistory} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#163126" strokeOpacity={0.62} vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="iteration"
              minTickGap={34}
              tick={{ fill: "#738079", fontSize: 10 }}
              tickFormatter={formatIteration}
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              domain={[0.001, 1]}
              scale="log"
              ticks={[1, 0.1, 0.01, 0.001]}
              tick={{ fill: "#738079", fontSize: 10 }}
              tickFormatter={(value) => value.toFixed(value >= 1 ? 1 : value >= 0.1 ? 1 : value >= 0.01 ? 2 : 3)}
              tickLine={false}
              width={44}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#2ce39f", strokeOpacity: 0.35 }} />
            {iteration > 0 ? (
              <ReferenceLine
                x={iteration}
                stroke="#32e4a6"
                strokeDasharray="3 4"
                label={{
                  value: iteration.toLocaleString(language === "zh" ? "zh-CN" : "en-US"),
                  fill: "#b9f7dc",
                  fontSize: 10,
                  position: "insideTop",
                  dy: 4,
                }}
              />
            ) : null}
            <Line type="monotone" dataKey="gLoss" stroke="#2ce39f" strokeWidth={1.55} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="dLoss" stroke="#f3b83f" strokeWidth={1.45} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PreviewGrid({ refreshKey, previewUrl }) {
  const { t } = useI18n();
  return (
    <div className="preview-block" key={refreshKey}>
      <div className="preview-labels">
        <span>{t("Trainer 实时预览")}</span>
        <small>{t("由 SAEHD 控制桥生成，不依赖外部窗口")}</small>
      </div>
      {previewUrl ? (
        <div className="preview-assets is-live">
          <img
            className="live-preview"
            src={previewUrl}
            alt={t("SAEHD 最新训练预览")}
            decoding="async"
          />
        </div>
      ) : (
        <div className="preview-empty">
          <IconFileAnalytics size={24} stroke={1.45} />
          <strong>{t("尚无真实训练预览")}</strong>
          <span>{t("启动 SAEHD，首次迭代或点击“刷新预览”后显示")}</span>
        </div>
      )}
    </div>
  );
}

export function TrainingWorkspace({
  iteration,
  trainingState,
  previewRefresh,
  previewUrl,
  etaSeconds,
  targetIterations,
  startedAt,
  onSave,
  onBackup,
  onRefresh,
  onEvaluate,
  onOpenDiagnostics,
  canEvaluate,
  latestEvaluationSnapshotId,
  pendingAction,
  onSafeStop,
}) {
  const { language, t } = useI18n();
  const isRunning = activeTrainingStates.has(trainingState);
  const canControl = ["starting", "running", "waiting_input"].includes(trainingState);
  const stateLabel = t(trainingStateLabels[trainingState] ?? trainingState);
  return (
    <section className="panel training-panel" aria-labelledby="training-title">
      <div className="training-heading">
        <div>
          <h2 id="training-title">{t("训练任务")} <span>·</span> SAEHD</h2>
          <span className={`status-pill ${isRunning ? "running" : "paused"}`}>
            {stateLabel}
          </span>
        </div>
        <div className="training-heading-actions">
          <button
            className="button compact secondary"
            type="button"
            onClick={onEvaluate}
            disabled={!canEvaluate || Boolean(pendingAction)}
            title={canEvaluate ? t("使用当前权重生成只读评估快照") : t("运行中的受控 SAEHD 任务才能生成快照")}
          >
            <IconCamera size={14} stroke={1.9}/>{t("评估快照")}
          </button>
          <button
            className={`button compact ${latestEvaluationSnapshotId ? "primary" : "secondary"}`}
            type="button"
            onClick={onOpenDiagnostics}
          >
            <IconChartDots3 size={14} stroke={1.9}/>{t("质量诊断")}
          </button>
        </div>
      </div>
      <div className="training-preview-stage">
        {isRunning ? (
          <LoadingProgress
            compact
            className="training-run-progress"
            label={trainingState === "running" ? t("SAEHD 正在训练") : stateLabel}
            detail={targetIterations
              ? t("当前 {current} / 目标 {target} 次迭代", {
                current: iteration.toLocaleString(language === "zh" ? "zh-CN" : "en-US"),
                target: targetIterations.toLocaleString(language === "zh" ? "zh-CN" : "en-US"),
              })
              : t("持续读取 Trainer 的真实迭代指标")}
            value={targetIterations > 0 ? (iteration / targetIterations) * 100 : undefined}
            current={targetIterations > 0 ? iteration : undefined}
            total={targetIterations > 0 ? targetIterations : undefined}
            etaSeconds={etaSeconds}
            startedAt={startedAt}
            rememberDuration={false}
          />
        ) : null}
        <PreviewGrid refreshKey={previewRefresh} previewUrl={previewUrl} />
      </div>
      <div className="training-actions">
        <button className="button primary" type="button" onClick={onSave} disabled={!canControl || Boolean(pendingAction)}>
          <IconDeviceFloppy size={17} stroke={1.9} />{t("保存")}
        </button>
        <button className="button secondary" type="button" onClick={onBackup} disabled={!canControl || Boolean(pendingAction)}>
          <IconArchive size={17} stroke={1.9} />{t("备份")}
        </button>
        <button className="button secondary" type="button" onClick={onRefresh} disabled={!canControl || Boolean(pendingAction)}>
          <IconRefresh size={17} stroke={1.9} />{t("刷新预览")}
        </button>
        <button className="button danger" type="button" onClick={onSafeStop} disabled={!canControl || Boolean(pendingAction)}>
          <IconShieldX size={17} stroke={1.9} />{t("安全停止")}
        </button>
      </div>
    </section>
  );
}

function MetricRow({ label, value, suffix, percent, tone = "green", valueTone = null }) {
  return (
    <div className="metric-row">
      <span>{label}</span>
      {typeof percent === "number" ? (
        <span className="metric-bar" aria-hidden="true">
          <span className={`metric-fill ${tone}`} style={{ width: `${percent}%` }} />
        </span>
      ) : null}
      <strong className={valueTone ? `is-${valueTone}` : undefined}>{value}{suffix}</strong>
    </div>
  );
}

export function StatusPanel({
  trainingJob,
  telemetry,
  lossHistory = [],
  onOpenModels,
}) {
  const { language, t } = useI18n();
  const metric = trainingJob?.latestMetric;
  const gpu = telemetry?.gpus?.[0];
  const memoryPercent = gpu?.memoryTotalMiB
    ? Math.min(100, (gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100)
    : null;
  const trainingState = trainingJob?.state ?? "idle";
  const isTrainingActive = activeTrainingStates.has(trainingState);
  return (
    <aside className="panel status-panel" aria-labelledby="status-title">
      <div className="panel-heading">
        <h2 id="status-title">{t("实时状态")}</h2>
        <button
          className="status-model-button"
          type="button"
          onClick={onOpenModels}
          title={t("检查点由 DFL 正式保存流程写入，不展示模拟文件。")}
        >
          <IconFolderOpen size={14} stroke={1.8} />{t("复制模型目录")}
        </button>
      </div>
      <div className="status-metric-section is-training">
        <h3>{t("训练指标")}</h3>
        <div className="metrics-list">
          <MetricRow
            label={t("状态")}
            value={t(trainingStateLabels[trainingState] ?? trainingState)}
            suffix=""
            valueTone={isTrainingActive ? "green" : "amber"}
          />
          <MetricRow label={t("训练进程")} value={trainingJob?.pid ?? "—"} suffix="" />
          <MetricRow label={t("当前迭代")} value={metric?.iteration?.toLocaleString(language === "zh" ? "zh-CN" : "en-US") ?? "—"} suffix="" />
          <MetricRow label={t("单次迭代")} value={metric?.iterationTime ?? "—"} suffix="" />
          <MetricRow label={t("训练速度")} value={formatRate(metric?.iterationsPerHour)} suffix="" />
          <MetricRow label={t("预计完成")} value={formatEta(metric?.etaSeconds, t)} suffix="" />
          <MetricRow label={t("SRC 损失")} value={typeof metric?.srcLoss === "number" ? metric.srcLoss.toFixed(4) : "—"} suffix="" />
          <MetricRow label={t("DST 损失")} value={typeof metric?.dstLoss === "number" ? metric.dstLoss.toFixed(4) : "—"} suffix="" />
        </div>
      </div>
      <TrainingChart
        className="status-loss-chart"
        iteration={metric?.iteration ?? 0}
        lossHistory={lossHistory}
      />
      <div className="status-metric-section is-gpu">
        <h3>{t("GPU 状态")}</h3>
        <div className="metrics-list">
          <MetricRow
            label={t("GPU 利用率")}
            value={typeof gpu?.utilizationPercent === "number" ? Math.round(gpu.utilizationPercent) : "—"}
            suffix={typeof gpu?.utilizationPercent === "number" ? "%" : ""}
            percent={gpu?.utilizationPercent}
          />
          <MetricRow
            label={t("显存")}
            value={gpu ? `${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(1)}` : "—"}
            suffix={gpu ? " GB" : ""}
            percent={memoryPercent}
          />
          <MetricRow
            label={t("GPU 温度")}
            value={typeof gpu?.temperatureC === "number" ? Math.round(gpu.temperatureC) : "—"}
            suffix={typeof gpu?.temperatureC === "number" ? "°C" : ""}
            percent={gpu?.temperatureC}
            tone={gpu?.temperatureC >= 80 ? "amber" : "green"}
          />
        </div>
      </div>
    </aside>
  );
}

export function WorkbenchGrid(props) {
  return (
    <div className="workbench-grid">
      <PipelinePanel {...props.pipeline} />
      <TrainingWorkspace {...props.training} />
      <StatusPanel {...props.status} />
    </div>
  );
}
