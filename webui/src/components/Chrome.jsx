import { useEffect, useState } from "react";
import {
  IconBoxModel2,
  IconCheck,
  IconChevronRight,
  IconFileExport,
  IconFolder,
  IconLayoutDashboard,
  IconMasksTheater,
  IconMenu2,
  IconMinus,
  IconPencil,
  IconPlus,
  IconSettings,
  IconSquare,
  IconStack2,
  IconTool,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { workflowStages } from "../data/dashboard.js";

const DESKTOP_BREAKPOINT = 1020;
const DESKTOP_DESIGN_WIDTH = 1440;
const DESKTOP_DESIGN_HEIGHT = 900;
const MINIMUM_DESKTOP_SCALE = 0.78;

function readDesktopUiScale() {
  if (typeof window === "undefined" || window.innerWidth <= DESKTOP_BREAKPOINT) return 1;
  return Math.max(
    MINIMUM_DESKTOP_SCALE,
    Math.min(1, window.innerWidth / DESKTOP_DESIGN_WIDTH, window.innerHeight / DESKTOP_DESIGN_HEIGHT),
  );
}

function useDesktopUiScale() {
  const [scale, setScale] = useState(readDesktopUiScale);

  useEffect(() => {
    const updateScale = () => {
      const nextScale = readDesktopUiScale();
      setScale((currentScale) => (
        Math.abs(currentScale - nextScale) < 0.001 ? currentScale : nextScale
      ));
    };

    window.addEventListener("resize", updateScale, { passive: true });
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  return scale;
}

const navItems = [
  { id: "overview", label: "总览", icon: IconLayoutDashboard },
  { id: "video", label: "工作区", icon: IconFolder },
  { id: "src", label: "SRC 数据", icon: IconUsers },
  { id: "dst", label: "DST 数据", icon: IconUsers },
  { id: "xseg", label: "XSeg 遮罩", icon: IconMasksTheater, tone: "violet" },
  { id: "training", label: "模型训练", icon: IconBoxModel2 },
  { id: "merge", label: "模型应用", icon: IconStack2 },
  { id: "export", label: "视频导出", icon: IconFileExport },
  { id: "tools", label: "工具", icon: IconTool },
];

export function BrandBar() {
  return (
    <div className="brand-bar">
      <div className="brand-lockup">
        <img className="brand-mark" src="/assets/brand-mark.png" alt="" />
        <strong>DeepFaceLab 管理台</strong>
      </div>
      <div className="window-actions" aria-label="窗口控制">
        <button type="button" aria-label="最小化（桌面壳接入后可用）" disabled><IconMinus size={15} stroke={1.6} /></button>
        <button type="button" aria-label="最大化（桌面壳接入后可用）" disabled><IconSquare size={12} stroke={1.6} /></button>
        <button className="window-close" type="button" aria-label="关闭（桌面壳接入后可用）" disabled><IconX size={15} stroke={1.6} /></button>
      </div>
    </div>
  );
}

export function Sidebar({ activeNav, onNavigate }) {
  return (
    <aside className="sidebar" aria-label="主导航">
      <nav className="sidebar-nav">
        {navItems.map(({ id, label, icon: Icon, tone }) => (
          <button
            className={`nav-item ${activeNav === id ? "is-active" : ""} ${tone === "violet" ? "is-violet" : ""}`}
            key={id}
            type="button"
            aria-current={activeNav === id ? "page" : undefined}
            onClick={() => onNavigate(id, label)}
          >
            <Icon size={20} stroke={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <button
        className={`nav-item sidebar-settings ${activeNav === "settings" ? "is-active" : ""}`}
        type="button"
        aria-current={activeNav === "settings" ? "page" : undefined}
        onClick={() => onNavigate("settings", "设置")}
      >
        <IconSettings size={20} stroke={1.8} />
        <span>设置</span>
      </button>
    </aside>
  );
}

export function ProjectHeader({ workspacePath, serviceState, telemetry, onNewTask, onMenu }) {
  const serviceOnline = serviceState === "online";
  const gpu = telemetry?.gpus?.[0];
  return (
    <header className="project-header">
      <div className="project-copy">
        <div className="project-title-row">
          <h1>DeepFaceLabSN</h1>
          <button className="icon-button quiet" type="button" aria-label="项目名称来自当前仓库" disabled>
            <IconPencil size={15} stroke={1.8} />
          </button>
        </div>
        <div className="workspace-path">
          <span>工作区路径</span>
          <code>{workspacePath}</code>
          <IconFolder size={15} stroke={1.7} />
        </div>
      </div>
      <div className="project-actions">
        <div className={`environment-badge ${serviceOnline ? "" : "is-offline"}`}>
          <IconCheck size={15} stroke={2.5} />
          <span>{serviceOnline ? "本地服务在线" : serviceState === "loading" ? "正在检测服务" : "本地服务离线"}</span>
        </div>
        <div className="gpu-summary">
          <span>{gpu ? `GPU ${gpu.index}` : "运行时"}</span>
          <strong title={gpu?.name}>
            {gpu
              ? `${gpu.name} · ${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(1)} GB`
              : "DFL current / legacy"}
          </strong>
        </div>
        <button className="button primary new-task-button" type="button" onClick={onNewTask} disabled={!serviceOnline}>
          <IconPlus size={18} stroke={2} />
          新建任务
        </button>
        <button className="icon-button menu-button" type="button" aria-label="打开项目菜单" onClick={onMenu}>
          <IconMenu2 size={21} stroke={1.8} />
        </button>
      </div>
    </header>
  );
}

export function WorkflowBar({ selectedStage, stageStates = {}, onSelectStage }) {
  return (
    <nav className="workflow-bar" aria-label="项目流程">
      {workflowStages.map((stage, index) => {
        const actualState = stageStates[stage.id] ?? stage.state;
        const state = selectedStage === stage.id ? "active" : actualState;
        return (
          <div className="workflow-segment" key={stage.id}>
            <button
              className={`workflow-step is-${state}`}
              type="button"
              onClick={() => onSelectStage(stage)}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="stage-number">
                {actualState === "done" && selectedStage !== stage.id ? <IconCheck size={14} stroke={2.6} /> : index + 1}
              </span>
              <span className="stage-copy">
                <strong>{stage.label}</strong>
                <small>
                  {actualState === "done"
                    ? "完成"
                    : actualState === "active"
                      ? "进行中"
                      : selectedStage === stage.id ? "当前视图" : "未运行"}
                </small>
              </span>
            </button>
            {index < workflowStages.length - 1 ? (
              <IconChevronRight className="workflow-arrow" size={17} stroke={1.3} aria-hidden="true" />
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell({ children, activeNav, onNavigate }) {
  const uiScale = useDesktopUiScale();
  const isScaled = uiScale < 0.999;
  const scaleStyle = isScaled
    ? {
        "--desktop-ui-scale": uiScale,
        "--desktop-ui-inverse": 1 / uiScale,
      }
    : undefined;

  return (
    <div className={`app-frame ${isScaled ? "is-desktop-scaled" : ""}`} style={scaleStyle}>
      <BrandBar />
      <div className="app-shell">
        <Sidebar activeNav={activeNav} onNavigate={onNavigate} />
        {children}
      </div>
    </div>
  );
}
