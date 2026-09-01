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
  progress,
  archiveCount,
  archivesLoading,
  onImport,
  onOpenHistory,
}) {
  const { language, t } = useI18n();
  const inputRef = useRef(null);
  const label = side === "src" ? t("SRC 源视频") : t("DST 目标视频");
  return (
    <section className="material-slot">
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
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
            className="material-preview"
            muted
            playsInline
            preload="metadata"
            poster={`/api/assets/${side}/poster`}
            src={`/api/workspace/materials/${side}`}
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
          <IconUpload size={15} />{busy ? t("正在导入…") : material ? t("更换") : t("导入")}
        </button>
        <button
          className="button secondary material-history-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-busy={archivesLoading}
          onClick={() => onOpenHistory(side)}
          disabled={busy}
        >
          <IconHistory size={15} />
          {t("恢复历史（{count}）", { count: archiveCount })}
        </button>
      </div>
      {busy ? (
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

function MaterialHistoryDrawer({ side, archives, loading, restoring, onClose, onRestore }) {
  const { language, t } = useI18n();
  const closeRef = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !restoring) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose, restoring]);

  return (
    <div
      className="material-history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !restoring) onClose();
      }}
    >
      <aside
        className="material-history-drawer"
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
            ref={closeRef}
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
        {loading ? (
          <div className="material-history-state" role="status">{t("正在读取恢复历史…")}</div>
        ) : archives.length ? (
          <div className="material-history-list">
            {archives.map((archive) => {
              const busy = restoring === archive.token;
              return (
                <article key={archive.token}>
                  <span className="material-history-icon"><IconMovie size={17} /></span>
                  <div>
                    <strong>{new Date(archive.archivedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</strong>
                    <small>{archiveFormat(archive)} · {formatBytes(archive.bytes)}</small>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => onRestore(archive)}
                    disabled={Boolean(restoring)}
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

function ReadinessItem({ label, value, ready }) {
  return (
    <div className={`readiness-item ${ready ? "is-ready" : "is-missing"}`}>
      <span>{ready ? <IconCheck size={15} /> : <IconAlertTriangle size={15} />}</span>
      <div>
        <strong>{label}</strong>
        <small>{value}</small>
      </div>
    </div>
  );
}

export function WorkspaceView({ serviceOnline, onError, onNotice, onArchived, onWorkspaceChange }) {
  const { language, t } = useI18n();
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [archiving, setArchiving] = useState(false);
  const [archives, setArchives] = useState({ src: [], dst: [] });
  const [archivesLoading, setArchivesLoading] = useState({ src: false, dst: false });
  const [historySide, setHistorySide] = useState(null);
  const [restoringArchive, setRestoringArchive] = useState(null);
  const closeHistory = useCallback(() => setHistorySide(null), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextWorkspace = await runtimeApi.workspace();
      setWorkspace(nextWorkspace);
      onWorkspaceChange?.(nextWorkspace);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError, onWorkspaceChange]);

  const refreshArchives = useCallback(async (side) => {
    setArchivesLoading((current) => ({ ...current, [side]: true }));
    try {
      const records = await runtimeApi.materialArchives(side);
      setArchives((current) => ({ ...current, [side]: records }));
    } catch (error) {
      onError(error);
    } finally {
      setArchivesLoading((current) => ({ ...current, [side]: false }));
    }
  }, [onError]);

  const refreshEverything = useCallback(async () => {
    await Promise.all([refresh(), refreshArchives("src"), refreshArchives("dst")]);
  }, [refresh, refreshArchives]);

  useEffect(() => {
    if (serviceOnline) void refreshEverything();
  }, [refreshEverything, serviceOnline]);

  const handleImport = async (side, file, replacing) => {
    if (replacing && !window.confirm(
      t("确定更换 {side} 视频吗？旧视频会移入可恢复归档。", { side: side.toUpperCase() }),
    )) return;
    setImporting(side);
    setImportProgress({ loaded: 0, total: file.size, percent: 0 });
    try {
      await runtimeApi.importVideo(side, file, {
        replace: replacing,
        onProgress: ({ loaded, total, percent }) => setImportProgress({ loaded, total, percent }),
      });
      await Promise.all([refresh(), refreshArchives(side)]);
    } catch (error) {
      onError(error);
    } finally {
      setImporting(null);
      setImportProgress(null);
    }
  };

  const handleRestoreArchive = async (archive) => {
    const side = historySide;
    if (!side || !window.confirm(t(
      "确定恢复这份 {side} 素材吗？当前素材会先进入恢复历史。",
      { side: side.toUpperCase() },
    ))) return;
    setRestoringArchive(archive.token);
    try {
      await runtimeApi.restoreMaterialArchive(side, archive.token);
      await Promise.all([refresh(), refreshArchives(side)]);
      onNotice?.(t("{side} 素材已恢复；原素材已保存为可撤回历史。", { side: side.toUpperCase() }));
      setHistorySide(null);
    } catch (error) {
      onError(error);
    } finally {
      setRestoringArchive(null);
    }
  };

  const handleArchive = async () => {
    if (!window.confirm(t("把已完成、失败和已停止的任务日志移入可恢复归档吗？"))) return;
    setArchiving(true);
    try {
      const result = await runtimeApi.archiveCompletedJobs();
      onArchived(result);
    } catch (error) {
      onError(error);
    } finally {
      setArchiving(false);
    }
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

  if (loading && !workspace) {
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
      label: t("XSeg 模型"),
      value: data.readiness.xseg ? t("已检测") : t("未检测"),
      ready: data.readiness.xseg,
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
              busy={importing === "src"}
              progress={importing === "src" ? importProgress : null}
              archiveCount={archives.src.length}
              archivesLoading={archivesLoading.src}
              onImport={handleImport}
              onOpenHistory={setHistorySide}
            />
            <MaterialSlot
              side="dst"
              material={data.materials.dst}
              busy={importing === "dst"}
              progress={importing === "dst" ? importProgress : null}
              archiveCount={archives.dst.length}
              archivesLoading={archivesLoading.dst}
              onImport={handleImport}
              onOpenHistory={setHistorySide}
            />
          </div>

          <section className="readiness-section">
            <div className="workspace-section-heading">
              <h3>{t("流水线就绪度")}</h3>
              <small>{t("{ready} / {total} 项就绪", { ready: readiness.filter((item) => item.ready).length, total: readiness.length })}</small>
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
        <div className="workspace-section-heading">
          <h3>{t("输出文件")}</h3>
          <span>{t("{count} 个文件", { count: data.outputs.length })}</span>
        </div>
        {data.outputs.length ? (
          <div className="output-list">
            {data.outputs.map((output) => (
              <div className="output-row" key={output.name}>
                <span className="output-icon"><IconFile size={18} /></span>
                <div>
                  <strong>{output.name}</strong>
                  <small>{formatBytes(output.bytes)} · {new Date(output.modifiedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</small>
                </div>
                <a className="button secondary" href={output.url} target="_blank" rel="noreferrer">
                  <IconPlayerPlay size={15} />{t("播放")}
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div className="workspace-list-empty">{t("合成与编码完成后，MP4 会显示在这里。")}</div>
        )}
        <div className="workspace-archive-row">
          <p>{t("归档只移动已结束任务的日志目录，不会删除素材、模型或输出。")}</p>
          <button className="button secondary" type="button" onClick={() => void handleArchive()} disabled={archiving}>
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
          archives={archives[historySide]}
          loading={archivesLoading[historySide]}
          restoring={restoringArchive}
          onClose={closeHistory}
          onRestore={(archive) => void handleRestoreArchive(archive)}
        />
      ) : null}
    </section>
  );
}
