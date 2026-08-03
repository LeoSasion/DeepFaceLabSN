import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  IconArchive,
  IconChevronDown,
  IconChevronUp,
  IconCircleCheck,
  IconCopy,
  IconDeviceFloppy,
  IconFolderOpen,
  IconPlayerStop,
  IconPlugConnected,
  IconPlugConnectedX,
  IconPlus,
  IconRefresh,
  IconSend,
  IconTerminal2,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useI18n } from "../i18n.jsx";
import {
  findAdjacentTerminalJobId,
  isTerminalSession,
  selectTerminalTabs,
} from "../domain/terminal-sessions.js";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const TerminalSurface = lazy(() => import("./TerminalSurface.jsx"));
const HIDDEN_TERMINAL_JOBS_STORAGE_KEY = "dfl-webui-hidden-terminal-jobs-v1";
const noop = () => {};

function readHiddenTerminalJobIds() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HIDDEN_TERMINAL_JOBS_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const stateLabels = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  waiting_input: "等待输入",
  stopping: "安全停止中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  orphaned: "连接已丢失",
};

const interactiveStates = new Set(["starting", "running", "waiting_input"]);
const progressingStates = new Set(["queued", "starting", "running", "stopping"]);

function jobStateLabel(job) {
  if (job?.state === "cancelled" && job.stopReason === "safe-stop-before-start") {
    return "启动前已停止";
  }
  if (job?.state === "cancelled" && job.stopReason?.startsWith("safe-stop")) {
    return "已安全停止";
  }
  return stateLabels[job?.state] ?? job?.state;
}

function formatClock(value, language) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatDuration(startedAt, endedAt, now) {
  if (!startedAt) return "—";
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function ConnectionBadge({ serviceState, socketState, hasJob }) {
  const { t } = useI18n();
  const online = serviceState === "online";
  const connected = online && (!hasJob || socketState === "connected");
  const label = !online
    ? serviceState === "loading" ? t("连接服务…") : t("本地服务离线")
    : hasJob && socketState === "reconnecting" ? t("正在重连")
      : hasJob && socketState === "connecting" ? t("连接终端…")
        : connected ? t("本地运行时在线") : t("终端未连接");
  return (
    <span className={`runtime-badge ${connected ? "is-online" : "is-offline"}`}>
      {connected
        ? <IconPlugConnected size={14} stroke={2} />
        : <IconPlugConnectedX size={14} stroke={2} />}
      {label}
    </span>
  );
}

function EmptyTerminal({ serviceState, commands, onStart, onOpenNewTask, onRetry }) {
  const { t } = useI18n();
  if (serviceState !== "online") {
    return (
      <div className="terminal-empty is-offline">
        <IconPlugConnectedX size={25} stroke={1.55} />
        <strong>{t("本地运行时未连接")}</strong>
        <p>{t("页面不会用模拟日志替代真实输出。启动或恢复本地服务后重试。")}</p>
        <button className="button secondary" type="button" onClick={onRetry}>{t("重新连接")}</button>
      </div>
    );
  }
  return (
    <div className="terminal-empty">
      <IconTerminal2 size={25} stroke={1.55} />
      <strong>{t("还没有任务会话")}</strong>
      <p>{t("启动一个白名单工作流，真实 CLI 输出和问答会出现在这里。")}</p>
      <div className="terminal-empty-actions">
        {commands.map((command) => (
          <button className="button secondary" type="button" key={command.id} onClick={() => onStart(command.id)}>
            {command.shortLabel}
          </button>
        ))}
        <button className="button primary" type="button" onClick={onOpenNewTask}>
          <IconPlus size={16} />{t("新建任务")}
        </button>
      </div>
    </div>
  );
}

export function ConsoleDock({
  collapsed,
  onToggle,
  serviceState,
  socketState,
  commands,
  jobs,
  selectedJob,
  events,
  onSelectJob,
  onStart,
  onOpenNewTask,
  onRetry,
  onInput,
  onResize,
  onControl,
  onSafeStop,
  onCopyPath,
  onError,
  onNotice = noop,
}) {
  const { language, t } = useI18n();
  const [promptInput, setPromptInput] = useState("");
  const [now, setNow] = useState(Date.now());
  const [pendingConsoleAction, setPendingConsoleAction] = useState(null);
  const [hiddenJobIds, setHiddenJobIds] = useState(readHiddenTerminalJobIds);
  const [showAllSessions, setShowAllSessions] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setPromptInput(""), [selectedJob?.id]);

  const hiddenJobIdSet = useMemo(() => new Set(hiddenJobIds), [hiddenJobIds]);
  const availableJobCount = jobs.reduce(
    (count, job) => count + (hiddenJobIdSet.has(job.id) ? 0 : 1),
    0,
  );
  const visibleJobs = useMemo(
    () => selectTerminalTabs(jobs, hiddenJobIdSet, {
      selectedJobId: selectedJob?.id,
      showAll: showAllSessions,
    }),
    [hiddenJobIdSet, jobs, selectedJob?.id, showAllSessions],
  );
  const overflowJobCount = Math.max(0, availableJobCount - visibleJobs.length);
  const hiddenFinishedCount = jobs.reduce(
    (count, job) => count + (hiddenJobIdSet.has(job.id) && isTerminalSession(job) ? 1 : 0),
    0,
  );
  const visibleFinishedCount = jobs.reduce(
    (count, job) => count + (!hiddenJobIdSet.has(job.id) && isTerminalSession(job) ? 1 : 0),
    0,
  );

  useEffect(() => {
    window.localStorage.setItem(HIDDEN_TERMINAL_JOBS_STORAGE_KEY, JSON.stringify(hiddenJobIds));
  }, [hiddenJobIds]);

  useEffect(() => {
    if (!selectedJob || !hiddenJobIdSet.has(selectedJob.id) || !visibleJobs.length) return;
    onSelectJob(visibleJobs[0].id);
  }, [hiddenJobIdSet, onSelectJob, selectedJob, visibleJobs]);

  useEffect(() => {
    if (!selectedJob && visibleJobs.length) onSelectJob(visibleJobs[0].id);
  }, [onSelectJob, selectedJob, visibleJobs]);

  const closeSessionTab = (job) => {
    if (!isTerminalSession(job)) return;
    const nextHidden = new Set(hiddenJobIdSet).add(job.id);
    setHiddenJobIds([...nextHidden]);
    if (selectedJob?.id === job.id) {
      onSelectJob(findAdjacentTerminalJobId(jobs, nextHidden, job.id));
    }
    onNotice(t("已关闭会话标签，任务日志仍保留"));
  };

  const clearFinishedTabs = () => {
    const finishedIds = jobs
      .filter((job) => isTerminalSession(job) && !hiddenJobIdSet.has(job.id))
      .map((job) => job.id);
    if (!finishedIds.length) return;
    const nextHidden = new Set([...hiddenJobIdSet, ...finishedIds]);
    setHiddenJobIds([...nextHidden]);
    setShowAllSessions(false);
    if (selectedJob && nextHidden.has(selectedJob.id)) {
      onSelectJob(jobs.find((job) => !nextHidden.has(job.id))?.id ?? null);
    }
    onNotice(t("已隐藏 {count} 个已结束会话，任务日志仍保留", { count: finishedIds.length }));
  };

  const restoreHiddenTabs = () => {
    setHiddenJobIds([]);
    onSelectJob(selectedJob?.id ?? jobs[0]?.id ?? null);
    onNotice(t("已恢复 {count} 个会话标签", { count: hiddenFinishedCount }));
  };

  const canInteract = selectedJob && interactiveStates.has(selectedJob.state);
  const canControlTrainer = selectedJob?.state === "running" && !selectedJob.latestPrompt;
  const canStop = selectedJob && ["starting", "running", "waiting_input"].includes(selectedJob.state);
  const isTraining = selectedJob?.category === "training";
  const duration = useMemo(
    () => formatDuration(selectedJob?.startedAt, selectedJob?.endedAt, now),
    [now, selectedJob?.endedAt, selectedJob?.startedAt],
  );
  const jobMetric = selectedJob?.latestMetric;
  const trainingProgressValue = jobMetric?.targetIterations > 0
    ? (jobMetric.iteration / jobMetric.targetIterations) * 100
    : undefined;
  const streamedProgress = selectedJob?.latestProgress;
  const streamedProgressAge = streamedProgress?.updatedAt
    ? now - new Date(streamedProgress.updatedAt).getTime()
    : Number.POSITIVE_INFINITY;
  const visibleStreamedProgress = streamedProgress
    && (streamedProgress.percent < 100 || streamedProgressAge < 4000)
    ? streamedProgress
    : null;
  const jobProgressValue = Number.isFinite(trainingProgressValue)
    ? trainingProgressValue
    : visibleStreamedProgress?.percent;
  const jobProgressDetail = Number.isFinite(trainingProgressValue)
    ? t("按 Trainer 目标迭代计算")
    : visibleStreamedProgress?.stage
      ? t("当前阶段：{stage}", { stage: visibleStreamedProgress.stage })
      : t("实时输出与状态会持续写入当前会话");
  const jobProgressCurrent = Number.isFinite(trainingProgressValue)
    ? jobMetric.iteration
    : visibleStreamedProgress?.current;
  const jobProgressTotal = Number.isFinite(trainingProgressValue)
    ? jobMetric.targetIterations
    : visibleStreamedProgress?.total;
  const jobProgressEta = Number.isFinite(trainingProgressValue)
    ? jobMetric.etaSeconds
    : visibleStreamedProgress?.etaSeconds;
  const jobProgressLabel = selectedJob?.state === "stopping"
    ? t("正在安全停止 {label}", { label: selectedJob.label })
    : selectedJob?.state === "starting"
      ? t("{label} 正在启动", { label: selectedJob.label })
      : t("{label} 正在运行", { label: selectedJob?.label });

  const run = (action, progressLabel = null) => {
    if (progressLabel) setPendingConsoleAction(progressLabel);
    Promise.resolve(action()).catch(onError).finally(() => {
      if (progressLabel) setPendingConsoleAction(null);
    });
  };
  const submitPrompt = (event) => {
    event.preventDefault();
    if (!canInteract) return;
    run(() => onInput(`${promptInput}\r`));
    setPromptInput("");
  };

  return (
    <section className={`console-dock runtime-console ${collapsed ? "is-collapsed" : ""}`} aria-labelledby="console-title">
      <div className="runtime-console-header">
        <button className="console-title-button" type="button" onClick={onToggle}>
          <IconTerminal2 size={17} stroke={1.8} />
          <strong id="console-title">{t("终端监视器")}</strong>
          <span>{collapsed ? t("展开") : t("收起")}</span>
          {collapsed ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
        </button>
        <ConnectionBadge serviceState={serviceState} socketState={socketState} hasJob={Boolean(selectedJob)} />
        {selectedJob ? (
          <>
            <span className={`job-state-badge is-${selectedJob.state}`}>
              <i aria-hidden="true" />
              {t(jobStateLabel(selectedJob))}
            </span>
            <code className="runtime-command-line" title={selectedJob.commandLine}>{selectedJob.commandLine}</code>
            <dl className="runtime-header-stats">
              <div><dt>PID</dt><dd>{selectedJob.pid ?? "—"}</dd></div>
              <div><dt>{t("时长")}</dt><dd>{duration}</dd></div>
              <div><dt>{t("运行时")}</dt><dd>{selectedJob.profile === "legacy" ? "DFL legacy" : "DFL current"}</dd></div>
            </dl>
          </>
        ) : (
          <span className="runtime-header-empty">{t("选择任务后显示命令、PID 和实时输出")}</span>
        )}
        <button className="button secondary runtime-new-task" type="button" onClick={onOpenNewTask} disabled={serviceState !== "online"}>
          <IconPlus size={16} />{t("新建任务")}
        </button>
      </div>

      {collapsed ? null : (
        <>
          <div className="terminal-tabs">
            <div className="terminal-tab-list" role="tablist" aria-label={t("任务终端会话")}>
              {visibleJobs.length ? visibleJobs.map((job) => (
                <div
                  className={`terminal-tab-shell ${isTerminalSession(job) ? "is-closable" : ""} ${selectedJob?.id === job.id ? "is-active" : ""}`}
                  role="presentation"
                  key={job.id}
                >
                  <button
                    className="terminal-tab"
                    type="button"
                    role="tab"
                    aria-selected={selectedJob?.id === job.id}
                    onClick={() => onSelectJob(job.id)}
                  >
                    <i className={`session-dot is-${job.state}`} aria-hidden="true" />
                    <span>{job.shortLabel ?? job.label}</span>
                    <small>{t(jobStateLabel(job))}</small>
                  </button>
                  {isTerminalSession(job) ? (
                    <button
                      className="terminal-tab-close"
                      type="button"
                      title={t("关闭此标签；任务日志仍会保留")}
                      aria-label={t("关闭 {label} 会话", { label: job.shortLabel ?? job.label })}
                      onClick={() => closeSessionTab(job)}
                    >
                      <IconX size={13} stroke={2} />
                    </button>
                  ) : null}
                </div>
              )) : jobs.length ? (
                <span className="terminal-tabs-empty">{t("已隐藏全部已结束会话，任务日志仍保留")}</span>
              ) : (
                <span className="terminal-tabs-empty">{t("会话列表为空")}</span>
              )}
            </div>
            <div className="terminal-tabs-actions" role="group" aria-label={t("会话标签管理")}>
              {overflowJobCount ? (
                <button
                  className="terminal-tabs-action"
                  type="button"
                  onClick={() => setShowAllSessions(true)}
                  title={t("显示另外 {count} 个历史会话", { count: overflowJobCount })}
                >
                  +{overflowJobCount} {t("历史")}
                </button>
              ) : showAllSessions && availableJobCount > 7 ? (
                <button className="terminal-tabs-action" type="button" onClick={() => setShowAllSessions(false)}>
                  {t("收起历史")}
                </button>
              ) : null}
              {visibleFinishedCount ? (
                <button
                  className="terminal-tabs-action is-clear"
                  type="button"
                  onClick={clearFinishedTabs}
                  title={t("隐藏全部已结束会话，任务日志仍保留")}
                >
                  <IconTrash size={12} stroke={1.9} />{t("清理已结束")}
                </button>
              ) : null}
              {hiddenFinishedCount ? (
                <button
                  className="terminal-tabs-action"
                  type="button"
                  onClick={restoreHiddenTabs}
                  title={t("恢复 {count} 个已隐藏会话", { count: hiddenFinishedCount })}
                >
                  {t("恢复")} {hiddenFinishedCount}
                </button>
              ) : null}
            </div>
          </div>

          {selectedJob ? (
            <div className="terminal-workspace">
              <div className="terminal-main">
                {pendingConsoleAction ? (
                  <LoadingProgress compact label={pendingConsoleAction} detail={t("终端输出会保留在当前会话")} />
                ) : progressingStates.has(selectedJob.state) ? (
                  <LoadingProgress
                    compact
                    label={jobProgressLabel}
                    detail={jobProgressDetail}
                    value={jobProgressValue}
                    current={jobProgressCurrent}
                    total={jobProgressTotal}
                    etaSeconds={jobProgressEta}
                    startedAt={selectedJob.startedAt}
                    rememberDuration={false}
                  />
                ) : selectedJob.state === "waiting_input" ? (
                  <div className="terminal-waiting-input" role="status">
                    <strong>{t("等待终端输入")}</strong>
                    <span>{selectedJob.latestPrompt ?? t("请在下方输入框回答 DFL 问题后继续")}</span>
                  </div>
                ) : null}
                <Suspense fallback={<div className="terminal-loading"><LoadingProgress compact label={t("正在加载终端渲染器…")} detail={t("正在准备本地终端画布")}/></div>}>
                  <TerminalSurface
                    key={selectedJob.id}
                    events={events}
                    interactive={Boolean(canInteract)}
                    onInput={(value) => run(() => onInput(value))}
                    onResize={onResize}
                  />
                </Suspense>
                <form className="terminal-prompt-row" onSubmit={submitPrompt}>
                  <span className="prompt-mark" aria-hidden="true">&gt;</span>
                  <input
                    value={promptInput}
                    onChange={(event) => setPromptInput(event.target.value)}
                    placeholder={selectedJob.state === "stopping"
                      ? t("正在安全停止，已暂停终端输入")
                      : selectedJob.latestPrompt ?? (canInteract ? t("在此输入 CLI 回答，Enter 发送") : t("任务已结束，仅可查看日志"))}
                    aria-label={t("CLI 输入")}
                    disabled={!canInteract}
                  />
                  <button className="button primary prompt-send" type="submit" disabled={!canInteract}>
                    <IconSend size={15} />{t("发送")}
                  </button>
                  <div className="quick-replies" aria-label={t("快捷回答")}>
                    <button type="button" onClick={() => run(() => onInput("\r"))} disabled={!canInteract}>{t("默认")}</button>
                    <button type="button" onClick={() => run(() => onInput("y\r"))} disabled={!canInteract}>{t("是")}</button>
                    <button type="button" onClick={() => run(() => onInput("n\r"))} disabled={!canInteract}>{t("否")}</button>
                  </div>
                </form>
                {isTraining ? (
                  <div className="terminal-control-row">
                    <span>{t("训练控制")}</span>
                    <button className="button secondary" type="button" onClick={() => run(() => onControl("save"), t("正在保存训练模型…"))} disabled={!canControlTrainer || Boolean(pendingConsoleAction)}>
                      <IconDeviceFloppy size={15} />{t("保存")}
                    </button>
                    <button className="button secondary" type="button" onClick={() => run(() => onControl("backup"), t("正在创建训练备份…"))} disabled={!canControlTrainer || Boolean(pendingConsoleAction)}>
                      <IconArchive size={15} />{t("备份")}
                    </button>
                    <button className="button secondary" type="button" onClick={() => run(() => onControl("preview"), t("正在刷新训练预览…"))} disabled={!canControlTrainer || Boolean(pendingConsoleAction)}>
                      <IconRefresh size={15} />{t("刷新预览")}
                    </button>
                    <button className="button danger" type="button" onClick={onSafeStop} disabled={!canStop || selectedJob.state === "stopping"}>
                      <IconPlayerStop size={15} />{t("安全停止")}
                    </button>
                  </div>
                ) : null}
              </div>
              <aside className="terminal-inspector" aria-label={t("终端会话详情")}>
                <div className="inspector-heading">
                  <span>{t("会话详情")}</span>
                  <strong>{selectedJob.id.slice(-8)}</strong>
                </div>
                <dl>
                  <div><dt>{t("命令")}</dt><dd>{selectedJob.label}</dd></div>
                  <div><dt>{t("开始时间")}</dt><dd>{formatClock(selectedJob.startedAt, language)}</dd></div>
                  <div><dt>{t("退出码")}</dt><dd>{selectedJob.exitCode ?? "—"}</dd></div>
                  <div><dt>{t("最后序号")}</dt><dd>{selectedJob.sequence ?? 0}</dd></div>
                  <div><dt>{t("终端连接")}</dt><dd>{socketState === "connected" ? t("已连接") : t("正在恢复")}</dd></div>
                </dl>
                {selectedJob.latestPrompt ? (
                  <div className="inspector-prompt">
                    <span>{t("等待回答")}</span>
                    <p>{selectedJob.latestPrompt}</p>
                  </div>
                ) : null}
                <button className="inspector-path" type="button" onClick={() => onCopyPath(selectedJob.paths?.jobDirectory)}>
                  <IconFolderOpen size={15} />
                  <span><small>{t("任务目录")}</small>{selectedJob.paths?.jobDirectory ?? "—"}</span>
                  <IconCopy size={14} />
                </button>
              </aside>
            </div>
          ) : (
            <EmptyTerminal
              serviceState={serviceState}
              commands={commands}
              onStart={(commandId) => run(() => onStart(commandId), t("正在创建任务并连接终端…"))}
              onOpenNewTask={onOpenNewTask}
              onRetry={() => run(onRetry, t("正在重新连接本地服务…"))}
            />
          )}
        </>
      )}
    </section>
  );
}
