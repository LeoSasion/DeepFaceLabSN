import {
  IconCircleCheck,
  IconMaximize,
  IconMinus,
  IconTool,
  IconX,
} from "@tabler/icons-react";
import { launcherBridge } from "../bridge.js";

const BRAND_MARK = "assets/brand-mark.png";

export function TitleBar({ state }) {
  const runWindowAction = (action) => launcherBridge.request("window." + action);
  const beginWindowDrag = (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    launcherBridge.request("window.drag").catch(() => {});
  };
  const healthy = state.environmentStatus !== "error";
  const label = state.mode === "install"
    ? "首次配置"
    : healthy
      ? "环境就绪"
      : "环境需修复";

  return (
    <header className="titlebar" data-drag-region onPointerDown={beginWindowDrag}>
      <div className="titlebar__brand" data-drag-region>
        <img src={BRAND_MARK} alt="" className="brand-mark brand-mark--small" />
        <strong>DeepFaceLabSN 启动器</strong>
        <span className="titlebar__divider" />
        <span className={"titlebar__state " + (healthy ? "is-healthy" : "is-warning")}>
          {healthy ? <IconCircleCheck size={15} /> : <IconTool size={15} />}
          {label}
        </span>
      </div>
      <div className="window-actions">
        <button aria-label="最小化" onClick={() => runWindowAction("minimize")}>
          <IconMinus size={16} />
        </button>
        <button aria-label="最大化" onClick={() => runWindowAction("maximize")}>
          <IconMaximize size={14} />
        </button>
        <button className="window-actions__close" aria-label="关闭" onClick={() => runWindowAction("close")}>
          <IconX size={16} />
        </button>
      </div>
    </header>
  );
}

export { BRAND_MARK };
