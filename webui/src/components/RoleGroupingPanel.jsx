import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";
import { LoadingProgress } from "./ProgressFeedback.jsx";
import { useDialogFocus } from "./Overlays.jsx";
import { useRoleReviewDraft } from "../runtime/useRoleReviewDraft.js";
import { roleReviewRecovery } from "../domain/role-review.js";

function RoleConfirmation({ open, busy, error, name, side, targetSide, count, total, onClose, onConfirm, onRecover, recoveryLabel }) {
  const { t } = useI18n();
  const { dialogRef, initialFocusRef } = useDialogFocus(open, () => { if (!busy) onClose(); });
  if (!open) return null;
  return <div className="modal-backdrop"><section className="modal-card role-confirmation" role="dialog" aria-modal="true" aria-labelledby="role-confirm-title" ref={dialogRef}>
    <header><h2 id="role-confirm-title">{t("确认角色去向")}</h2></header>
    <div className="role-confirm-body"><strong>{name} → {targetSide.toUpperCase()}</strong><p>{t("保留 {count} 张",{count})}</p>
      <p>{side === targetSide ? t("本侧其他 {count} 张将移入恢复区。",{count:total-count}) : t("将复制所选人脸、原视频和源帧到另一侧；目标侧原素材及受影响的成片会先归档，可恢复。来源侧保持不变。")}</p>
    </div>
    {error ? <div className="role-help" role="alert"><p>{error}</p>{onRecover ? <button className="button secondary" type="button" disabled={busy} onClick={onRecover}>{recoveryLabel}</button> : null}</div> : null}
    <footer><button ref={initialFocusRef} type="button" className="button secondary" disabled={busy} onClick={onClose}>{t("返回复核")}</button><button type="button" className="button primary" disabled={busy} onClick={onConfirm}>{busy ? t("正在分配…") : t("确认分配")}</button></footer>
  </section></div>;
}


function RoleRestoreConfirmation({ record, busy, error, onClose, onConfirm }) {
  const { t } = useI18n();
  const { dialogRef,initialFocusRef } = useDialogFocus(Boolean(record),() => { if (!busy) onClose(); });
  if (!record) return null;
  return <div className="modal-backdrop"><section className="modal-card role-confirmation" role="dialog" aria-modal="true" aria-labelledby="role-restore-title" ref={dialogRef}>
    <header><h2 id="role-restore-title">{t("恢复人物分配")}</h2></header>
    <div className="role-confirm-body"><strong>{record.name ?? t("恢复记录")} · {record.targetSide.toUpperCase()}</strong>
      {record.createdAt ? <p>{new Date(record.createdAt).toLocaleString()}</p> : null}
      <p>{t("恢复分配前的目标素材？当前目标素材会先归档，仍可撤回。")}</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
    <footer><button ref={initialFocusRef} type="button" className="button secondary" disabled={busy} onClick={onClose}>{t("取消")}</button><button type="button" className="button primary" disabled={busy} onClick={onConfirm}>{busy ? t("恢复中…") : t("确认恢复")}</button></footer>
  </section></div>;
}

export function RoleGroupingPanel({ side, workspaceKey, refreshVersion, onError, onNotice, onNavigateDataset, onOpenCommand, onWorkspaceChange, onBusyChange }) {
  const { t } = useI18n();
  const [review, updateReview] = useRoleReviewDraft(workspaceKey, side, refreshVersion);
  const { threshold, data, selected, roleName, targetSide } = review;
  const setSelected = update => updateReview(previous => ({ selected:typeof update === "function" ? update(previous.selected) : update }));
  const [phase, setPhase] = useState(null);
  const busy = Boolean(phase);
  const [failure, setFailure] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const error = failure ? t(failure.error.message) : "";
  const analysisCancelled = failure?.phase === "analyze" && failure.error.code === "OPERATION_CANCELLED";
  const canResumeAnalysis = failure?.phase === "analyze" && failure.error.code === "OPERATION_OBSERVATION_LOST"
    && failure.error.operation?.id && failure.error.cause?.status !== 404;
  const recovery = canResumeAnalysis ? "resume" : failure ? roleReviewRecovery(failure.error,failure.phase) : null;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    generation.current += 1;
    setFailure(null); setConfirming(false); setRestoreTarget(null); setResult(null); setHistory([]);
    let cancelled = false;
    void runtimeApi.roleAssignments().then(records => { if (!cancelled) setHistory(records); }).catch(error => {
      if (!cancelled) setFailure({error,phase:"refresh"});
    });
    return () => { cancelled = true; generation.current += 1; };
  }, [side, workspaceKey, refreshVersion]);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const report = (error, phase) => {
    setFailure({error,phase});
    if (phase !== "analyze" || error.code !== "OPERATION_CANCELLED") onError?.(error);
  };
  const refreshLists = async current => {
    const [workspace, records] = await Promise.allSettled([runtimeApi.workspace(),runtimeApi.roleAssignments()]);
    if (current !== generation.current) return;
    if (workspace.status === "fulfilled") onWorkspaceChange?.(workspace.value);
    if (records.status === "fulfilled") setHistory(records.value);
    const rejected = [workspace,records].find(value => value.status === "rejected");
    if (rejected) setFailure({error:rejected.reason,phase:"refresh"});
  };
  const run = async (nextPhase, action) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setPhase(nextPhase); setFailure(null);
    try { await action(current); }
    catch (error) { if (current === generation.current) report(error,nextPhase); }
    finally { inFlight.current = false; setPhase(null); }
  };
  const analyze = () => run("analyze",async current => {
    updateReview({data:null,selected:[]});
    const groups = await runtimeApi.alignedRoles(side,{threshold});
    if (current === generation.current) updateReview({data:groups});
  });
  const resumeAnalysis = () => {
    const id = failure.error.operation.id;
    return run("analyze", async current => {
      const groups = await runtimeApi.resumeOperation(id);
      if (current === generation.current) updateReview({data:groups});
    });
  };
  const toggleGroup = group => setSelected(previous => {
    const next = new Set(previous);
    const remove = group.members.every(member => next.has(member.name));
    for (const member of group.members) { if (remove) next.delete(member.name); else next.add(member.name); }
    return [...next];
  });
  const retain = () => {
    if (!data || !selected.length || data.truncated || !roleName.trim()) return;
    return run("assign",async current => {
      const assigned = await runtimeApi.assignRole(side,{names:selected,fingerprint:data.fingerprint,targetSide,name:roleName.trim()});
      if (current !== generation.current) return;
      setResult(assigned); setConfirming(false);
      if (side === targetSide) updateReview({data:null,selected:[]});
      onNotice?.(t("角色已分配到 {side}，共 {count} 张。",{side:assigned.targetSide.toUpperCase(),count:assigned.keptCount}));
      await refreshLists(current);
    });
  };
  const restore = () => {
    if (!restoreTarget) return;
    const token = restoreTarget.token;
    return run("restore",async current => {
      await runtimeApi.restoreRoleAssignment(token);
      if (current !== generation.current) return;
      setRestoreTarget(null); setResult(null); updateReview({data:null,selected:[]});
      onNotice?.(t("角色分配已恢复"));
      await refreshLists(current);
    });
  };
  const refresh = () => run("refresh",refreshLists);
  const recover = () => {
    if (recovery === "resume") { void resumeAnalysis(); }
    else if (recovery === "recovery") { void runtimeApi.revealWorkspace().catch(error => onError?.(error)); }
    else if (recovery === "dependencies") onOpenCommand("runtime.prepare_vision");
    else if (recovery === "analyze") { setConfirming(false); void analyze(); }
    else if (recovery === "refresh") { setConfirming(false); setRestoreTarget(null); void refresh(); }
  };
  const recoveryLabel = recovery === "resume" ? t("读取分析结果") : recovery === "recovery" ? t("打开恢复文件所在项目") : recovery === "dependencies" ? t("准备视觉依赖") : recovery === "analyze" ? t("重新分析人物") : t("刷新恢复记录");
  const phaseLabel = phase === "assign" ? t("正在分配人物，请稍候…") : phase === "restore" ? t("正在恢复人物素材…") : phase === "refresh" ? t("正在刷新项目状态…") : t("正在分析人物…");
  return <div className="similarity-workbench role-workbench">
    <header className="similarity-toolbar">
      <div><strong>{t("按角色分组")}</strong><span>{t("归拢同一角色的不同表情与角度，海报和路人单独复核。")}</span></div>
      <label><span>{t("分组严格度")}</span>
        <input aria-label={t("分组严格度")} type="range" min="0.3" max="0.85" step="0.01" value={threshold}
          disabled={busy} onChange={(event) => { updateReview({threshold:Number(event.target.value),data:null,selected:[]}); }} />
        <strong>{threshold.toFixed(2)}</strong><small>{t("左：更宽松 · 右：更严格")}</small>
      </label>
      <button type="button" className="button primary" disabled={busy} onClick={() => void analyze()}>{t("分析角色")}</button>
    </header>
    <p className="role-help">{t("选择一个或多个属于目标角色的分组；可逐张取消误分图片。只在本机分析，原始视频和源帧保持不变。")}{data ? <span>{t("页面切换会保留本次复核；分配前会再次检查素材。")}</span> : null}</p>
    {result ? <div className="role-result" role="status"><strong>{result.name} · {result.targetSide.toUpperCase()} · {result.keptCount} {t("张")}</strong>
      <button type="button" className="button secondary" onClick={() => onNavigateDataset(result.targetSide,null)}>{t("查看数据集")}</button>
      <button type="button" className="button secondary" onClick={() => onOpenCommand("train.saehd")}>{t("下一步：训练")}</button>
      {result.assignmentToken ? <button type="button" className="text-button" disabled={busy} onClick={() => setRestoreTarget({token:result.assignmentToken,name:result.name,targetSide:result.targetSide})}>{t("恢复此次分配")}</button> : <button type="button" className="text-button" onClick={() => onNavigateDataset(side,{recovery:true})}>{t("打开恢复区")}</button>}
    </div> : null}
    {busy ? <LoadingProgress compact inline={phase === "analyze"} rememberDuration={phase !== "analyze"} label={phaseLabel} /> : null}
    {error ? <div role={analysisCancelled ? "status" : "alert"} className={`role-help role-recovery${analysisCancelled ? " is-cancelled" : ""}`}><p>{analysisCancelled ? t("分析已取消，可重新开始。") : failure.phase === "refresh" ? t("操作结果需要重新读取，请刷新状态后继续。") : error}</p>{failure.phase === "refresh" ? <small>{error}</small> : null}
      {failure.error.details?.token || failure.error.details?.quarantineToken ? <small>{t("恢复记录：{token}",{token:failure.error.details.token ?? failure.error.details.quarantineToken})}</small> : null}
      {recovery ? <button type="button" className="button secondary" disabled={busy} onClick={recover}>{recoveryLabel}</button> : null}
    </div> : null}
    {data ? <>
      <div className="similarity-summary">
        <div><span>{t("已分析")}</span><strong>{data.analyzedCount}</strong></div>
        <div><span>{t("角色候选")}</span><strong>{data.groups.length}</strong></div>
        <div><span>{t("待保留")}</span><strong>{selected.length}</strong></div>
        <p>{t("无法分析 {count} 张；单人组也需复核。", { count: data.invalidCount || 0 })}</p>
      </div>
      {data.truncated ? <p role="alert">{t("超过 2000 张，本次仅预览部分结果，不能批量保留；请先分批整理。")}</p> : null}
      <div className="similarity-groups">{data.groups.map((group, index) => <section key={group.id}>
        <header><div><strong>{t("角色候选 {id}", { id: index + 1 })}</strong><span>{t("{count} 张", { count: group.memberCount })}</span></div>
          <button type="button" disabled={busy} aria-pressed={group.members.every((item) => chosen.has(item.name))} onClick={() => toggleGroup(group)}>{t("选择整组")}</button></header>
        <div className="similarity-members role-members">{group.members.map((member) => <article key={member.name} className={chosen.has(member.name) ? "is-selected" : ""}>
          <button type="button" disabled={busy} aria-pressed={chosen.has(member.name)} aria-label={member.name}
            onClick={() => setSelected((previous) => previous.includes(member.name) ? previous.filter((name) => name !== member.name) : [...previous, member.name])}>
            <img src={member.imageUrl} alt={member.name} loading="lazy" decoding="async" />
            <span>{chosen.has(member.name) ? t("待保留") : t("未选择")}</span>
          </button><div><strong title={member.name}>{member.name}</strong><small>{member.score.toFixed(3)}</small></div>
          <button type="button" aria-label={t("查看 {name}",{name:member.name})} onClick={() => onNavigateDataset(side, member)}>{t("查看")}</button>
        </article>)}</div>
      </section>)}</div>
      <footer className="similarity-action-dock role-action-dock">
        <label>{t("角色名称")}<input maxLength={60} value={roleName} disabled={busy} placeholder={t("例如：访谈嘉宾")} onChange={event => updateReview({roleName:event.target.value})} /></label>
        <label>{t("分配用途")}<select disabled={busy} value={targetSide} onChange={event => updateReview({targetSide:event.target.value})}><option value="src">{t("源人物 SRC")}</option><option value="dst">{t("目标人物 DST")}</option></select></label>
        <span aria-live="polite"><strong>{t("保留 {count} 张",{count:selected.length})}</strong><small>{targetSide === side ? t("隔离 {count} 张",{count:Math.max(0,(data.total ?? data.analyzedCount)-selected.length)}) : t("复制到另一侧，原目标先归档")}</small></span>
        <button type="button" className="button primary" disabled={busy || !selected.length || data.truncated || !roleName.trim()} onClick={() => setConfirming(true)}>{t("复核并分配")}</button>
      </footer>
    </> : !busy && !error ? <p className="role-help">{t("先完成切脸，再点击分析。分组是候选结果，不确定的图片可留待复核。")}</p> : null}
    {!busy && history.length ? <details className="role-assignment-history"><summary>{t("角色分配恢复历史")} · {history.length}</summary>{history.map(record => <div key={record.token}><span>{record.name ?? t("恢复记录")} · {record.targetSide.toUpperCase()} · {new Date(record.createdAt).toLocaleString()}</span><button type="button" className="button secondary" disabled={busy} onClick={() => setRestoreTarget(record)}>{t("恢复")}</button></div>)}</details> : null}
    <RoleConfirmation open={confirming} busy={busy} error={error} name={roleName} side={side} targetSide={targetSide} count={selected.length} total={data?.total ?? data?.analyzedCount ?? 0} onClose={() => setConfirming(false)} onConfirm={() => void retain()} onRecover={recovery ? recover : null} recoveryLabel={recoveryLabel}/>
    <RoleRestoreConfirmation record={restoreTarget} busy={busy} error={error} onClose={() => setRestoreTarget(null)} onConfirm={() => void restore()} />
  </div>;
}

export function RoleSelectionView({ side, onSideChange, workspace, ...props }) {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  return <section className="role-selection-view"><header className="role-selection-heading"><div><h2>{t("选择人物")}</h2><p>{t("SRC 提供人脸；DST 是需要替换人物的视频。")}</p></div>
    <div className="side-switch" role="group" aria-label={t("分析哪一侧素材")}>{["src","dst"].map(value => <button key={value} type="button" disabled={busy} aria-pressed={value===side} className={value===side?"is-active":""} onClick={() => onSideChange(value)}>{value.toUpperCase()}{workspace?.roles?.[value]?.name ? ` · ${workspace.roles[value].name}` : ""}</button>)}</div>
  </header><RoleGroupingPanel key={`${workspace?.root}:${side}`} workspaceKey={workspace?.root} side={side} onBusyChange={setBusy} {...props}/></section>;
}
