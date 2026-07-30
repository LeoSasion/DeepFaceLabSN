import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconCheck,
  IconChevronRight,
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
import { pipelineTasks as defaultPipelineTasks } from "../data/dashboard.js";

const taskIcons = {
  extract: IconMovie,
  src: IconUsersGroup,
  dst: IconUsersGroup,
  sort: IconAdjustmentsHorizontal,
  xseg: IconSparkles,
  saehd: IconFileAnalytics,
  merge: IconRoute,
  export: IconFileAnalytics,
};

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

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return "未设目标";
  if (seconds <= 0) return "已达目标";
  const minutes = Math.max(1, Math.round(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${remainingMinutes}分`;
  return `${remainingMinutes}分钟`;
}

export function PipelinePanel({ activeTask, tasks = defaultPipelineTasks, onSelectTask, onOpenCommandLog }) {
  return (
    <section className="panel pipeline-panel" aria-labelledby="pipeline-title">
      <div className="panel-heading">
        <h2 id="pipeline-title">当前流水线</h2>
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
                <span className="state-mark done" aria-label="已完成">
                  <IconCheck size={13} stroke={2.8} />
                </span>
              ) : task.state === "active" ? (
                <span className="state-pulse" aria-label="运行中" />
              ) : (
                <span className="state-mark waiting" aria-label="等待中">
                  <IconCircle size={11} stroke={2} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button className="button secondary pipeline-log-button" type="button" onClick={onOpenCommandLog}>
        查看全部命令日志
      </button>
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

function TrainingChart({ iteration, lossHistory }) {
  return (
    <div className="chart-block" aria-label="训练损失曲线">
      <div className="section-label-row">
        <strong>训练损失曲线</strong>
        <span>越低越好</span>
        <div className="chart-legend" aria-label="图例">
          <span><i className="legend-dot green" /> G_loss</span>
          <span><i className="legend-dot amber" /> D_loss</span>
        </div>
      </div>
      <div className="chart-canvas">
        {!lossHistory.length ? (
          <div className="chart-empty">训练输出出现迭代数据后，将在此绘制真实损失曲线</div>
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
                  value: iteration.toLocaleString("zh-CN"),
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
  return (
    <div className="preview-block" key={refreshKey}>
      <div className="preview-labels">
        <span>Trainer 实时预览</span>
        <small>由 SAEHD 控制桥生成，不依赖外部窗口</small>
      </div>
      {previewUrl ? (
        <div className="preview-assets is-live">
          <img className="live-preview" src={previewUrl} alt="SAEHD 最新训练预览" />
        </div>
      ) : (
        <div className="preview-empty">
          <IconFileAnalytics size={24} stroke={1.45} />
          <strong>尚无真实训练预览</strong>
          <span>启动 SAEHD，首次迭代或点击“刷新预览”后显示</span>
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
  lossHistory,
  iterationTime,
  iterationsPerHour,
  etaSeconds,
  targetIterations,
  srcLoss,
  dstLoss,
  onSave,
  onBackup,
  onRefresh,
  onSafeStop,
}) {
  const stateLabels = {
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
  const isRunning = ["queued", "starting", "running", "waiting_input"].includes(trainingState);
  const canControl = ["starting", "running", "waiting_input"].includes(trainingState);
  const stateLabel = stateLabels[trainingState] ?? trainingState;
  return (
    <section className="panel training-panel" aria-labelledby="training-title">
      <div className="training-heading">
        <div>
          <h2 id="training-title">训练任务 <span>·</span> SAEHD</h2>
          <span className={`status-pill ${isRunning ? "running" : "paused"}`}>
            {stateLabel}
          </span>
        </div>
      </div>
      <div className="training-stats">
        <div><span>迭代次数</span><strong>{iteration ? iteration.toLocaleString("zh-CN") : "—"}</strong></div>
        <div><span>单次迭代</span><strong>{iterationTime ?? "—"}</strong></div>
        <div><span>训练速度</span><strong>{formatRate(iterationsPerHour)}</strong></div>
        <div><span>预计完成</span><strong title={targetIterations ? `目标 ${targetIterations.toLocaleString("zh-CN")} 次` : ""}>{formatEta(etaSeconds)}</strong></div>
        <div><span>SRC 损失</span><strong>{typeof srcLoss === "number" ? srcLoss.toFixed(4) : "—"}</strong></div>
        <div><span>DST 损失</span><strong>{typeof dstLoss === "number" ? dstLoss.toFixed(4) : "—"}</strong></div>
        <div><span>状态</span><strong className={isRunning ? "green-text" : "amber-text"}>{stateLabel}</strong></div>
      </div>
      <TrainingChart iteration={iteration} lossHistory={lossHistory} />
      <PreviewGrid refreshKey={previewRefresh} previewUrl={previewUrl} />
      <div className="training-actions">
        <button className="button primary" type="button" onClick={onSave} disabled={!canControl}>
          <IconDeviceFloppy size={17} stroke={1.9} />保存
        </button>
        <button className="button secondary" type="button" onClick={onBackup} disabled={!canControl}>
          <IconArchive size={17} stroke={1.9} />备份
        </button>
        <button className="button secondary" type="button" onClick={onRefresh} disabled={!canControl}>
          <IconRefresh size={17} stroke={1.9} />刷新预览
        </button>
        <button className="button danger" type="button" onClick={onSafeStop} disabled={!canControl}>
          <IconShieldX size={17} stroke={1.9} />安全停止
        </button>
      </div>
    </section>
  );
}

function MetricRow({ label, value, suffix, percent, tone = "green" }) {
  return (
    <div className="metric-row">
      <span>{label}</span>
      {typeof percent === "number" ? (
        <span className="metric-bar" aria-hidden="true">
          <span className={`metric-fill ${tone}`} style={{ width: `${percent}%` }} />
        </span>
      ) : null}
      <strong>{value}{suffix}</strong>
    </div>
  );
}

export function StatusPanel({
  queue,
  activeQueue,
  trainingJob,
  telemetry,
  onSelectQueue,
  onRefreshQueue,
  onOpenModels,
}) {
  const metric = trainingJob?.latestMetric;
  const gpu = telemetry?.gpus?.[0];
  const memoryPercent = gpu?.memoryTotalMiB
    ? Math.min(100, (gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100)
    : null;
  const queueStateLabels = {
    active: "进行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已终止",
    orphaned: "连接已丢失",
  };
  return (
    <aside className="panel status-panel" aria-labelledby="status-title">
      <div className="panel-heading">
        <h2 id="status-title">实时状态</h2>
      </div>
      <div className="metrics-list">
        <MetricRow label="训练进程" value={trainingJob?.pid ?? "—"} suffix="" />
        <MetricRow label="当前迭代" value={metric?.iteration?.toLocaleString("zh-CN") ?? "—"} suffix="" />
        <MetricRow label="训练速度" value={formatRate(metric?.iterationsPerHour)} suffix="" />
        <MetricRow label="预计完成" value={formatEta(metric?.etaSeconds)} suffix="" />
        <MetricRow
          label="GPU 利用率"
          value={typeof gpu?.utilizationPercent === "number" ? Math.round(gpu.utilizationPercent) : "—"}
          suffix={typeof gpu?.utilizationPercent === "number" ? "%" : ""}
          percent={gpu?.utilizationPercent}
        />
        <MetricRow
          label="显存"
          value={gpu ? `${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(1)}` : "—"}
          suffix={gpu ? " GB" : ""}
          percent={memoryPercent}
        />
        <MetricRow
          label="GPU 温度"
          value={typeof gpu?.temperatureC === "number" ? Math.round(gpu.temperatureC) : "—"}
          suffix={typeof gpu?.temperatureC === "number" ? "°C" : ""}
          percent={gpu?.temperatureC}
          tone={gpu?.temperatureC >= 80 ? "amber" : "green"}
        />
      </div>
      <div className="status-section">
        <h3>模型目录</h3>
        <div className="checkpoint-empty">
          检查点由 DFL 正式保存流程写入，不展示模拟文件。
        </div>
        <button className="text-button" type="button" onClick={onOpenModels}>
          <IconFolderOpen size={15} stroke={1.8} />复制模型目录
        </button>
      </div>
      <div className="status-section queue-section">
        <div className="queue-heading">
          <h3>任务队列（{queue.length}）</h3>
        </div>
        <div className="queue-list">
          {queue.length ? queue.map((item) => (
            <button
              className={`queue-row ${activeQueue === item.id ? "is-active" : ""} is-${item.state}`}
              key={item.id}
              type="button"
              onClick={() => onSelectQueue(item)}
            >
              <span>
                <strong>{item.title}（{queueStateLabels[item.state] ?? item.state}）</strong>
                <small>{item.subtitle}</small>
              </span>
              <IconChevronRight size={16} stroke={1.6} />
            </button>
          )) : (
            <div className="queue-empty">队列已清空</div>
          )}
        </div>
        <button className="clear-queue-button" type="button" onClick={onRefreshQueue}>
          <IconRefresh size={15} stroke={1.8} />刷新任务状态
        </button>
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
