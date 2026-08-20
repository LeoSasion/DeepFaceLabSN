import { useEffect, useState } from "react";
import {
  IconArrowRight,
  IconBrandGithub,
  IconBrandNodejs,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCloudDownload,
  IconCpu2,
  IconDeviceDesktopBolt,
  IconExternalLink,
  IconGauge,
  IconGlobe,
  IconLoader2,
  IconSettings,
  IconTerminal2,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { launcherBridge } from "../bridge.js";
import { BRAND_MARK } from "./TitleBar.jsx";
import { PlainLog } from "./PlainLog.jsx";

const STATUS_LABELS = {
  complete: "已完成",
  installed: "已安装",
  downloading: "正在下载",
  installing: "正在安装",
  checking: "正在检查",
  waiting: "等待中",
  pending: "等待中",
  error: "需要处理",
};

const STEP_COPY = [
  ["environment", "环境检测"],
  ["project", "获取项目"],
  ["dependencies", "安装依赖"],
  ["finish", "准备完成"],
];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatProgress(item) {
  if (!Number.isFinite(item.downloaded) || !Number.isFinite(item.total)) {
    return item.detail || "";
  }
  return formatBytes(item.downloaded) + " / " + formatBytes(item.total);
}

function StepRail({ steps }) {
  const map = new Map((steps || []).map((step) => [step.id, step.status]));
  return (
    <aside className="step-rail">
      <nav aria-label="安装步骤">
        {STEP_COPY.map(([id, label], index) => {
          const status = map.get(id) || (index === 0 ? "active" : "upcoming");
          return (
            <div className={"step-rail__item is-" + status} key={id}>
              <span className="step-rail__index">
                {status === "complete" ? <IconCheck size={14} /> : index + 1}
              </span>
              <span>{label}</span>
            </div>
          );
        })}
      </nav>
      <img src={BRAND_MARK} alt="DeepFaceLabSN" className="brand-mark brand-mark--large" />
    </aside>
  );
}

function RuntimeIcon({ id }) {
  const props = { size: 22, stroke: 1.7 };
  if (id === "project" || id === "git") return <IconBrandGithub {...props} />;
  if (id === "node") return <IconBrandNodejs {...props} />;
  if (id === "cuda") return <IconDeviceDesktopBolt {...props} />;
  if (id === "cudnn") return <IconCpu2 {...props} />;
  if (id === "python") return <IconTerminal2 {...props} />;
  return <IconCloudDownload {...props} />;
}

function RuntimeStateIcon({ status }) {
  if (status === "installed" || status === "complete") {
    return <span className="runtime-state runtime-state--complete"><IconCheck size={15} /></span>;
  }
  if (status === "downloading" || status === "installing" || status === "checking") {
    return <span className="runtime-state runtime-state--working"><IconLoader2 size={16} /></span>;
  }
  if (status === "error") {
    return <span className="runtime-state runtime-state--error"><IconX size={15} /></span>;
  }
  return <span className="runtime-state runtime-state--waiting"><IconGauge size={16} /></span>;
}

function RuntimeRow({ item }) {
  const working = ["downloading", "installing", "checking"].includes(item.status);
  const pct = Number.isFinite(item.progress) ? Math.max(0, Math.min(100, item.progress)) : null;

  return (
    <article className={"runtime-row" + (working ? " is-working" : "") + (item.status === "error" ? " is-error" : "")}>
      <div className="runtime-row__kind">
        <RuntimeStateIcon status={item.status} />
        <span className="runtime-row__product"><RuntimeIcon id={item.id} />{item.label}</span>
      </div>
      <div className={"runtime-row__status is-" + item.status}>
        <strong>{STATUS_LABELS[item.status] || item.status}</strong>
        <small>{item.detail || (item.status === "installed" ? "可用" : "")}</small>
      </div>
      <div className="runtime-row__source">
        <small>来源</small>
        <span>{item.source || "项目镜像"}</span>
      </div>
      <div className="runtime-row__evidence">
        {working ? (
          <>
            <div className="runtime-row__progress-meta">
              <strong>{pct === null ? "处理中" : Math.round(pct) + "%"}</strong>
              <span>{formatProgress(item)}</span>
            </div>
            <div className={"progress-track" + (pct === null ? " is-indeterminate" : "")}>
              <span style={pct === null ? undefined : { width: pct + "%" }} />
            </div>
          </>
        ) : item.link ? (
          <button className="text-action" onClick={() => launcherBridge.request("openExternal", { url: item.link })}>
            查看详情 <IconExternalLink size={13} />
          </button>
        ) : (
          <span className="runtime-row__dash">—</span>
        )}
      </div>
    </article>
  );
}

function InstallLog({ logs, onClear }) {
  return (
    <section className="install-log panel-line">
      <header className="section-bar">
        <span><IconChevronRight size={16} />安装终端</span>
        <button className="quiet-action" onClick={onClear}><IconTrash size={14} />清空</button>
      </header>
      <PlainLog lines={logs} />
    </section>
  );
}

export function InstallView({ state, logs, busy, onAction, onClearLogs }) {
  const hasError = state.runtimeItems.some((item) => item.status === "error");
  const [networkOpen, setNetworkOpen] = useState(false);
  const [proxyMode, setProxyMode] = useState(state.gitProxyMode || "auto");
  const [proxy, setProxy] = useState(state.gitProxy || "");
  const [gitMirror, setGitMirror] = useState(state.gitMirror || "");

  useEffect(() => {
    setProxyMode(state.gitProxyMode || "auto");
    setProxy(state.gitProxy || "");
    setGitMirror(state.gitMirror || "");
  }, [state.gitProxyMode, state.gitProxy, state.gitMirror]);

  const saveGitNetwork = async () => {
    const saved = await onAction("setGitNetwork", { mode: proxyMode, proxy, mirror: gitMirror });
    if (saved) setNetworkOpen(false);
  };

  return (
    <div className="install-layout">
      <StepRail steps={state.steps} />
      <main className="install-main">
        <div className="install-main__intro">
          <p className="eyebrow">首次运行 · 本地部署</p>
          <h1>准备本地运行环境</h1>
          <p>启动器将为 DeepFaceLabSN 配置项目文件和必要的本地运行组件。</p>
        </div>

        <section className="runtime-list panel-line" aria-label="运行环境组件">
          {state.runtimeItems.map((item) => <RuntimeRow item={item} key={item.id} />)}
        </section>

        <InstallLog logs={logs} onClear={onClearLogs} />

        <footer className="install-footer">
          {networkOpen && (
            <section id="git-network-settings" className="git-network-popover" aria-label="GitHub 网络设置">
              <header>
                <div>
                  <strong>GitHub 网络策略</strong>
                  <small>代理只作用于启动器 Git 命令；不会修改系统或全局 Git 配置。</small>
                </div>
                <button aria-label="关闭 GitHub 网络设置" className="quiet-action" onClick={() => setNetworkOpen(false)}><IconX size={15} /></button>
              </header>
              <label>
                <span>连接方式</span>
                <select value={proxyMode} onChange={(event) => setProxyMode(event.target.value)}>
                  <option value="auto">自动检测系统 / 环境代理</option>
                  <option value="direct">仅直连</option>
                  <option value="manual">手动代理</option>
                </select>
              </label>
              <label>
                <span>手动代理</span>
                <input
                  value={proxy}
                  disabled={proxyMode !== "manual"}
                  onChange={(event) => setProxy(event.target.value)}
                  placeholder="http://127.0.0.1:7890 或 socks5h://127.0.0.1:7890"
                />
              </label>
              <label>
                <span>自定义 Git 后备镜像（可选）</span>
                <input
                  value={gitMirror}
                  onChange={(event) => setGitMirror(event.target.value)}
                  placeholder="留空使用内置 Gitee 国内仓库"
                />
              </label>
              <p>内置后备源：https://gitee.com/LeoSasion/DeepFaceLabSN.git。自定义时只填写由你控制或明确信任的镜像。</p>
              <div className="git-network-popover__actions">
                <button onClick={() => setNetworkOpen(false)}>取消</button>
                <button className="is-primary" disabled={busy} onClick={saveGitNetwork}>保存策略</button>
              </div>
            </section>
          )}
          <div className="install-setting">
            <IconSettings size={17} />
            <span>安装路径</span>
            <code title={state.installPath}>{state.installPath}</code>
            <button onClick={() => onAction("chooseInstallPath")}>更改</button>
          </div>
          <div className="install-setting install-setting--network">
            <IconBrandGithub size={17} />
            <span>GitHub</span>
            <button
              className="select-like"
              title={state.gitNetworkLabel}
              aria-expanded={networkOpen}
              aria-controls="git-network-settings"
              onClick={() => setNetworkOpen((value) => !value)}
            >
              {state.gitNetworkLabel || "自动检测网络"}
              <IconChevronDown size={14} />
            </button>
          </div>
          <div className="install-setting install-setting--mirror">
            <IconGlobe size={17} />
            <span>下载镜像</span>
            <button className="select-like" onClick={() => onAction("toggleMirror")}>
              {state.mirrorLabel || (state.mirror === "china" ? "国内镜像" : "自动选择")}
              <IconChevronDown size={14} />
            </button>
          </div>
          <button className="primary-action" disabled={busy} onClick={() => onAction(hasError ? "retryBootstrap" : "runBootstrap")}>
            {busy && <IconLoader2 className="spin" size={17} />}
            {hasError ? "重试安装" : "继续安装"}
            {!busy && <IconArrowRight size={17} />}
          </button>
        </footer>
      </main>
    </div>
  );
}
