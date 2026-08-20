import { useEffect, useRef, useState } from "react";
import {
  IconChevronRight,
  IconCircleCheck,
  IconCloudDownload,
  IconGlobe,
  IconLoader2,
  IconPlayerPlay,
  IconSettings,
  IconShieldCheck,
  IconTerminal2,
} from "@tabler/icons-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { PlainLog } from "./PlainLog.jsx";

function IdleTerminal({ logs }) {
  return (
    <div className="terminal-fallback" role="log" aria-label="终端等待启动">
      <PlainLog lines={logs} compact />
      <div className="terminal-cursor-line">
        <span>尚未启动项目进程。请从右侧选择“启动 WebUI”或“传统 BAT 模式”。</span>
      </div>
      <div className="terminal-help">启动器不会在打开时静默启动 WebUI。</div>
    </div>
  );
}

function InteractiveTerminal({ url, logs }) {
  const host = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!url || !host.current) return undefined;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.42,
      scrollback: 4000,
      theme: {
        background: "#020705",
        foreground: "#c9d7cf",
        cursor: "#54f4bb",
        selectionBackground: "#164c39",
        black: "#020705",
        green: "#54f4bb",
        brightGreen: "#79f7c8",
        yellow: "#f3b83f",
        red: "#ff5a46",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();

    const socket = new WebSocket(url);
    socket.addEventListener("open", () => setConnected(true));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "output") terminal.write(message.data || "");
        if (message.type === "error") terminal.writeln("\r\n\u001b[31m" + (message.message || "终端连接出错") + "\u001b[0m");
      } catch {
        terminal.write(String(event.data));
      }
    });
    socket.addEventListener("close", () => setConnected(false));

    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      terminal.dispose();
    };
  }, [url]);

  if (!url) return <IdleTerminal logs={logs} />;

  return (
    <>
      <div className="xterm-host" ref={host} />
      <span className={"terminal-connection" + (connected ? " is-connected" : "")}>
        {connected ? "终端已连接" : "正在连接终端"}
      </span>
    </>
  );
}

function ActionRow({
  icon: Icon,
  title,
  subtitle,
  hoverTitle,
  hoverSubtitle,
  primary,
  dangerOnHover,
  disabled,
  busy,
  onClick,
}) {
  const className = "action-row"
    + (primary ? " is-primary" : "")
    + (dangerOnHover ? " is-stop-action" : "");
  return (
    <button
      className={className}
      aria-label={dangerOnHover ? hoverTitle : undefined}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <span className="action-row__icon">
        {busy ? <IconLoader2 className="spin" size={19} /> : <Icon size={19} stroke={1.8} />}
      </span>
      <span className="action-row__copy">
        <strong>
          <span className="action-row__default-copy">{title}</span>
          {hoverTitle && <span className="action-row__hover-copy">{hoverTitle}</span>}
        </strong>
        {(subtitle || hoverSubtitle) && (
          <small>
            <span className="action-row__default-copy">{subtitle}</span>
            {hoverSubtitle && <span className="action-row__hover-copy">{hoverSubtitle}</span>}
          </small>
        )}
      </span>
      <IconChevronRight className="action-row__chevron" size={16} />
    </button>
  );
}

function ReadySidebar({ state, busyAction, onAction }) {
  const updateTitle = state.updateAvailable ? "下载并更新项目" : "检查项目更新";
  const webuiAction = state.webuiRunning ? "stopWebUi" : "startWebUi";
  const webuiPid = Number.isInteger(state.webuiPid) && state.webuiPid > 0
    ? `PID ${state.webuiPid}`
    : null;
  return (
    <aside className="ready-sidebar">
      <section>
        <h2>运行模式</h2>
        <div className="action-stack">
          <ActionRow
            icon={IconPlayerPlay}
            title={state.webuiRunning ? "WebUI 运行中" : "启动 WebUI"}
            subtitle={state.webuiRunning ? (webuiPid || "本地服务在线") : "点击后启动本地服务与浏览器"}
            hoverTitle={state.webuiRunning ? "结束 WebUI" : null}
            hoverSubtitle={state.webuiRunning ? "点击后停止本地服务" : null}
            dangerOnHover={state.webuiRunning}
            primary
            busy={busyAction === webuiAction}
            onClick={() => onAction(webuiAction)}
          />
          <ActionRow
            icon={IconTerminal2}
            title="传统 BAT 模式"
            subtitle="进入原有命令行工作流"
            busy={busyAction === "openLegacy"}
            onClick={() => onAction("openLegacy")}
          />
        </div>
      </section>

      <section>
        <h2>环境工具</h2>
        <div className="action-stack action-stack--compact">
          <ActionRow icon={IconSettings} title="首次配置 / 重新检测" busy={busyAction === "runFirstSetup"} onClick={() => onAction("runFirstSetup")} />
          <ActionRow icon={IconCloudDownload} title={updateTitle} busy={busyAction === "checkUpdates" || busyAction === "applyUpdate"} onClick={() => onAction(state.updateAvailable ? "applyUpdate" : "checkUpdates")} />
          <ActionRow icon={IconShieldCheck} title="修复依赖" busy={busyAction === "repairDependencies"} onClick={() => onAction("repairDependencies")} />
          <ActionRow icon={IconGlobe} title="切换下载镜像" busy={busyAction === "toggleMirror"} onClick={() => onAction("toggleMirror")} />
        </div>
      </section>

      <section className="project-facts">
        <dl>
          <div><dt>项目目录</dt><dd title={state.projectDir}>{state.projectDir}</dd></div>
          <div><dt>镜像源</dt><dd>{state.mirrorLabel || "自动选择"}</dd></div>
          <div><dt>最后检查</dt><dd>{state.lastCheck || "尚未检查"}</dd></div>
        </dl>
      </section>
    </aside>
  );
}

export function ReadyView({ state, logs, busyAction, onAction }) {
  return (
    <main className="ready-layout">
      <section className="terminal-panel panel-line">
        <header className="terminal-tabs">
          <h1>交互终端</h1>
          <div className="terminal-tabs__group" role="tablist" aria-label="终端输出视图">
            <button className="is-active" role="tab" aria-selected="true">启动器</button>
            <button role="tab" aria-selected="false">任务输出</button>
          </div>
          <span className="terminal-mode"><IconTerminal2 size={14} />ConPTY</span>
        </header>
        <div className="terminal-stage">
          <InteractiveTerminal url={state.terminalUrl} logs={logs} />
        </div>
      </section>
      <ReadySidebar state={state} busyAction={busyAction} onAction={onAction} />
      <footer className="status-rail">
        <span className="status-rail__healthy"><IconCircleCheck size={14} />本地运行</span>
        <span><IconTerminal2 size={14} />{state.terminalUrl ? "终端可交互" : "等待用户启动"}</span>
        <span className="status-rail__hint">快捷键：↑/↓ 选择　Enter 确认　R 刷新　Q 退出</span>
      </footer>
    </main>
  );
}
