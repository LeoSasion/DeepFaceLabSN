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
} from "@tabler/icons-react";

const TerminalSurface = lazy(() => import("./TerminalSurface.jsx"));

const stateLabels = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  waiting_input: "等待输入",
  stopping: "安全停止中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已强制终止",
  orphaned: "连接已丢失",
};

const interactiveStates = new Set(["starting", "running", "waiting_input", "stopping"]);

function formatClock(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
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
  const online = serviceState === "online";
  const connected = online && (!hasJob || socketState === "connected");
  const label = !online
    ? serviceState === "loading" ? "连接服务…" : "本地服务离线"
    : hasJob && socketState === "reconnecting" ? "正在重连"
      : hasJob && socketState === "connecting" ? "连接终端…"
        : connected ? "本地运行时在线" : "终端未连接";
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
  if (serviceState !== "online") {
    return (
      <div className="terminal-empty is-offline">
        <IconPlugConnectedX size={25} stroke={1.55} />
        <strong>本地运行时未连接</strong>
        <p>页面不会用模拟日志替代真实输出。启动或恢复本地服务后重试。</p>
        <button className="button secondary" type="button" onClick={onRetry}>重新连接</button>
      </div>
    );
  }
  return (
    <div className="terminal-empty">
      <IconTerminal2 size={25} stroke={1.55} />
      <strong>还没有任务会话</strong>
      <p>启动一个白名单工作流，真实 CLI 输出和问答会出现在这里。</p>
      <div className="terminal-empty-actions">
        {commands.map((command) => (
          <button className="button secondary" type="button" key={command.id} onClick={() => onStart(command.id)}>
            {command.shortLabel}
          </button>
        ))}
        <button className="button primary" type="button" onClick={onOpenNewTask}>
          <IconPlus size={16} />新建任务
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
}) {
  const [promptInput, setPromptInput] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setPromptInput(""), [selectedJob?.id]);

  const canInteract = selectedJob && interactiveStates.has(selectedJob.state);
  const isTraining = selectedJob?.category === "training";
  const duration = useMemo(
    () => formatDuration(selectedJob?.startedAt, selectedJob?.endedAt, now),
    [now, selectedJob?.endedAt, selectedJob?.startedAt],
  );

  const run = (action) => {
    Promise.resolve(action()).catch(onError);
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
          <strong id="console-title">终端监视器</strong>
          <span>{collapsed ? "展开" : "收起"}</span>
          {collapsed ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
        </button>
        <ConnectionBadge serviceState={serviceState} socketState={socketState} hasJob={Boolean(selectedJob)} />
        {selectedJob ? (
          <>
            <span className={`job-state-badge is-${selectedJob.state}`}>
              <i aria-hidden="true" />
              {stateLabels[selectedJob.state] ?? selectedJob.state}
            </span>
            <code className="runtime-command-line" title={selectedJob.commandLine}>{selectedJob.commandLine}</code>
            <dl className="runtime-header-stats">
              <div><dt>PID</dt><dd>{selectedJob.pid ?? "—"}</dd></div>
              <div><dt>时长</dt><dd>{duration}</dd></div>
              <div><dt>运行时</dt><dd>{selectedJob.profile === "legacy" ? "DFL legacy" : "DFL current"}</dd></div>
            </dl>
          </>
        ) : (
          <span className="runtime-header-empty">选择任务后显示命令、PID 和实时输出</span>
        )}
        <button className="button secondary runtime-new-task" type="button" onClick={onOpenNewTask} disabled={serviceState !== "online"}>
          <IconPlus size={16} />新建任务
        </button>
      </div>

      {collapsed ? null : (
        <>
          <div className="terminal-tabs" role="tablist" aria-label="任务终端会话">
            {jobs.length ? jobs.map((job) => (
              <button
                className={`terminal-tab ${selectedJob?.id === job.id ? "is-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={selectedJob?.id === job.id}
                key={job.id}
                onClick={() => onSelectJob(job.id)}
              >
                <i className={`session-dot is-${job.state}`} aria-hidden="true" />
                <span>{job.shortLabel ?? job.label}</span>
                <small>{stateLabels[job.state] ?? job.state}</small>
              </button>
            )) : (
              <span className="terminal-tabs-empty">会话列表为空</span>
            )}
          </div>

          {selectedJob ? (
            <div className="terminal-workspace">
              <div className="terminal-main">
                <Suspense fallback={<div className="terminal-loading">正在加载终端渲染器…</div>}>
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
                    placeholder={selectedJob.latestPrompt ?? (canInteract ? "在此输入 CLI 回答，Enter 发送" : "任务已结束，仅可查看日志")}
                    aria-label="CLI 输入"
                    disabled={!canInteract}
                  />
                  <button className="button primary prompt-send" type="submit" disabled={!canInteract}>
                    <IconSend size={15} />发送
                  </button>
                  <div className="quick-replies" aria-label="快捷回答">
                    <button type="button" onClick={() => run(() => onInput("\r"))} disabled={!canInteract}>默认</button>
                    <button type="button" onClick={() => run(() => onInput("y\r"))} disabled={!canInteract}>是</button>
                    <button type="button" onClick={() => run(() => onInput("n\r"))} disabled={!canInteract}>否</button>
                  </div>
                </form>
                {isTraining ? (
                  <div className="terminal-control-row">
                    <span>训练控制</span>
                    <button className="button secondary" type="button" onClick={() => run(() => onControl("save"))} disabled={!canInteract}>
                      <IconDeviceFloppy size={15} />保存
                    </button>
                    <button className="button secondary" type="button" onClick={() => run(() => onControl("backup"))} disabled={!canInteract}>
                      <IconArchive size={15} />备份
                    </button>
                    <button className="button secondary" type="button" onClick={() => run(() => onControl("preview"))} disabled={!canInteract}>
                      <IconRefresh size={15} />刷新预览
                    </button>
                    <button className="button danger" type="button" onClick={onSafeStop} disabled={!canInteract || selectedJob.state === "stopping"}>
                      <IconPlayerStop size={15} />安全停止
                    </button>
                  </div>
                ) : null}
              </div>
              <aside className="terminal-inspector" aria-label="终端会话详情">
                <div className="inspector-heading">
                  <span>会话详情</span>
                  <strong>{selectedJob.id.slice(-8)}</strong>
                </div>
                <dl>
                  <div><dt>命令</dt><dd>{selectedJob.label}</dd></div>
                  <div><dt>开始时间</dt><dd>{formatClock(selectedJob.startedAt)}</dd></div>
                  <div><dt>退出码</dt><dd>{selectedJob.exitCode ?? "—"}</dd></div>
                  <div><dt>最后序号</dt><dd>{selectedJob.sequence ?? 0}</dd></div>
                  <div><dt>终端连接</dt><dd>{socketState === "connected" ? "已连接" : "正在恢复"}</dd></div>
                </dl>
                {selectedJob.latestPrompt ? (
                  <div className="inspector-prompt">
                    <span>等待回答</span>
                    <p>{selectedJob.latestPrompt}</p>
                  </div>
                ) : null}
                <button className="inspector-path" type="button" onClick={() => onCopyPath(selectedJob.paths?.jobDirectory)}>
                  <IconFolderOpen size={15} />
                  <span><small>任务目录</small>{selectedJob.paths?.jobDirectory ?? "—"}</span>
                  <IconCopy size={14} />
                </button>
              </aside>
            </div>
          ) : (
            <EmptyTerminal
              serviceState={serviceState}
              commands={commands}
              onStart={(commandId) => run(() => onStart(commandId))}
              onOpenNewTask={onOpenNewTask}
              onRetry={onRetry}
            />
          )}
        </>
      )}
    </section>
  );
}
