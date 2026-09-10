import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";
import { switchProjectAndWait } from "../runtime/project-switch.js";
import { useDialogFocus } from "./Overlays.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

export function ProjectSwitchDialog({ project, onClose, onReady }) {
  const { t } = useI18n();
  const [state, setState] = useState({ phase: "confirm", error: null });
  const requestRef = useRef(null);
  const busy = ["requesting", "waiting", "reconnecting", "ready"].includes(state.phase);
  const { dialogRef, initialFocusRef } = useDialogFocus(Boolean(project), () => { if (!requestRef.current) onClose(); });
  useEffect(() => {
    setState({ phase: "confirm", error: null });
    return () => { requestRef.current?.abort(); requestRef.current = null; };
  }, [project?.id, project?.checkOnly]);
  if (!project) return null;
  const checkOnly = Boolean(project.checkOnly || state.phase === "unconfirmed");

  const run = async checkOnly => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ phase: checkOnly ? "reconnecting" : "requesting", error: null });
    try {
      await switchProjectAndWait(project.id, {
        activate: runtimeApi.activateProject, readHealth: runtimeApi.health,
        signal: controller.signal, checkOnly,
        onStatus: next => { if (!controller.signal.aborted) setState({ ...next, error: null }); },
      });
      if (!controller.signal.aborted) {
        setState({ phase: "ready", error: null });
        onReady();
      }
    } catch (error) {
      if (!controller.signal.aborted) setState({ phase: error.code === "PROJECT_SWITCH_UNCONFIRMED" ? "unconfirmed" : "rejected", error });
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  };
  const label = state.phase === "requesting" ? t("正在提交项目切换…")
    : state.phase === "reconnecting" ? t("正在等待本地服务重新连接…")
      : state.phase === "ready" ? t("目标项目已就绪，正在进入…") : t("正在等待目标项目就绪…");
  return <div className="modal-backdrop project-switch-backdrop"><section className="modal-card project-switch-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="project-switch-title">
    <header><h2 id="project-switch-title">{t("切换项目")}</h2></header>
    <div className="project-switch-body">
      <strong>{project.name}</strong><code>{project.id}</code>
      <p>{checkOnly ? t("正在核对已提交的切换。确认目标项目就绪后，页面才会自动进入。") : t("本地服务将切换工作区。确认目标项目就绪后，页面才会自动进入。")}</p>
      {busy ? <LoadingProgress inline compact tone="amber" label={label} detail={t("目标项目：{name}", { name: project.name })} rememberDuration={false}/> : null}
      {state.error ? <div className="workspace-read-error" role="alert"><p>{t(state.error.message)}</p>{state.phase === "unconfirmed" ? <p>{t("切换请求可能已生效。继续检查只读取状态，不会重复提交切换。")}</p> : null}</div> : null}
    </div>
    <footer><button ref={initialFocusRef} className="button secondary" type="button" disabled={busy} onClick={onClose}>{t("返回设置")}</button>
      <button className="button primary" type="button" disabled={busy} onClick={() => void run(checkOnly)}>{checkOnly ? t("继续检查") : t("确认切换")}</button></footer>
  </section></div>;
}
