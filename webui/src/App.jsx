import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, ProjectHeader, WorkflowBar } from "./components/Chrome.jsx";
import { ConsoleDock } from "./components/ConsoleDock.jsx";
import { NewTaskDialog, StopConfirmDialog, Toast } from "./components/Overlays.jsx";
import {
  CommandCenterView,
  DatasetView,
  ModelSummaryAside,
  SettingsView,
} from "./components/OperationsView.jsx";
import { WorkbenchGrid } from "./components/TrainingView.jsx";
import { ToolLabView } from "./components/ToolLabView.jsx";
import { WorkspaceView } from "./components/WorkspaceView.jsx";
import { pipelineTasks } from "./data/dashboard.js";
import { useI18n } from "./i18n.jsx";
import { runtimeApi } from "./runtime/api.js";
import { useRuntime } from "./runtime/useRuntime.js";

const pipelineCommandMap = {
  extract: ["src.extract_frames", "dst.extract_frames"],
  src: ["src.extract_faces"],
  dst: ["dst.extract_faces"],
  sort: ["src.sort_faces", "dst.sort_faces"],
  xseg: ["xseg.train", "xseg.apply_src", "xseg.apply_dst"],
  saehd: ["train.saehd"],
  merge: ["merge.saehd"],
  export: ["encode.mp4", "encode.mp4_lossless"],
};

const activeStates = new Set(["queued", "starting", "running", "waiting_input", "stopping"]);

export function App() {
  const runtime = useRuntime();
  const { language, localizeCommand, t } = useI18n();
  const [activeNav, setActiveNav] = useState("overview");
  const [selectedStage, setSelectedStage] = useState("train");
  const [activeTask, setActiveTask] = useState("saehd");
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [taskType, setTaskType] = useState("train.saehd");
  const [xsegSide, setXsegSide] = useState("dst");
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(null);
  const [datasetFocus, setDatasetFocus] = useState(null);
  const [toast, setToast] = useState({ message: "", tone: "success" });

  const commands = useMemo(
    () => runtime.commands.map((command) => localizeCommand(command)),
    [language, localizeCommand, runtime.commands],
  );
  const commandById = useMemo(
    () => new Map(commands.map((command) => [command.id, command])),
    [commands],
  );
  const jobs = useMemo(() => runtime.jobs.map((job) => ({
    ...job,
    label: commandById.get(job.commandId)?.label ?? job.label,
  })), [commandById, runtime.jobs]);
  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === runtime.selectedJobId) ?? null,
    [jobs, runtime.selectedJobId],
  );

  const showToast = useCallback((message, tone = "success") => {
    setToast({ message, tone });
  }, []);
  const showError = useCallback((error) => {
    showToast(t(error.message), "warning");
  }, [showToast, t]);

  useEffect(() => {
    if (!toast.message) return undefined;
    const timeout = window.setTimeout(() => setToast({ message: "", tone: "success" }), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast.message]);

  useEffect(() => {
    if (
      runtime.serviceState !== "online"
      || !["training", "merge", "export"].includes(activeNav)
    ) return undefined;
    let cancelled = false;
    void runtimeApi.workspace().then((value) => {
      if (!cancelled) setWorkspaceSnapshot(value);
    }).catch((error) => {
      if (!cancelled) showToast(t(error.message), "warning");
    });
    return () => {
      cancelled = true;
    };
  }, [activeNav, runtime.serviceState, showToast, t]);

  const runAction = useCallback(async (action, successMessage) => {
    try {
      const result = await action();
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      showToast(t(error.message), "warning");
      throw error;
    }
  }, [showToast, t]);

  const trainingJob = useMemo(() => {
    if (selectedJob?.commandId === "train.saehd") return selectedJob;
    return jobs.find((job) => job.commandId === "train.saehd" && activeStates.has(job.state))
      ?? jobs.find((job) => job.commandId === "train.saehd")
      ?? null;
  }, [jobs, selectedJob]);

  const queue = useMemo(() => jobs.map((job) => ({
    id: job.id,
    title: job.label,
    subtitle: `${job.profile === "legacy" ? "DFL legacy" : "DFL current"} · PID ${job.pid ?? "—"}`,
    state: activeStates.has(job.state) ? "active" : job.state,
    raw: job,
  })), [jobs]);

  const livePipelineTasks = useMemo(() => pipelineTasks.map((sourceTask) => {
    const task = {
      ...sourceTask,
      label: t(sourceTask.label),
      time: t(sourceTask.time),
    };
    const commandIds = pipelineCommandMap[task.id] ?? [];
    const matchingJobs = jobs.filter((candidate) => commandIds.includes(candidate.commandId));
    const job = matchingJobs.find((candidate) => activeStates.has(candidate.state)) ?? matchingJobs[0];
    if (!job) return task;
    const requiredStates = commandIds.map((commandId) => (
      matchingJobs.find((candidate) => candidate.commandId === commandId)?.state
    ));
    const isActive = matchingJobs.some((candidate) => activeStates.has(candidate.state));
    const isAlternativeGroup = task.id === "export";
    const isComplete = isAlternativeGroup
      ? matchingJobs.some((candidate) => candidate.state === "succeeded")
      : requiredStates.every((state) => state === "succeeded");
    const hasPartialSuccess = matchingJobs.some((candidate) => candidate.state === "succeeded");
    return {
      ...task,
      state: isActive ? "active" : isComplete ? "done" : "waiting",
      time: isActive
        ? job.state === "waiting_input" ? t("等待输入") : t("运行中")
        : isComplete
          ? t("已完成")
          : hasPartialSuccess
            ? t("部分完成")
            : job.state === "orphaned" ? t("连接已丢失") : t("上次失败"),
    };
  }), [jobs, t]);

  const workflowStates = useMemo(() => {
    const stateFor = (commandId) => {
      const job = jobs.find((candidate) => candidate.commandId === commandId);
      if (!job) return "waiting";
      if (activeStates.has(job.state)) return "active";
      return job.state === "succeeded" ? "done" : "waiting";
    };
    const combinedStateFor = (commandIds) => {
      const states = commandIds.map(stateFor);
      if (states.includes("active")) return "active";
      if (states.every((state) => state === "done")) return "done";
      return "waiting";
    };
    return {
      frames: combinedStateFor(["src.extract_frames", "dst.extract_frames"]),
      faces: combinedStateFor(["src.extract_faces", "dst.extract_faces"]),
      clean: combinedStateFor(["src.sort_faces", "dst.sort_faces"]),
      mask: combinedStateFor(["xseg.train", "xseg.apply_src", "xseg.apply_dst"]),
      train: stateFor("train.saehd"),
      merge: stateFor("merge.saehd"),
      encode: ["encode.mp4", "encode.mp4_lossless"].some((commandId) => stateFor(commandId) === "done")
        ? "done"
        : ["encode.mp4", "encode.mp4_lossless"].some((commandId) => stateFor(commandId) === "active")
          ? "active"
          : "waiting",
    };
  }, [jobs]);

  const handleNavigate = useCallback((id, label) => {
    setActiveNav(id);
    setConsoleCollapsed(id !== "overview");
    showToast(t("已切换到「{label}」工作区", { label }));
  }, [showToast, t]);

  const handleStageSelect = useCallback((stage) => {
    setSelectedStage(stage.id);
    showToast(t("已定位到「{label}」阶段", { label: stage.label }));
  }, [showToast, t]);

  const handleTaskSelect = useCallback((task) => {
    setActiveTask(task.id);
    if (task.id === "saehd") setSelectedStage("train");
    if (task.id === "xseg") setSelectedStage("mask");
    if (task.id === "merge") setSelectedStage("merge");
    if (task.id === "export") setSelectedStage("encode");
    const commandIds = pipelineCommandMap[task.id] ?? [];
    const existing = jobs.find(
      (job) => commandIds.includes(job.commandId) && activeStates.has(job.state),
    ) ?? jobs.find((job) => commandIds.includes(job.commandId));
    if (existing) {
      runtime.selectJob(existing.id);
      setConsoleCollapsed(false);
      showToast(t("已切换到任务：{label}", { label: existing.label }));
    } else if (commandIds.length) {
      setTaskType(commandIds[0]);
      setNewTaskOpen(true);
      showToast(t("「{label}」尚未启动，可从“新建任务”运行", { label: task.label }));
    } else {
      showToast(t("「{label}」将在后续外部窗口整合阶段接入", { label: task.label }), "warning");
    }
  }, [jobs, runtime, showToast, t]);

  const handleStartJob = useCallback(async (commandId, options = {}) => {
    const job = await runAction(
      () => runtime.startJob(commandId, options),
      t("任务已启动，终端会话正在连接"),
    );
    setConsoleCollapsed(false);
    return job;
  }, [runAction, runtime, t]);

  const openCommand = useCallback((commandId) => {
    setTaskType(commandId);
    setNewTaskOpen(true);
  }, []);

  const openDatasetSample = useCallback((side, sample) => {
    setDatasetFocus(sample ? { side, sample, nonce: Date.now() } : null);
    setActiveNav(side);
    setConsoleCollapsed(true);
    showToast(sample
      ? t("已在 {side} 数据集中定位 {name}", { side: side.toUpperCase(), name: sample.name })
      : t("已打开 {side} 数据集", { side: side.toUpperCase() }));
  }, [showToast, t]);
  const consumeDatasetFocus = useCallback(() => setDatasetFocus(null), []);

  const handleArchivedJobs = useCallback((result) => {
    void runtime.refresh();
    showToast(result.archived
      ? t("已归档 {count} 个任务，可从 .webui/archive 恢复", { count: result.archived })
      : t("没有可归档的已结束任务"));
  }, [runtime.refresh, showToast, t]);

  const handleCreateTask = useCallback(async (options) => {
    try {
      await handleStartJob(taskType, options);
      setNewTaskOpen(false);
    } catch {
      // The dialog stays open so the user can correct the missing input.
    }
  }, [handleStartJob, taskType]);

  const controlTraining = useCallback(async (operation, message) => {
    if (!trainingJob) {
      showToast(t("当前没有 SAEHD 训练任务"), "warning");
      return;
    }
    try {
      await runAction(() => runtime.control(operation, trainingJob.id), message);
      if (operation === "preview") setPreviewRefresh((current) => current + 1);
    } catch {
      // runAction already surfaced a recovery-oriented toast.
    }
  }, [runAction, runtime, showToast, t, trainingJob]);

  const handleStopConfirm = useCallback(async () => {
    setStopConfirmOpen(false);
    await controlTraining("close", t("已请求安全停止；Trainer 将先保存模型"));
  }, [controlTraining, t]);

  const handleCopyPath = useCallback(async (value) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(t("任务目录已复制"));
    } catch {
      showToast(value, "warning");
    }
  }, [showToast, t]);

  const workspacePath = runtime.health?.runtime?.current?.workspace ?? "workspace";
  const previewVersion = trainingJob?.previewVersion ?? previewRefresh;
  const previewUrl = trainingJob?.previewVersion
    ? `/api/jobs/${encodeURIComponent(trainingJob.id)}/preview?v=${trainingJob.previewVersion}`
    : null;
  const trainingMetric = trainingJob?.latestMetric;
  const trainingHistory = runtime.selectedJob?.id === trainingJob?.id ? runtime.metricHistory : [];

  let mainContent;
  if (activeNav === "video") {
    mainContent = (
      <WorkspaceView
        serviceOnline={runtime.serviceState === "online"}
        onError={showError}
        onArchived={handleArchivedJobs}
      />
    );
  } else if (activeNav === "src" || activeNav === "dst") {
    mainContent = (
      <DatasetView
        side={activeNav}
        commands={commands}
        focusItem={datasetFocus?.side === activeNav ? datasetFocus.sample : null}
        focusNonce={datasetFocus?.side === activeNav ? datasetFocus.nonce : null}
        onFocusConsumed={consumeDatasetFocus}
        onOpenCommand={openCommand}
        onError={showError}
        onNotice={showToast}
      />
    );
  } else if (activeNav === "xseg") {
    mainContent = (
      <DatasetView
        side={xsegSide}
        commands={commands}
        editMasks
        onSideChange={setXsegSide}
        onOpenCommand={openCommand}
        onError={showError}
        onNotice={showToast}
      />
    );
  } else if (activeNav === "training") {
    mainContent = (
      <CommandCenterView
        title={t("模型训练")}
        description={t("SAEHD 使用 Web 预览桥；ME、Quick384、Quick512 保留完整 CLI 问答与真实终端。")}
        commands={commands}
        filter={(command) => command.category === "training"}
        onOpenCommand={openCommand}
        aside={<ModelSummaryAside workspace={workspaceSnapshot} />}
      />
    );
  } else if (activeNav === "merge") {
    mainContent = (
      <CommandCenterView
        title={t("模型应用")}
        description={t("从固定模型目录启动 SAEHD、AMP、ME 或 Quick 合成，产物统一写入 merged 序列。")}
        commands={commands}
        filter={(command) => command.category === "merge"}
        onOpenCommand={openCommand}
        aside={<ModelSummaryAside workspace={workspaceSnapshot} />}
      />
    );
  } else if (activeNav === "export") {
    mainContent = (
      <CommandCenterView
        title={t("导出与封装")}
        description={t("导出 DeepFaceLive DFM，或把合成序列封装为 MP4、AVI 与无损 MOV。")}
        commands={commands}
        filter={(command) => ["model", "encode"].includes(command.category)}
        onOpenCommand={openCommand}
        aside={<ModelSummaryAside workspace={workspaceSnapshot} />}
      />
    );
  } else if (activeNav === "tools") {
    mainContent = (
      <ToolLabView
        commands={commands}
        onOpenCommand={openCommand}
        onError={showError}
        onNotice={showToast}
        onNavigateDataset={openDatasetSample}
      />
    );
  } else if (activeNav === "settings") {
    mainContent = (
      <SettingsView
        health={runtime.health}
        jobs={jobs}
        onRetry={runtime.retryJob}
        onError={showError}
        onNotice={showToast}
      />
    );
  } else {
    mainContent = (
      <WorkbenchGrid
        pipeline={{
          activeTask,
          tasks: livePipelineTasks,
          onSelectTask: handleTaskSelect,
          onOpenCommandLog: () => {
            setConsoleCollapsed(false);
            showToast(t("终端监视器已展开"));
          },
        }}
        training={{
          iteration: trainingMetric?.iteration ?? 0,
          trainingState: trainingJob?.state ?? "idle",
          previewRefresh: previewVersion,
          previewUrl,
          lossHistory: trainingHistory,
          iterationTime: trainingMetric?.iterationTime,
          iterationsPerHour: trainingMetric?.iterationsPerHour,
          etaSeconds: trainingMetric?.etaSeconds,
          targetIterations: trainingMetric?.targetIterations,
          srcLoss: trainingMetric?.srcLoss,
          dstLoss: trainingMetric?.dstLoss,
          onSave: () => void controlTraining("save", t("保存请求已送入 Trainer")),
          onBackup: () => void controlTraining("backup", t("备份请求已送入 Trainer")),
          onRefresh: () => void controlTraining("preview", t("预览刷新请求已送入 Trainer")),
          onSafeStop: () => setStopConfirmOpen(true),
        }}
        status={{
          queue,
          activeQueue: runtime.selectedJobId,
          trainingJob,
          telemetry: runtime.telemetry,
          onSelectQueue: (item) => {
            runtime.selectJob(item.id);
            setConsoleCollapsed(false);
          },
          onRefreshQueue: () => void runAction(
            () => runtime.refresh(),
            t("任务状态已刷新"),
          ).catch(() => {}),
          onOpenModels: () => handleCopyPath(`${workspacePath}\\model`),
        }}
      />
    );
  }

  return (
    <AppShell activeNav={activeNav} onNavigate={handleNavigate}>
      <main className={`main-surface${activeNav === "tools" ? " is-tools" : ""}`}>
        <ProjectHeader
          workspacePath={workspacePath}
          serviceState={runtime.serviceState}
          telemetry={runtime.telemetry}
          onNewTask={() => setNewTaskOpen(true)}
          onMenu={() => showToast(t("工作区：{path}", { path: workspacePath }))}
        />
        {activeNav !== "tools" && (
          <WorkflowBar
            selectedStage={selectedStage}
            stageStates={workflowStates}
            onSelectStage={handleStageSelect}
          />
        )}
        {mainContent}
        <ConsoleDock
          collapsed={consoleCollapsed}
          onToggle={() => setConsoleCollapsed((current) => !current)}
          serviceState={runtime.serviceState}
          socketState={runtime.socketState}
          commands={commands}
          jobs={jobs}
          selectedJob={selectedJob}
          events={runtime.selectedEvents}
          onSelectJob={runtime.selectJob}
          onStart={handleStartJob}
          onOpenNewTask={() => setNewTaskOpen(true)}
          onRetry={() => void runtime.refresh()}
          onInput={runtime.sendInput}
          onResize={runtime.resize}
          onControl={runtime.control}
          onSafeStop={() => setStopConfirmOpen(true)}
          onCopyPath={handleCopyPath}
          onError={showError}
        />
      </main>
      <Toast
        message={toast.message}
        tone={toast.tone}
        onDismiss={() => setToast({ message: "", tone: "success" })}
      />
      <NewTaskDialog
        open={newTaskOpen}
        taskType={taskType}
        workspacePath={workspacePath}
        serviceOnline={runtime.serviceState === "online"}
        commands={commands}
        onTaskType={setTaskType}
        onPreflight={runtime.preflight}
        onClose={() => setNewTaskOpen(false)}
        onCreate={handleCreateTask}
      />
      <StopConfirmDialog
        open={stopConfirmOpen}
        onCancel={() => setStopConfirmOpen(false)}
        onConfirm={() => void handleStopConfirm()}
      />
    </AppShell>
  );
}
