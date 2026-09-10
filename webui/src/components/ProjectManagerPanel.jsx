import { useEffect, useId, useRef, useState } from "react";
import { IconBoxModel2, IconCheck, IconRefresh } from "@tabler/icons-react";
import { normalizeProjectName, normalizeProjectId, projectIdentityIssues } from "../../shared/project-identity.mjs";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";
import { useWorkspaceRead } from "../runtime/useWorkspaceRead.js";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const readProjects = () => runtimeApi.projects({ signal: AbortSignal.timeout(15_000) });

export function ProjectManagerPanel({ health, activeJobCount, onSwitchProject, onNotice }) {
  const { t } = useI18n();
  const { data, loading, error, refresh } = useWorkspaceRead(readProjects);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [creation, setCreation] = useState({ phase: "idle", error: null });
  const creating = useRef(false);
  const fieldId = useId();
  const runningId = health?.project?.id ?? data?.runningId;
  const pending = Boolean(data?.restartPending || (data && runningId && data.activeId !== runningId));
  const pendingProject = pending ? data?.projects.find(project => project.id === data.activeId) : null;
  const busy = creation.phase === "creating";
  const uncertain = creation.phase === "unknown";
  const normalizedName = normalizeProjectName(name);
  const normalizedId = normalizeProjectId(id);
  const issues = projectIdentityIssues(normalizedName, normalizedId, data?.projects);
  const nameError = name ? (issues.name ? t("项目名称需为 1–64 个字符，不能包含路径符号。") : "") : "";
  const idError = id ? (issues.id === "PROJECT_EXISTS" ? t("这个项目标识已存在，请换一个标识。")
    : issues.id ? t("标识需包含英文字母或数字，不能使用 default、CON 等系统保留名称。") : "") : "";
  const formBlocked = busy || uncertain || loading || !data || Boolean(error) || pending;
  useEffect(() => { void refresh(); }, [refresh, health?.project?.id]);

  const create = async event => {
    event.preventDefault();
    if (creating.current || formBlocked || issues.name || issues.id) return;
    creating.current = true;
    setCreation({ phase: "creating", error: null });
    try {
      const project = await runtimeApi.createProject({ name: normalizedName, id: normalizedId }, { signal: AbortSignal.timeout(15_000) });
      setName(""); setId("");
      setCreation({ phase: "created", error: null, name: project.name });
      onNotice?.(t("项目“{name}”已创建，当前工作区保持不变。", { name: project.name }));
      await refresh();
    } catch (failure) {
      const rejected = failure.status >= 400 && failure.status < 500 && ![408, 425].includes(failure.status);
      setCreation({ phase: rejected ? "error" : "unknown", error: failure });
    } finally { creating.current = false; }
  };
  const recheckCreation = async () => {
    if (await refresh()) setCreation({ phase: "idle", error: null });
  };
  const edit = setter => event => {
    setter(event.target.value);
    if (!uncertain) setCreation({ phase: "idle", error: null });
  };
  return <section className="project-manager-section">
    <header>
      <div><IconBoxModel2 size={19}/><div><h3>{t("受管项目工作区")}</h3><p>{t("每个项目独立保存素材、模型、任务日志、诊断与恢复记录。")}</p></div></div>
      <div className="project-list-controls"><span className={activeJobCount || pending ? "is-warning" : "is-ok"}>
        {pending ? t("项目切换尚未完成") : activeJobCount ? t("{count} 个任务阻止切换", { count: activeJobCount }) : runningId ? t("当前项目已连接") : t("等待服务状态")}
      </span>{pendingProject ? <button type="button" className="button secondary" onClick={() => onSwitchProject({ ...pendingProject, checkOnly: true })}>{t("检查切换状态")}</button> : null}
      <button type="button" className="button secondary" disabled={loading || busy} onClick={() => void refresh()}><IconRefresh size={14}/>{t("刷新项目")}</button></div>
    </header>
    {loading ? <LoadingProgress compact label={t("正在读取受管项目…")} detail={t("正在确认当前工作区与切换安全性")} operationKey="settings-projects-load"/> : null}
    {busy ? <LoadingProgress compact label={t("正在创建项目…")} detail={normalizedName} operationKey="settings-project-create"/> : null}
    {error ? <div className="workspace-read-error project-read-error" role="alert"><strong>{t("项目清单读取失败")}</strong><p>{t(error.message)}</p><button type="button" className="button secondary" disabled={loading} onClick={() => void refresh()}>{t("重新读取")}</button></div> : null}
    <div className="project-manager-grid">
      <div className="project-list">
        {data?.projects.map(project => {
          const active = project.id === runningId;
          return <article className={active ? "is-active" : ""} key={project.id}>
            <span>{active ? <IconCheck size={15}/> : <IconBoxModel2 size={15}/>}</span>
            <div><strong>{project.name}</strong><small>{project.id} · {project.managed ? t("受管目录") : t("兼容默认工作区")}</small></div>
            <button type="button" className="button secondary" disabled={active || activeJobCount > 0 || busy || pending || !runningId || Boolean(error)} onClick={() => onSwitchProject(project)}>{active ? t("当前") : t("切换")}</button>
          </article>;
        })}
        {!data && !error ? <div className="operation-empty">{t("项目清单准备中")}</div> : null}
      </div>
      <form className="project-create-form" onSubmit={create}>
        <strong>{t("新建项目")}</strong>
        <label htmlFor={`${fieldId}-name`}><span>{t("项目名称")}</span><input id={`${fieldId}-name`} value={name} maxLength={64} disabled={formBlocked} onChange={edit(setName)} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? `${fieldId}-name-error` : undefined} placeholder={t("例如：访谈片 A")}/></label>
        {nameError ? <p className="project-field-error" id={`${fieldId}-name-error`}>{nameError}</p> : null}
        <label htmlFor={`${fieldId}-id`}><span>{t("项目标识")}</span><input id={`${fieldId}-id`} value={id} maxLength={48} disabled={formBlocked} onChange={edit(setId)} aria-invalid={Boolean(idError)} aria-describedby={`${fieldId}-id-help`} placeholder="interview-a" spellCheck={false}/></label>
        <div id={`${fieldId}-id-help`} className={idError ? "project-field-error" : "project-id-preview"} aria-live="polite">
          {idError || (normalizedId ? <>{t("实际项目目录")}<code>workspaces/{normalizedId}</code></> : t("输入标识后可预览实际项目目录。"))}
        </div>
        <small>{t("仅在仓库的 workspaces 目录中创建，不接受任意磁盘路径。创建不会自动切换。")}</small>
        {creation.error ? <div className="workspace-read-error" role="alert"><p>{t(creation.error.message)}</p>{uncertain ? <><p>{t("创建结果尚未确认，请先刷新项目清单核对。")}</p><button type="button" className="button secondary" disabled={loading} onClick={() => void recheckCreation()}>{t("刷新并核对结果")}</button></> : null}</div> : null}
        {creation.phase === "created" ? <p role="status">{t("项目“{name}”已创建，当前工作区保持不变。", { name: creation.name })}</p> : null}
        <button className="button primary" type="submit" disabled={formBlocked || Boolean(issues.name || issues.id)}>{busy ? t("正在创建项目…") : t("创建受管项目")}</button>
      </form>
    </div>
  </section>;
}
