import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppShell, ProjectHeader, WorkflowBar } from "./components/Chrome.jsx";
import { ConsoleDock } from "./components/ConsoleDock.jsx";
import { NewTaskDialog, StopConfirmDialog, Toast } from "./components/Overlays.jsx";
import { BackgroundOperations } from "./components/BackgroundOperations.jsx";
import { ProjectSwitchDialog } from "./components/ProjectSwitchDialog.jsx";
import { WorkbenchGrid } from "./components/TrainingView.jsx";
import { selectTrainingJob, resolveSavedTrainingModel, getSavedTrainingModelState } from "./domain/training-context.js";
import { LoadingProgress, ProgressHud } from "./components/ProgressFeedback.jsx";
import {
  getInitialReadinessDestination,
  navigationWorkflowStages,
  pipelineTasks,
  workflowStageDestinations,
} from "./data/dashboard.js";
import { useI18n } from "./i18n.jsx";
import { runtimeApi } from "./runtime/api.js";
import { useRuntime } from "./runtime/useRuntime.js";
import { useTrainingHistory } from "./runtime/useTrainingHistory.js";
import { isFailedJob } from "./domain/job-presentation.js";

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
const frameCommandFilter = (command) => ["src.extract_frames", "dst.extract_frames"].includes(command.id);
const faceCommandFilter = (command) => ["src.extract_faces", "dst.extract_faces"].includes(command.id);
const trainingCommandFilter = (command) => command.category === "training";
const mergeCommandFilter = (command) => command.category === "merge";
const exportCommandFilter = (command) => ["model", "encode"].includes(command.category);

function lazyNamed(loader, exportName) {
  return lazy(() => loader().then((module) => ({ default: memo(module[exportName]) })));
}

const CommandCenterView = lazyNamed(() => import("./components/OperationsView.jsx"), "CommandCenterView");
const DatasetView = lazyNamed(() => import("./components/OperationsView.jsx"), "DatasetView");
const ModelSummaryAside = lazyNamed(() => import("./components/OperationsView.jsx"), "ModelSummaryAside");
const SettingsView = lazyNamed(() => import("./components/OperationsView.jsx"), "SettingsView");
const QualityDiagnosticsView = lazyNamed(() => import("./components/QualityDiagnosticsView.jsx"), "QualityDiagnosticsView");
const ToolLabView = lazyNamed(() => import("./components/ToolLabView.jsx"), "ToolLabView");
const WorkspaceView = lazyNamed(() => import("./components/WorkspaceView.jsx"), "WorkspaceView");
const ExportView = lazyNamed(() => import("./components/ExportView.jsx"), "ExportView");
const RoleSelectionView = lazyNamed(() => import("./components/RoleGroupingPanel.jsx"), "RoleSelectionView");
const MemoWorkbenchGrid = memo(WorkbenchGrid);

function workspaceTaskReady(taskId, workspace) {
  if (!workspace) return false;
  const readiness = workspace.readiness ?? {};
  const datasets = workspace.datasets ?? {};
  if (taskId === "extract") return Boolean(readiness.frames);
  if (taskId === "src") return (datasets.srcFaces?.count ?? 0) > 0;
  if (taskId === "dst") return (datasets.dstFaces?.count ?? 0) > 0;
  if (taskId === "sort") return Boolean(workspace.roles?.src?.current && workspace.roles?.dst?.current);
  if (taskId === "xseg") return Boolean(readiness.xseg);
  if (taskId === "saehd") return Boolean(readiness.saehd);
  if (taskId === "merge") return Boolean(readiness.merged);
  if (taskId === "export") return Boolean(readiness.encoded);
  return false;
}

function getNextWorkflowStep(workspace, snapshotCount = 0, canEvaluate = false) {
  const readiness = workspace?.readiness ?? {};
  const datasets = workspace?.datasets ?? {};
  if (!readiness.materials) {
    return { stage: "material", task: "extract", label: "导入 SRC / DST 素材", target: "workspace" };
  }
  if (!readiness.frames) {
    const commandId = (datasets.srcFrames?.count ?? 0) > 0 ? "dst.extract_frames" : "src.extract_frames";
    return { stage: "frames", task: "extract", label: "提取视频帧", commandId };
  }
  if (!readiness.faces) {
    const commandId = (datasets.srcFaces?.count ?? 0) > 0 ? "dst.extract_faces" : "src.extract_faces";
    return { stage: "faces", task: commandId.startsWith("dst") ? "dst" : "src", label: "提取 aligned 人脸", commandId };
  }
  if (!readiness.saehd) {
    if (!workspaceTaskReady("sort", workspace)) return { stage:"clean",task:"sort",label:"选择人物",target:"roles" };
    return { stage: "train", task: "saehd", label: "训练 SAEHD", commandId: "train.saehd" };
  }
  if (snapshotCount < 2) {
    return canEvaluate
      ? { stage: "diagnose", task: "diagnose", label: "生成质量评估快照", target: "diagnostics" }
      : { stage: "train", task: "saehd", label: "继续训练并生成评估快照", commandId: "train.saehd" };
  }
  if (!readiness.merged) {
    return { stage: "merge", task: "merge", label: "合成 SAEHD 人脸", commandId: "merge.saehd" };
  }
  if (!readiness.encoded) {
    return { stage: "encode", task: "export", label: "导出 MP4", commandId: "encode.mp4" };
  }
  return { stage: "encode", task: "export", label: "查看项目成果", target: "export" };
}

export function App() {
  const runtime = useRuntime();
  const {
    control,
    preflight,
    refresh: refreshRuntime,
    resize: resizeTerminal,
    retryJob,
    selectJob,
    sendInput,
    startJob,
  } = runtime;
  const { language, localizeCommand, t } = useI18n();
  const [activeNav, setActiveNav] = useState("overview");
  const [selectedStage, setSelectedStage] = useState("material");
  const [activeTask, setActiveTask] = useState("extract");
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [consoleCollapsed, setConsoleCollapsed] = useState(true);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [stopTargetJobId, setStopTargetJobId] = useState(null);
  const [switchProject, setSwitchProject] = useState(null);
  const [taskType, setTaskType] = useState("src.extract_frames");
  const [taskDefaults, setTaskDefaults] = useState(null);
  const [roleSide, setRoleSide] = useState("src");
  const [xsegSide, setXsegSide] = useState("dst");
  const [xsegDirty, setXsegDirty] = useState(false);
  const [loadedWorkspace, setWorkspaceSnapshot] = useState(null);
  const workspaceScope = runtime.health?.runtime?.current?.workspace;
  const workspaceSnapshot = loadedWorkspace?.root === workspaceScope ? loadedWorkspace : null;
  const [datasetFocus, setDatasetFocus] = useState(null);
  const [xsegFocus, setXsegFocus] = useState(null);
  const [toolFocus, setToolFocus] = useState(null);
  const [poseAtlasFocus, setPoseAtlasFocus] = useState(null);
  const [diagnosticSnapshotCount, setDiagnosticSnapshotCount] = useState(0);
  const [toast, setToast] = useState({ message: "", tone: "success" });
  const [pendingAction, setPendingAction] = useState(null);
  const navigationTouchedRef = useRef(false);
  const initialWorkspaceNavigationRef = useRef(null);

  useEffect(() => {
    if (!xsegDirty) return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [xsegDirty]);

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

  const workspaceRefreshKey = useMemo(
    () => runtime.jobs.map((job) => `${job.id}:${job.state}:${job.endedAt ?? ""}`).join("|"),
    [runtime.jobs],
  );

  useEffect(() => {
    if (runtime.serviceState !== "online") return undefined;
    let cancelled = false;
    void runtimeApi.workspace().then((value) => {
      if (!cancelled) setWorkspaceSnapshot(value);
    }).catch((error) => {
      if (!cancelled) showToast(t(error.message), "warning");
    });
    return () => {
      cancelled = true;
    };
  }, [runtime.health?.runtime?.current?.workspace, runtime.serviceState, showToast, t, workspaceRefreshKey]);

  const runAction = useCallback(async (action, successMessage, progressLabel = t("正在处理本地请求…")) => {
    setPendingAction(progressLabel);
    try {
      const result = await action();
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      showToast(t(error.message), "warning");
      throw error;
    } finally {
      setPendingAction(null);
    }
  }, [showToast, t]);

  const trainingJob = useMemo(() => selectTrainingJob(jobs,selectedJob), [jobs,selectedJob]);

  const evaluationJob = useMemo(() => {
    if (trainingJob?.evaluation?.enabled) return trainingJob;
    return jobs.find((job) => (
      job.commandId === "train.saehd"
      && job.evaluation?.enabled
      && activeStates.has(job.state)
    )) ?? jobs.find((job) => job.commandId === "train.saehd" && job.evaluation?.enabled) ?? null;
  }, [jobs, trainingJob]);

  useEffect(() => {
    const modelKey = evaluationJob?.evaluation?.modelKey;
    if (!modelKey) {
      setDiagnosticSnapshotCount(0);
      return undefined;
    }
    let cancelled = false;
    void runtimeApi.trainingEvaluationSnapshots(modelKey).then((result) => {
      if (!cancelled) setDiagnosticSnapshotCount(result.snapshots.length);
    }).catch(() => {
      if (!cancelled) setDiagnosticSnapshotCount(0);
    });
    return () => { cancelled = true; };
  }, [evaluationJob?.evaluation?.modelKey, evaluationJob?.latestEvaluationSnapshotId]);

  const livePipelineTasks = useMemo(() => pipelineTasks.map((sourceTask) => {
    const task = {
      ...sourceTask,
      label: t(sourceTask.label),
      time: t(sourceTask.time),
    };
    if (task.id === "diagnose") {
      return {
        ...task,
        state: diagnosticSnapshotCount >= 2 ? "done" : "waiting",
        time: diagnosticSnapshotCount >= 2
          ? t("已有 {count} 个评估快照", { count: diagnosticSnapshotCount })
          : t("等待至少两个评估快照"),
      };
    }
    const commandIds = pipelineCommandMap[task.id] ?? [];
    const matchingJobs = jobs.filter((candidate) => commandIds.includes(candidate.commandId));
    const latestJobs = commandIds
      .map((commandId) => matchingJobs.find((candidate) => candidate.commandId === commandId))
      .filter(Boolean);
    const latestStates = latestJobs.map((candidate) => candidate.state);
    const job = latestJobs.find((candidate) => activeStates.has(candidate.state)) ?? latestJobs[0];
    const artifactReady = workspaceTaskReady(task.id, workspaceSnapshot);
    if (!job) {
      return artifactReady
        ? { ...task, state: "done", time: t("工作区已有可用产物") }
        : task.id === "sort" ? { ...task, label:t("选择人物"), time:t("待复核") }
        : task.id === "xseg" ? { ...task, time:t("可选") }
        : task;
    }
    const requiredStates = commandIds.map((commandId) => (
      latestJobs.find((candidate) => candidate.commandId === commandId)?.state
    ));
    const isActive = latestStates.some((state) => activeStates.has(state));
    const isAlternativeGroup = task.id === "export";
    const isComplete = artifactReady || (task.id !== "sort" && (isAlternativeGroup
      ? latestStates.some((state) => state === "succeeded")
      : requiredStates.every((state) => state === "succeeded")));
    const hasPartialSuccess = latestStates.some((state) => state === "succeeded");
    const failedJob = latestJobs.find(isFailedJob);
    return {
      ...task,
      state: isActive ? "active" : isComplete ? "done" : failedJob ? "failed" : "waiting",
      time: isActive
        ? job.state === "waiting_input" ? t("等待输入") : t("运行中")
        : isComplete
          ? artifactReady ? t("工作区已有可用产物") : t("已完成")
          : failedJob?.state === "orphaned"
            ? t("连接已丢失")
            : failedJob
              ? t("上次失败")
              : task.id === "sort" ? t("待复核") : hasPartialSuccess
                ? t("部分完成")
                : t("未运行"),
    };
  }), [diagnosticSnapshotCount, jobs, t, workspaceSnapshot]);

  const workflowStates = useMemo(() => {
    const stateFor = (commandId, artifactReady = false) => {
      const job = jobs.find((candidate) => candidate.commandId === commandId);
      if (!job) return artifactReady ? "done" : "waiting";
      if (activeStates.has(job.state)) return "active";
      if (job.state === "succeeded" || artifactReady) return "done";
      if (isFailedJob(job)) return "failed";
      return "waiting";
    };
    const combinedStateFor = (commandIds, artifactReady = false, requiresReview = false) => {
      const states = commandIds.map((commandId) => stateFor(commandId));
      if (states.includes("active")) return "active";
      if (artifactReady || (!requiresReview && states.every((state) => state === "done"))) return "done";
      if (states.includes("failed")) return "failed";
      return "waiting";
    };
    const readiness = workspaceSnapshot?.readiness ?? {};
    return {
      material: readiness.materials ? "done" : "waiting",
      frames: combinedStateFor(["src.extract_frames", "dst.extract_frames"], readiness.frames),
      faces: combinedStateFor(["src.extract_faces", "dst.extract_faces"], readiness.faces),
      clean: combinedStateFor(["src.sort_faces", "dst.sort_faces"], workspaceTaskReady("sort", workspaceSnapshot), true),
      mask: combinedStateFor(["xseg.train", "xseg.apply_src", "xseg.apply_dst"], readiness.xseg),
      train: stateFor("train.saehd", readiness.saehd),
      diagnose: diagnosticSnapshotCount >= 2 ? "done" : "waiting",
      merge: stateFor("merge.saehd", readiness.merged),
      encode: jobs.some(job => job.commandId.startsWith("encode.") && activeStates.has(job.state))
        ? "active"
        : readiness.encoded || ["encode.mp4", "encode.mp4_lossless", "encode.avi", "encode.mov_lossless"].some((commandId) => stateFor(commandId) === "done")
          ? "done"
          : ["encode.mp4", "encode.mp4_lossless"].some((commandId) => stateFor(commandId) === "failed")
            ? "failed"
            : "waiting",
    };
  }, [diagnosticSnapshotCount, jobs, workspaceSnapshot]);

  const nextWorkflowStep = useMemo(
    () => getNextWorkflowStep(
      workspaceSnapshot,
      diagnosticSnapshotCount,
      Boolean(
        evaluationJob
        && ["starting", "running", "waiting_input"].includes(evaluationJob.state)
        && evaluationJob.controls?.includes("evaluate"),
      ),
    ),
    [diagnosticSnapshotCount, evaluationJob, workspaceSnapshot],
  );

  useEffect(() => {
    if (!workspaceSnapshot || navigationTouchedRef.current) return;
    setSelectedStage(nextWorkflowStep.stage);
    setActiveTask(nextWorkflowStep.task);
    if (nextWorkflowStep.commandId) setTaskType(nextWorkflowStep.commandId);
  }, [nextWorkflowStep, workspaceSnapshot]);

  useEffect(() => {
    if (!workspaceSnapshot) return;
    const currentWorkspace = runtime.health?.runtime?.current?.workspace;
    if (
      currentWorkspace
      && workspaceSnapshot.root
      && currentWorkspace.toLocaleLowerCase() !== workspaceSnapshot.root.toLocaleLowerCase()
    ) return;
    const workspaceKey = workspaceSnapshot.root ?? currentWorkspace ?? "workspace";
    if (initialWorkspaceNavigationRef.current === workspaceKey) return;
    initialWorkspaceNavigationRef.current = workspaceKey;
    if (navigationTouchedRef.current || activeNav !== "overview") return;
    const destination = getInitialReadinessDestination(nextWorkflowStep.stage);
    if (!destination?.nav) return;
    setActiveNav(destination.nav);
    setConsoleCollapsed(true);
  }, [activeNav, nextWorkflowStep.stage, runtime.health?.runtime?.current?.workspace, workspaceSnapshot]);

  useEffect(() => {
    navigationTouchedRef.current = false;
  }, [runtime.health?.runtime?.current?.workspace]);

  const confirmDiscardXSeg = useCallback(() => {
    if (!xsegDirty) return true;
    const confirmed = window.confirm(t("当前 XSeg 标注尚未保存，确定放弃修改并继续吗？"));
    if (confirmed) setXsegDirty(false);
    return confirmed;
  }, [t, xsegDirty]);

  const handleNavigate = useCallback((id, label) => {
    if (id !== activeNav && !confirmDiscardXSeg()) return;
    navigationTouchedRef.current = true;
    setActiveNav(id);
    const nextStage = id === "overview" ? nextWorkflowStep.stage : navigationWorkflowStages[id];
    if (nextStage) setSelectedStage(nextStage);
    if (id === "overview") setActiveTask(nextWorkflowStep.task);
    if (id === "diagnostics") {
      setActiveTask("diagnose");
    }
    setConsoleCollapsed(id !== "overview");
    showToast(t("已切换到「{label}」工作区", { label }));
  }, [activeNav, confirmDiscardXSeg, nextWorkflowStep, showToast, t]);

  const handleStageSelect = useCallback((stage) => {
    const destination = workflowStageDestinations[stage.id];
    if (destination?.nav && destination.nav !== activeNav && !confirmDiscardXSeg()) return;
    navigationTouchedRef.current = true;
    setSelectedStage(stage.id);
    if (destination?.nav) setActiveNav(destination.nav);
    if (destination?.task) setActiveTask(destination.task);
    setConsoleCollapsed(destination?.nav !== "overview");
    showToast(t("已定位到「{label}」阶段", { label: stage.label }));
  }, [activeNav, confirmDiscardXSeg, showToast, t]);

  const handleTaskSelect = useCallback((task) => {
    navigationTouchedRef.current = true;
    setActiveTask(task.id);
    if (task.id === "sort" || task.id === "export") {
      setSelectedStage(task.id === "sort" ? "clean" : "encode");
      setActiveNav(task.id === "sort" ? "workflow.roles" : "export");
      setConsoleCollapsed(true);
      return;
    }
    if (task.id === "diagnose") {
      setSelectedStage("diagnose");
      setActiveNav("diagnostics");
      setConsoleCollapsed(true);
      showToast(t("已打开独立的质量诊断环节"));
      return;
    }
    if (task.id === "saehd") setSelectedStage("train");
    if (task.id === "xseg") setSelectedStage("mask");
    if (task.id === "merge") setSelectedStage("merge");
    if (task.id === "export") setSelectedStage("encode");
    const commandIds = pipelineCommandMap[task.id] ?? [];
    const existing = jobs.find(
      (job) => commandIds.includes(job.commandId) && activeStates.has(job.state),
    ) ?? jobs.find((job) => commandIds.includes(job.commandId));
    if (existing) {
      selectJob(existing.id);
      setConsoleCollapsed(false);
      showToast(t("已切换到任务：{label}", { label: existing.label }));
    } else if (commandIds.length) {
      setTaskType(commandIds[0]);
      setNewTaskOpen(true);
      showToast(t("「{label}」尚未启动，可从“新建任务”运行", { label: task.label }));
    } else {
      showToast(t("「{label}」将在后续外部窗口整合阶段接入", { label: task.label }), "warning");
    }
  }, [jobs, selectJob, showToast, t]);

  const handleStartJob = useCallback(async (commandId, options = {}) => {
    const job = await runAction(
      () => startJob(commandId, options),
      t("任务已启动，终端会话正在连接"),
      t("正在创建任务并连接终端…"),
    );
    setConsoleCollapsed(false);
    return job;
  }, [runAction, startJob, t]);

  const openCommand = useCallback((commandId) => {
    setTaskDefaults(null);
    setTaskType(commandId);
    setNewTaskOpen(true);
  }, []);

  const activateRecommendedAction = useCallback(() => {
    if (nextWorkflowStep.commandId) {
      openCommand(nextWorkflowStep.commandId);
      return;
    }
    if (nextWorkflowStep.target === "diagnostics") {
      handleNavigate("diagnostics", t("质量诊断"));
      return;
    }
    if (nextWorkflowStep.target === "export") { handleNavigate("export",t("视频导出")); return; }
    if (nextWorkflowStep.target === "roles") { handleNavigate("workflow.roles",t("选择人物")); setSelectedStage("clean"); return; }
    handleNavigate("video", t("工作区"));
  }, [handleNavigate, nextWorkflowStep, openCommand, t]);
  const consoleRecommendedAction = useMemo(() => ({
    label: t(nextWorkflowStep.label),
    commandId: nextWorkflowStep.commandId,
    onActivate: activateRecommendedAction,
  }), [activateRecommendedAction, nextWorkflowStep.commandId, nextWorkflowStep.label, t]);

  const handleResolvePreflight = useCallback((target) => {
    if (target === "parameters") return;
    setNewTaskOpen(false);
    if (target === "settings") {
      setActiveNav("settings");
      setConsoleCollapsed(true);
      return;
    }
    if (target === "console") {
      setActiveNav("overview");
      setConsoleCollapsed(false);
      showToast(t("已打开终端，请先停止占用资源的任务"), "warning");
      return;
    }
    if (target === "xseg") {
      setActiveNav("xseg");
      setSelectedStage("mask");
      setActiveTask("xseg");
      setConsoleCollapsed(true);
      return;
    }
    const destinations = {
      workspace: ["video", "material", "extract"],
      frames: ["workflow.frames", "frames", "extract"],
      faces: ["src", "faces", "src"],
      training: ["training", "train", "saehd"],
      merge: ["merge", "merge", "merge"],
    };
    const [nav, stage, task] = destinations[target] ?? destinations.workspace;
    setActiveNav(nav);
    setSelectedStage(stage);
    setActiveTask(task);
    setConsoleCollapsed(nav !== "overview");
  }, [showToast, t]);

  const openDatasetSample = useCallback((side, sample) => {
    setDatasetFocus(sample ? { side, sample, nonce: Date.now() } : null);
    setActiveNav(side);
    setConsoleCollapsed(true);
    setSelectedStage("faces");
    showToast(sample?.name
      ? t("已在 {side} 数据集中定位 {name}", { side: side.toUpperCase(), name: sample.name })
      : t("已打开 {side} 数据集", { side: side.toUpperCase() }));
  }, [showToast, t]);
  const consumeDatasetFocus = useCallback(() => setDatasetFocus(null), []);
  const openRoles = useCallback((side) => {
    setRoleSide(side); setActiveNav("workflow.roles"); setSelectedStage("clean"); setConsoleCollapsed(true);
  }, []);
  const openJobLog = useCallback((id) => { selectJob(id); setConsoleCollapsed(false); }, [selectJob]);

  const openXSegSample = useCallback((side, sample) => {
    if (!sample) return;
    setXsegSide(side);
    setXsegFocus({ side, sample, nonce: Date.now() });
    setActiveNav("xseg");
    setSelectedStage("mask");
    setActiveTask("xseg");
    setConsoleCollapsed(true);
    showToast(t("已打开 {side} 的 XSeg 编辑：{name}", {
      side: side.toUpperCase(),
      name: sample.name,
    }));
  }, [showToast, t]);
  const consumeXSegFocus = useCallback(() => setXsegFocus(null), []);

  const openDatasetImageTool = useCallback((toolId, side, sample) => {
    if (!sample) return;
    const toolLabel = {
      clarity: t("清晰增强"),
      "single-frame": t("单图合成"),
      "ai-edit": t("AI 图像编辑"),
    }[toolId] ?? t("图像工具");
    setToolFocus({ toolId, side, sample, nonce: Date.now() });
    setActiveNav("tools");
    setConsoleCollapsed(true);
    showToast(t("已将 {name} 带入图像工具：{tool}", {
      name: sample.name,
      tool: toolLabel,
    }));
  }, [showToast, t]);

  const handleArchivedJobs = useCallback((result) => {
    void refreshRuntime({ quiet: true });
    if (result.uncertain) return;
    showToast(result.archived
      ? t("已归档 {count} 个任务，可从 .webui/archive 恢复", { count: result.archived })
      : t("没有可归档的已结束任务"));
  }, [refreshRuntime, showToast, t]);

  const handleCreateTask = useCallback(async (options) => {
    try {
      await handleStartJob(taskType, options);
      setNewTaskOpen(false);
    } catch (error) {
      // The dialog stays open so the user can correct the missing input.
      throw error;
    }
  }, [handleStartJob, taskType]);

  const controlTraining = useCallback(async (operation, message) => {
    if (!trainingJob) {
      showToast(t("当前没有 SAEHD 训练任务"), "warning");
      return;
    }
    try {
      await runAction(
        () => control(operation, trainingJob.id),
        message,
        t({
          save: "正在保存训练模型…",
          backup: "正在创建训练备份…",
          preview: "正在刷新训练预览…",
          close: "正在安全保存并停止训练…",
        }[operation] ?? "正在处理训练控制…"),
      );
      if (operation === "preview") setPreviewRefresh((current) => current + 1);
    } catch {
      // runAction already surfaced a recovery-oriented toast.
    }
  }, [control, runAction, showToast, t, trainingJob]);

  const evaluateTraining = useCallback(async () => {
    if (!evaluationJob || !evaluationJob.controls?.includes("evaluate")) {
      showToast(t("当前训练任务不能生成评估快照"), "warning");
      throw new Error(t("当前训练任务不能生成评估快照"));
    }
    return runAction(
      () => control("evaluate", evaluationJob.id),
      t("评估请求已送入 Trainer，不会修改训练权重"),
      t("正在生成只读评估快照…"),
    );
  }, [control, evaluationJob, runAction, showToast, t]);

  const openQualityDiagnostics = useCallback(() => {
    setActiveNav("diagnostics");
    setSelectedStage("diagnose");
    setActiveTask("diagnose");
    setConsoleCollapsed(true);
  }, []);
  const openTrainingView = useCallback(() => {
    handleNavigate("training", t("模型训练"));
  }, [handleNavigate, t]);

  const openPoseAtlasCell = useCallback((cellId) => {
    setPoseAtlasFocus({ cellId, nonce: Date.now() });
    setActiveNav("tools");
    setConsoleCollapsed(true);
    showToast(t("已按同一姿势格打开数据图谱：{cellId}", { cellId }));
  }, [showToast, t]);

  const handleStopConfirm = useCallback(async () => {
    const targetJobId = stopTargetJobId;
    if (!targetJobId) return;
    setStopTargetJobId(null);
    await runAction(
      () => control("close", targetJobId),
      t("已请求安全停止；启动问答会直接结束，训练中会先保存"),
      t("正在安全停止训练…"),
    ).catch(() => {});
  }, [control, runAction, stopTargetJobId, t]);

  const handleCopyText = useCallback(async (value, successMessage = t("内容已复制")) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage);
    } catch {
      showToast(value, "warning");
    }
  }, [showToast, t]);
  const openNewTask = useCallback(() => { setTaskDefaults(null); setNewTaskOpen(true); }, []);
  const toggleConsole = useCallback(() => setConsoleCollapsed((current) => !current), []);
  const retryRuntimeConnection = useCallback(() => void refreshRuntime(), [refreshRuntime]);
  const safeStopSelectedJob = useCallback(() => {
    if (selectedJob?.id) setStopTargetJobId(selectedJob.id);
  }, [selectedJob?.id]);

  const workspacePath = runtime.health?.runtime?.current?.workspace ?? "workspace";
  const previewVersion = trainingJob?.previewVersion ?? previewRefresh;
  const previewUrl = trainingJob?.previewVersion
    ? `/api/jobs/${encodeURIComponent(trainingJob.id)}/preview?v=${trainingJob.previewVersion}`
    : null;
  const trainingMetric = trainingJob?.latestMetric;
  const trainingHistory = useTrainingHistory(trainingJob);
  const savedTrainingModel = resolveSavedTrainingModel(workspaceSnapshot?.models,trainingJob);
  const savedModelState = workspaceSnapshot ? getSavedTrainingModelState(workspaceSnapshot.models,trainingJob) : "loading";
  const resumeTraining = () => {
    setTaskType("train.saehd");
    setTaskDefaults({ ...(trainingJob?.parameters ?? {}), forceModelName:savedTrainingModel?.name ?? "", silentStart:Boolean(savedTrainingModel) });
    setNewTaskOpen(true);
  };
  const modelSummaryAside = useMemo(
    () => <ModelSummaryAside workspace={workspaceSnapshot} />,
    [workspaceSnapshot],
  );

  let mainContent;
  if (activeNav === "video") {
    mainContent = (
      <WorkspaceView
        key={runtime.health?.runtime?.current?.workspace}
        serviceOnline={runtime.serviceState === "online"}
        onError={showError}
        onNotice={showToast}
        onArchived={handleArchivedJobs}
        onWorkspaceChange={setWorkspaceSnapshot}
        jobs={jobs}
        onOpenJob={openJobLog}
        onOpenRoles={openRoles}
      />
    );
  } else if (activeNav === "workflow.frames") {
    mainContent = (
      <CommandCenterView
        title={t("视频帧提取")}
        description={t("从 SRC 与 DST 视频生成固定工作区帧序列。")}
        commands={commands}
        filter={frameCommandFilter}
        onOpenCommand={openCommand}
      />
    );
  } else if (activeNav === "workflow.faces") {
    mainContent = (
      <CommandCenterView
        title={t("人脸提取")}
        description={t("从 SRC 与 DST 帧序列生成 aligned 人脸数据集。")}
        commands={commands}
        filter={faceCommandFilter}
        onOpenCommand={openCommand}
      />
    );
  } else if (activeNav === "workflow.clean" || activeNav === "workflow.roles") {
    mainContent = (
      <RoleSelectionView side={roleSide} onSideChange={setRoleSide} workspace={workspaceSnapshot}
        onOpenCommand={openCommand} onError={showError} onNotice={showToast}
        onNavigateDataset={openDatasetSample} onWorkspaceChange={setWorkspaceSnapshot}/>
    );
  } else if (activeNav === "src" || activeNav === "dst") {
    mainContent = (
      <DatasetView
        side={activeNav}
        commands={commands}
        focusItem={datasetFocus?.side === activeNav ? datasetFocus.sample : null}
        focusNonce={datasetFocus?.side === activeNav ? datasetFocus.nonce : null}
        onFocusConsumed={consumeDatasetFocus}
        onOpenXSeg={openXSegSample}
        onOpenRoles={openRoles}
        onOpenTool={openDatasetImageTool}
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
        focusItem={xsegFocus?.side === xsegSide ? xsegFocus.sample : null}
        focusNonce={xsegFocus?.side === xsegSide ? xsegFocus.nonce : null}
        onFocusConsumed={consumeXSegFocus}
        onSideChange={setXsegSide}
        onMaskDirtyChange={setXsegDirty}
        onOpenCommand={openCommand}
        onError={showError}
        onNotice={showToast}
      />
    );
  } else if (activeNav === "training") {
    mainContent = (
      <CommandCenterView
        title={t("模型训练")}
        description={t("继续已有模型，或选择其他模型开始训练。")}
        actions={<div className="training-page-actions"><button type="button" className="button secondary" onClick={() => handleNavigate("overview",t("总览"))}>{t("训练预览与曲线")}</button><button type="button" className="button primary" disabled={trainingJob && activeStates.has(trainingJob.state)} onClick={resumeTraining}>{savedTrainingModel ? t("继续训练") : savedModelState === "empty" ? t("新建训练") : t("选择训练模型")}</button></div>}
        commands={commands}
        filter={trainingCommandFilter}
        onOpenCommand={openCommand}
        aside={modelSummaryAside}
      />
    );
  } else if (activeNav === "diagnostics") {
    mainContent = (
      <QualityDiagnosticsView
        evaluationJob={evaluationJob}
        refreshKey={evaluationJob?.latestEvaluationSnapshotId}
        onEvaluate={evaluateTraining}
        onOpenTraining={openTrainingView}
        onOpenPoseAtlas={openPoseAtlasCell}
        onError={showError}
        onNotice={showToast}
        onSnapshotCount={setDiagnosticSnapshotCount}
      />
    );
  } else if (activeNav === "merge") {
    mainContent = (
      <CommandCenterView
        title={t("模型应用")}
        description={t("从固定模型目录启动 SAEHD、AMP、ME 或 Quick 合成，产物统一写入 merged 序列。")}
        commands={commands}
        filter={mergeCommandFilter}
        onOpenCommand={openCommand}
        aside={modelSummaryAside}
      />
    );
  } else if (activeNav === "export") {
    mainContent = (
      <ExportView workspace={workspaceSnapshot} commands={commands} jobs={jobs} onOpenCommand={openCommand}
        onOpenJob={openJobLog} onError={showError} onNotice={showToast}/>
    );
  } else if (activeNav === "tools") {
    mainContent = (
      <ToolLabView
        workspaceKey={workspaceSnapshot?.root}
        onWorkspaceChange={setWorkspaceSnapshot}
        commands={commands}
        onOpenCommand={openCommand}
        onError={showError}
        onNotice={showToast}
        onNavigateDataset={openDatasetSample}
        poseFocus={poseAtlasFocus}
        toolFocus={toolFocus}
      />
    );
  } else if (activeNav === "settings") {
    mainContent = (
      <SettingsView
        onSwitchProject={setSwitchProject}
        health={runtime.health}
        jobs={jobs}
        onRetry={retryJob}
        onError={showError}
        onNotice={showToast}
      />
    );
  } else {
    mainContent = (
      <MemoWorkbenchGrid
        pipeline={{
          activeTask,
          tasks: livePipelineTasks,
          onSelectTask: handleTaskSelect,
        }}
        training={{
          iteration: trainingMetric?.iteration ?? 0,
          trainingState: trainingJob?.state ?? "idle",
          trainingJob,
          savedModel: savedTrainingModel,
          savedModelState,
          onResume: resumeTraining,
          onMerge: () => handleNavigate("merge",t("模型应用")),
          previewRefresh: previewVersion,
          previewUrl,
          etaSeconds: trainingMetric?.etaSeconds,
          targetIterations: trainingMetric?.targetIterations,
          startedAt: trainingJob?.startedAt,
          operationKey: trainingJob?.id ? `job:${trainingJob.id}` : "job:training-saehd",
          onSave: () => void controlTraining("save", t("保存请求已送入 Trainer")),
          onBackup: () => void controlTraining("backup", t("备份请求已送入 Trainer")),
          onRefresh: () => void controlTraining("preview", t("预览刷新请求已送入 Trainer")),
          onEvaluate: () => void evaluateTraining().catch(() => {}),
          onOpenDiagnostics: openQualityDiagnostics,
          canEvaluate: Boolean(
            evaluationJob
            && ["starting", "running", "waiting_input"].includes(evaluationJob.state)
            && evaluationJob.controls?.includes("evaluate")
          ),
          latestEvaluationSnapshotId: evaluationJob?.latestEvaluationSnapshotId,
          pendingAction,
          onSafeStop: () => trainingJob?.id && setStopTargetJobId(trainingJob.id),
        }}
        status={{
          trainingJob,
          telemetry: runtime.telemetry,
          lossHistory: trainingHistory.points,
          historyError: trainingHistory.error,
          onRetryHistory: trainingHistory.retry,
          onOpenModels: () => handleCopyText(`${workspacePath}\\model`, t("模型目录已复制")),
        }}
      />
    );
  }

  return (
    <AppShell activeNav={activeNav} onNavigate={handleNavigate}>
      <main className={`main-surface${activeNav === "tools" ? " is-tools" : ""}${activeNav === "diagnostics" ? " is-diagnostics" : ""}`}>
        <ProjectHeader
          projectName={runtime.health?.project?.name}
          workspacePath={workspacePath}
          serviceState={runtime.serviceState}
          telemetry={runtime.telemetry}
          onNewTask={openNewTask}
          onMenu={() => handleNavigate("video",t("工作区"))}
        />
        <div className="narrow-screen-notice" role="status">
          {t("当前为紧凑布局；建议将窗口展开至 1024 px 以上。所有功能仍可通过纵向滚动使用。")}
        </div>
        {runtime.serviceState === "loading" ? (
          <LoadingProgress
            className="global-loading-progress"
            compact
            label={t("正在检测本地服务…")}
            detail={t("正在读取运行时、显卡与项目状态")}
            operationKey="runtime-bootstrap"
          />
        ) : pendingAction && activeNav !== "diagnostics" ? (
          <LoadingProgress
            className="global-loading-progress"
            compact
            label={pendingAction}
            detail={t("完成后会自动更新当前视图")}
            operationKey={`app-action:${pendingAction}`}
          />
        ) : null}
        {activeNav !== "tools" && (
          <WorkflowBar
            selectedStage={selectedStage}
            stageStates={workflowStates}
            onSelectStage={handleStageSelect}
          />
        )}
        <Suspense
          fallback={(
            <div className="route-loading-state">
              <LoadingProgress
                label={t("正在打开工作区…")}
                detail={t("正在按需加载当前功能，终端任务不会中断")}
                operationKey={`route:${activeNav}`}
              />
            </div>
          )}
        >
          {mainContent}
        </Suspense>
        <div className="console-dock-slot">
          <div className="global-feedback-anchor">
            <div className="global-feedback-stack">
              <Toast
                message={toast.message}
                tone={toast.tone}
                onDismiss={() => setToast({ message: "", tone: "success" })}
              />
              <BackgroundOperations
                key={runtime.health?.project?.id ?? "connecting"}
                projectId={runtime.health?.project?.id}
                serviceOnline={runtime.serviceState === "online"}
                onError={showError}
                onNotice={showToast}
              />
              <ProgressHud />
            </div>
          </div>
          <ConsoleDock
            collapsed={consoleCollapsed}
            onToggle={toggleConsole}
            serviceState={runtime.serviceState}
            socketState={runtime.socketState}
            commands={commands}
            jobs={jobs}
            selectedJob={selectedJob}
            events={runtime.selectedEvents}
            onSelectJob={selectJob}
            onStart={handleStartJob}
            onOpenCommand={openCommand}
            onOpenNewTask={openNewTask}
            recommendedAction={consoleRecommendedAction}
            onRetry={retryRuntimeConnection}
            onInput={sendInput}
            onResize={resizeTerminal}
            onControl={control}
            onSafeStop={safeStopSelectedJob}
            onCopyText={handleCopyText}
            onError={showError}
            onNotice={showToast}
          />
        </div>
      </main>
      <NewTaskDialog
        open={newTaskOpen}
        taskType={taskType}
        workspacePath={workspacePath}
        serviceOnline={runtime.serviceState === "online"}
        commands={commands}
        workspace={workspaceSnapshot}
        telemetry={runtime.telemetry}
        initialParameters={taskDefaults}
        recommendedCommandId={nextWorkflowStep.commandId}
        onTaskType={(value) => {setTaskDefaults(null); setTaskType(value);}}
        onPreflight={preflight}
        onResolvePreflight={handleResolvePreflight}
        onClose={() => setNewTaskOpen(false)}
        onCreate={handleCreateTask}
      />
      <StopConfirmDialog
        open={Boolean(stopTargetJobId)}
        onCancel={() => setStopTargetJobId(null)}
        onConfirm={() => void handleStopConfirm()}
      />
      <ProjectSwitchDialog project={switchProject} onClose={() => setSwitchProject(null)} onReady={() => window.location.reload()}/>
    </AppShell>
  );
}
