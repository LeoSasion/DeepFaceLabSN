import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconBoxModel2,
  IconCheck,
  IconFile,
  IconHistory,
  IconMovie,
  IconPlayerPlay,
  IconRefresh,
  IconRestore,
  IconServer,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";
import { OutputGallery } from "./OutputGallery.jsx";
import { useDialogFocus } from "./Overlays.jsx";
import { useWorkspaceRead } from "../runtime/useWorkspaceRead.js";

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return [hours, minutes, remaining]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0"))
    .join(":");
}

function MaterialSlot({
  side,
  material,
  busy,
  uploading,
  historyBusy,
  progress,
  archiveCount,
  archivesLoading,
  archivesError,
  onImport,
  onOpenHistory,
}) {
  const { language, t } = useI18n();
  const inputRef = useRef(null);
  const label = side === "src" ? t("SRC 源视频") : t("DST 目标视频");
  const materialVersion = encodeURIComponent(`${material?.modifiedAt ?? ""}:${material?.bytes ?? 0}`);
  return (
    <section className="material-slot">
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        disabled={busy}
        aria-label={t("选择 {side} 视频文件", { side: side.toUpperCase() })}
        accept=".mp4,.mov,.avi,.mkv,.m4v,.webm,video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onImport(side, file, Boolean(material));
        }}
      />
      <div className="material-slot-heading">
        <div>
          <span className="workspace-section-icon"><IconMovie size={18} /></span>
          <h3>{label}</h3>
        </div>
        <span className={`readiness-dot ${material ? "is-ready" : "is-missing"}`}>
          {material ? t("已导入") : t("缺少素材")}
        </span>
      </div>
      {material ? (
        <div className="material-overview">
          <video
            key={materialVersion}
            className="material-preview"
            muted
            playsInline
            preload="metadata"
            poster={`/api/assets/${side}/poster?v=${materialVersion}`}
            src={`/api/workspace/materials/${side}?v=${materialVersion}`}
            aria-label={t("{side} 素材预览", { side: side.toUpperCase() })}
          />
          <div className="material-details">
            <strong>{material.name}</strong>
            <dl>
              <div><dt>{t("时长")}</dt><dd>{formatDuration(material.durationSeconds)}</dd></div>
              <div><dt>{t("分辨率")}</dt><dd>{material.width ? `${material.width} × ${material.height}` : "—"}</dd></div>
              <div><dt>{t("大小")}</dt><dd>{formatBytes(material.bytes)}</dd></div>
              <div><dt>{t("修改时间")}</dt><dd>{new Date(material.modifiedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</dd></div>
            </dl>
          </div>
        </div>
      ) : (
        <div className="material-empty">
          <IconUpload size={24} />
          <p>{t("导入后会保存为固定的 data_{side}.* 素材。", { side })}</p>
        </div>
      )}
      <div className="material-slot-actions">
        <button
          className="button secondary material-import"
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <IconUpload size={15} />{uploading ? t("正在导入…") : material ? t("更换") : t("导入")}
        </button>
        <button
          className="button secondary material-history-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-busy={archivesLoading}
          onClick={() => onOpenHistory(side)}
          disabled={historyBusy}
        >
          <IconHistory size={15} />
          {archivesLoading ? t("恢复历史读取中…") : archivesError ? t("恢复历史读取失败")
            : archiveCount == null ? t("查看恢复历史") : t("恢复历史（{count}）", { count: archiveCount })}
        </button>
      </div>
      {uploading ? (
        <LoadingProgress
          compact
          className="material-upload-progress"
          label={t("正在上传 {side} 视频", { side: side.toUpperCase() })}
          detail={progress?.percent >= 100 ? t("上传完成，正在校验并登记素材") : t("按文件真实传输量计算")}
          value={progress?.percent < 100 ? progress?.percent : undefined}
          current={progress?.loaded}
          total={progress?.total}
          operationKey={`material-upload:${side}`}
        />
      ) : null}
    </section>
  );
}

function archiveFormat(archive) {
  const extension = String(archive?.originalName ?? "").split(".").pop();
  return extension && extension !== archive?.originalName ? extension.toUpperCase() : "—";
}

function MaterialHistoryDrawer({ side, archives, loading, error, restoring, restoreDisabled, active, onClose, onRestore, onRetry }) {
  const { language, t } = useI18n();
  const { dialogRef, initialFocusRef } = useDialogFocus(active, () => { if (!restoring) onClose(); });

  return (
    <div
      className="material-history-backdrop"
      inert={!active}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !restoring) onClose();
      }}
    >
      <aside
        className="material-history-drawer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="material-history-title"
      >
        <header>
          <div>
            <span>{side.toUpperCase()}</span>
            <h3 id="material-history-title">{t("素材恢复历史")}</h3>
          </div>
          <button
            ref={initialFocusRef}
            className="icon-button quiet"
            type="button"
            aria-label={t("关闭恢复历史")}
            onClick={onClose}
            disabled={restoring}
          >
            <IconX size={17} />
          </button>
        </header>
        <p>{t("恢复归档前，当前素材会自动移入恢复历史，可继续撤回。")}</p>
        {error ? (
          <div className="material-history-state workspace-read-error" role="alert">
            <strong>{t("恢复历史读取失败")}</strong><p>{t(error.message)}</p>
            <button type="button" className="button secondary" onClick={async () => { if (await onRetry()) initialFocusRef.current?.focus(); }} disabled={loading}>{t("重新读取")}</button>
          </div>
        ) : loading ? (
          <div className="material-history-state" role="status">{t("正在读取恢复历史…")}</div>
        ) : archives?.length ? (
          <div className="material-history-list">
            {archives.map((archive) => {
              const busy = restoring === archive.token;
              return (
                <article key={archive.token}>
                  <span className="material-history-icon"><IconMovie size={17} /></span>
                  <div>
                    <strong>{new Date(archive.archivedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</strong>
                    <small title={archive.originalName}>{archive.originalName}</small>
                    <small>{archiveFormat(archive)} · {formatBytes(archive.bytes)}</small>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => onRestore(archive)}
                    disabled={restoreDisabled || Boolean(restoring)}
                  >
                    <IconRestore size={15} />{busy ? t("恢复中…") : t("恢复")}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="material-history-state">{t("还没有可恢复的素材历史")}</div>
        )}
        {restoring ? (
          <LoadingProgress
            inline
            compact
            label={t("正在恢复素材…")}
            detail={t("当前素材会先创建可撤回归档")}
          />
        ) : null}
      </aside>
    </div>
  );
}

function WorkspaceActionDialog({ action, busy, error, onClose, onConfirm, onRefresh }) {
  const { language, t } = useI18n();
  const { dialogRef, initialFocusRef } = useDialogFocus(Boolean(action), () => { if (!busy) onClose(); });
  if (!action) return null;
  const title = action.kind === "import" ? (action.replacing ? t("更换视频素材") : t("导入视频素材"))
    : action.kind === "restore" ? t("恢复视频素材") : t("归档已结束任务");
  const uncertain = error && (!error.status || error.status >= 500 || error.status === 408);
  return <div className="modal-backdrop workspace-action-backdrop"><section className="modal-card workspace-action-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-action-title" ref={dialogRef}>
    <header><h2 id="workspace-action-title">{title}</h2></header>
    <div className="workspace-action-body">
      {action.kind === "archive" ? <p>{t("把 {count} 个已结束任务的日志移入归档？素材、模型和成片会保留。",{count:action.count})}</p> : <>
        <strong>{action.side === "src" ? t("SRC 源视频") : t("DST 目标视频")}</strong>
        <p className="workspace-action-filename">{action.file?.name ?? action.archive?.originalName}</p>
        <small>{formatBytes(action.file?.size ?? action.archive?.bytes)}{action.archive?.archivedAt ? ` · ${new Date(action.archive.archivedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}` : ""}</small>
        <p>{action.kind === "import" && !action.replacing
          ? t("视频将导入当前项目。导入后请继续提帧、切脸和人物复核。")
          : t("当前视频会先移入可恢复历史。已有视频帧、人脸、模型和成片不会自动更新，请按流程重新处理。")}</p>
      </>}
      {error ? <div className="workspace-read-error" role="alert"><p>{t(error.message)}</p>{uncertain ? <p>{t("操作结果尚未确认。先刷新工作区和恢复历史，再决定下一步。")}</p> : null}</div> : null}
      {busy ? <LoadingProgress inline compact label={t("正在处理，请稍候…")} rememberDuration={false}/> : null}
    </div>
    <footer><button ref={initialFocusRef} type="button" className="button secondary" disabled={busy} onClick={onClose}>{t("取消")}</button>
      <button type="button" className="button primary" disabled={busy} onClick={uncertain ? onRefresh : onConfirm}>{uncertain ? t("刷新并核对结果") : busy ? t("处理中…") : t("确认操作")}</button></footer>
  </section></div>;
}

function ReadinessItem({ label, value, ready, optional }) {
  return (
    <div className={`readiness-item ${ready ? "is-ready" : optional ? "is-optional" : "is-missing"}`}>
      <span>{ready ? <IconCheck size={15} /> : optional ? <span aria-hidden="true">○</span> : <IconAlertTriangle size={15} />}</span>
      <div>
        <strong>{label}</strong>
        <small>{value}</small>
      </div>
    </div>
  );
}

export function WorkspaceView({ serviceOnline, onError, onNotice, onArchived, onWorkspaceChange, jobs, onOpenJob, onOpenRoles }) {
  const { language, t } = useI18n();
  const { data: workspace, loading, error: workspaceError, refresh } = useWorkspaceRead(runtimeApi.workspace, onWorkspaceChange);
  const srcHistory = useWorkspaceRead(() => runtimeApi.materialArchives("src"));
  const dstHistory = useWorkspaceRead(() => runtimeApi.materialArchives("dst"));
  const histories = { src: srcHistory, dst: dstHistory };
  const [importing, setImporting] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [archiving, setArchiving] = useState(false);
  const [historySide, setHistorySide] = useState(null);
  const [restoringArchive, setRestoringArchive] = useState(null);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const mutationRef = useRef(false);
  const closeHistory = useCallback(() => setHistorySide(null), []);
  const closeAction = () => { if (!mutationRef.current) { setAction(null); setActionError(null); } };
  const activeJobCount = (jobs ?? []).filter(job => ["queued","starting","running","waiting_input","stopping"].includes(job.state)).length;
  const completedJobCount = (jobs ?? []).filter(job => ["succeeded","failed","cancelled","orphaned"].includes(job.state)).length;
  const materialBusy = actionBusy || activeJobCount > 0;

  const refreshEverything = useCallback(async () => {
    return Promise.all([refresh(), srcHistory.refresh(), dstHistory.refresh()]);
  }, [refresh, srcHistory.refresh, dstHistory.refresh]);

  useEffect(() => {
    if (serviceOnline) void refreshEverything();
  }, [refreshEverything, serviceOnline]);

  const completedJobsKey = (jobs ?? []).filter(job => job.endedAt).map(job => `${job.id}:${job.endedAt}`).join("|");
  const lastCompletedJobs = useRef(completedJobsKey);
  useEffect(() => {
    if (lastCompletedJobs.current === completedJobsKey) return;
    lastCompletedJobs.current = completedJobsKey;
    if (serviceOnline) void refresh();
  }, [completedJobsKey, serviceOnline, refresh]);

  // While a request is in flight, navigation inside the app may continue but
  // unloading the document would interrupt upload and discard its response.
  useEffect(() => {
    if (!actionBusy) return undefined;
    const preventUnload = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [actionBusy]);

  const prepareAction = next => {
    if (mutationRef.current) return;
    setActionError(null);
    setAction(next);
  };
  const handleImport = (side, file, replacing) => {
    if (materialBusy) return;
    prepareAction({ kind:"import", side, file, replacing });
  };
  const handleRestoreArchive = archive => {
    if (!historySide || materialBusy) return;
    prepareAction({ kind:"restore", side:historySide, archive });
  };
  const handleArchive = () => {
    if (completedJobCount) prepareAction({ kind:"archive", count:completedJobCount });
  };
  const handleConfirm = async () => {
    if (!action || mutationRef.current) return;
    mutationRef.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      if (action.kind === "import") {
        setImporting(action.side);
        setImportProgress({ loaded:0, total:action.file.size, percent:0 });
        await runtimeApi.importVideo(action.side, action.file, {
          replace:action.replacing,
          onProgress:setImportProgress,
        });
        onNotice?.(t("{side} 视频已导入。",{side:action.side.toUpperCase()}));
      } else if (action.kind === "restore") {
        setRestoringArchive(action.archive.token);
        await runtimeApi.restoreMaterialArchive(action.side, action.archive.token);
        onNotice?.(t("{side} 素材已恢复；原素材已保存为可撤回历史。",{side:action.side.toUpperCase()}));
        setHistorySide(null);
      } else {
        setArchiving(true);
        const result = await runtimeApi.archiveCompletedJobs();
        onArchived(result);
      }
      // Reads have their own errors. A committed write remains a success even
      // when its refreshed inventory is temporarily unavailable.
      await refreshEverything();
      setAction(null);
    } catch (error) {
      setActionError(error);
    } finally {
      mutationRef.current = false;
      setActionBusy(false);
      setImporting(null);
      setImportProgress(null);
      setRestoringArchive(null);
      setArchiving(false);
    }
  };
  const checkUncertainResult = async () => {
    closeAction();
    await refreshEverything();
    // Refresh jobs too, in case archiving completed before its response was lost.
    if (action?.kind === "archive") onArchived({ archived:0, uncertain:true });
  };

  if (!serviceOnline) {
    return (
      <section className="workspace-manager workspace-offline">
        <IconAlertTriangle size={24} />
        <h2>{t("工作区服务离线")}</h2>
        <p>{t("启动本地 Runtime 后即可检查和导入素材。")}</p>
      </section>
    );
  }

  if (!workspace && workspaceError) {
    return <section className="workspace-manager workspace-read-error workspace-read-failed" role="alert">
      <IconAlertTriangle size={24}/><h2>{t("工作区读取失败")}</h2><p>{t(workspaceError.message)}</p>
      <p>{t("尚未读取到素材清单，不能据此判断素材是否存在。")}</p>
      <button type="button" className="button secondary" disabled={loading} onClick={() => void refreshEverything()}>{loading ? t("正在读取…") : t("重新读取")}</button>
    </section>;
  }

  if (!workspace) {
    return (
      <section className="workspace-manager workspace-loading">
        <LoadingProgress
          label={t("正在扫描工作区…")}
          detail={t("正在核对素材、数据集、模型与输出文件")}
        />
      </section>
    );
  }

  const data = workspace ?? {
    materials: {},
    datasets: {},
    readiness: {},
    models: [],
    outputs: [],
  };
  const readiness = [
    {
      label: t("视频帧"),
      value: `SRC ${data.datasets.srcFrames?.count ?? 0} / DST ${data.datasets.dstFrames?.count ?? 0}`,
      ready: data.readiness.frames,
    },
    {
      label: t("aligned 人脸"),
      value: `SRC ${data.datasets.srcFaces?.count ?? 0} / DST ${data.datasets.dstFaces?.count ?? 0}`,
      ready: data.readiness.faces,
    },
    {
      label: t("XSeg 模型（可选）"),
      value: data.readiness.xseg ? t("已检测") : t("按遮罩需求配置"),
      ready: data.readiness.xseg,
      optional: true,
    },
    {
      label: t("SAEHD 模型"),
      value: data.models.filter((model) => model.type === "SAEHD").length
        ? t("{count} 个", { count: data.models.filter((model) => model.type === "SAEHD").length })
        : t("未检测"),
      ready: data.readiness.saehd,
    },
    {
      label: t("merged 序列"),
      value: `${data.datasets.merged?.count ?? 0} / ${data.datasets.mergedMask?.count ?? 0}`,
      ready: data.readiness.merged,
    },
  ];
  const storage = data.storage;
  const storageWarning = Boolean(
    storage?.error
    || storage?.ready === false
    || (Number.isFinite(storage?.freeBytes)
      && Number.isFinite(storage?.reserveBytes)
      && storage.freeBytes < storage.reserveBytes),
  );

  return (
    <section className="workspace-manager">
      <header className="workspace-manager-header">
        <div>
          <span>{t("本地素材、模型与输出")}</span>
          <h2>{t("工作区管理")}</h2>
          <code>{data.root}</code>
        </div>
        <button className="button secondary" type="button" onClick={() => void refreshEverything()} disabled={loading}>
          <IconRefresh size={15} />{loading ? t("扫描中") : t("刷新")}
        </button>
      </header>
      {workspaceError ? <div className="workspace-read-error" role="alert"><strong>{t("工作区刷新失败，当前显示上次读取的内容。")}</strong><p>{t(workspaceError.message)}</p></div> : null}
      {activeJobCount > 0 ? <p className="workspace-mutation-hint">{t("任务运行期间暂不可更换或恢复视频，等待任务结束后即可操作。")}</p> : null}
      {loading && !importing ? (
        <LoadingProgress
          compact
          className="workspace-refresh-progress"
          label={t("正在刷新工作区清单…")}
          detail={t("现有内容保持可见")}
          operationKey="workspace-refresh"
        />
      ) : null}

      <div className={`workspace-storage-strip${storageWarning ? " is-warning" : ""}`}>
        <IconServer size={17} />
        <strong>{t("磁盘可用空间")}</strong>
        {!storage || storage.error ? (
          <span>{t("磁盘信息暂不可用")}</span>
        ) : (
          <>
            <b>{formatBytes(storage?.freeBytes)}</b>
            <span>{t("安全余量 {reserve} · 可用于任务 {usable}", {
              reserve: formatBytes(storage?.reserveBytes),
              usable: formatBytes(storage?.usableBytes),
            })}</span>
          </>
        )}
        {storageWarning && !storage?.error ? <em>{t("可用空间低于安全余量")}</em> : null}
      </div>

      <div className="workspace-layout">
        <div className="workspace-primary">
          <div className="material-grid">
            <MaterialSlot
              side="src"
              material={data.materials.src}
              busy={materialBusy}
              historyBusy={actionBusy}
              uploading={importing === "src"}
              progress={importing === "src" ? importProgress : null}
              archiveCount={srcHistory.data?.length}
              archivesLoading={srcHistory.loading}
              archivesError={srcHistory.error}
              onImport={handleImport}
              onOpenHistory={side => { setHistorySide(side); void histories[side].refresh(); }}
            />
            <MaterialSlot
              side="dst"
              material={data.materials.dst}
              busy={materialBusy}
              historyBusy={actionBusy}
              uploading={importing === "dst"}
              progress={importing === "dst" ? importProgress : null}
              archiveCount={dstHistory.data?.length}
              archivesLoading={dstHistory.loading}
              archivesError={dstHistory.error}
              onImport={handleImport}
              onOpenHistory={side => { setHistorySide(side); void histories[side].refresh(); }}
            />
          </div>
          <div className="workspace-person-actions"><p>{t("SRC 提供人脸；DST 是需要替换人物的视频。")}</p>
            {["src","dst"].map(side => <button key={side} type="button" className="button secondary" disabled={!(data.datasets[`${side}Faces`]?.count > 0)} onClick={() => onOpenRoles?.(side)}>{t("选择 {side} 人物",{side:side.toUpperCase()})}{data.roles?.[side]?.name ? ` · ${data.roles[side].name}` : ""}</button>)}
          </div>

          <section className="readiness-section">
            <div className="workspace-section-heading">
              <h3>{t("流水线就绪度")}</h3>
              <small>{t("必需项 {ready} / {total} 就绪", { ready: readiness.filter((item) => !item.optional && item.ready).length, total: readiness.filter(item => !item.optional).length })}</small>
            </div>
            <div className="readiness-grid">
              {readiness.map((item) => <ReadinessItem key={item.label} {...item} />)}
            </div>
          </section>
        </div>

        <aside className="workspace-models">
          <div className="workspace-section-heading">
            <h3>{t("模型")}</h3>
            <IconBoxModel2 size={17} />
          </div>
          {data.models.length ? data.models.map((model, index) => (
            <div className={`workspace-model ${index === 0 ? "is-primary" : ""}`} key={`${model.type}-${model.name}`}>
              <div>
                <span className={`model-type is-${model.type.toLowerCase()}`}>{model.type}</span>
                <strong>{model.name}</strong>
              </div>
              <dl>
                <div><dt>{t("文件")}</dt><dd>{model.fileCount}</dd></div>
                <div><dt>{t("大小")}</dt><dd>{formatBytes(model.bytes)}</dd></div>
                <div><dt>{t("更新")}</dt><dd>{new Date(model.modifiedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</dd></div>
              </dl>
            </div>
          )) : (
            <div className="workspace-list-empty">{t("尚未检测到模型")}</div>
          )}
        </aside>
      </div>

      <section className="workspace-outputs">
        <OutputGallery workspace={data} jobs={jobs} onError={onError} onNotice={onNotice} onOpenJob={onOpenJob}/>
        <div className="workspace-archive-row">
          <p>{t("归档只移动已结束任务的日志目录，不会删除素材、模型或输出。")}</p>
          <button className="button secondary" type="button" onClick={handleArchive} disabled={actionBusy || !completedJobCount}>
            <IconArchive size={15} />{archiving ? t("归档中…") : t("归档已完成任务")}
          </button>
        </div>
        {archiving ? (
          <LoadingProgress compact label={t("正在归档已结束任务…")} detail={t("素材、模型与输出不会被删除")} operationKey="workspace-archive-jobs" />
        ) : null}
      </section>
      {historySide ? (
        <MaterialHistoryDrawer
          side={historySide}
          archives={histories[historySide].data}
          loading={histories[historySide].loading}
          error={histories[historySide].error}
          onRetry={() => histories[historySide].refresh()}
          active={!action}
          restoring={restoringArchive}
          restoreDisabled={materialBusy}
          onClose={closeHistory}
          onRestore={(archive) => void handleRestoreArchive(archive)}
        />
      ) : null}
      <WorkspaceActionDialog action={action} busy={actionBusy} error={actionError} onClose={closeAction} onConfirm={() => void handleConfirm()} onRefresh={() => void checkUncertainResult()}/>
    </section>
  );
}
