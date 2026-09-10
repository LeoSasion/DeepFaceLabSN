import { useI18n } from "../i18n.jsx";
import { OutputGallery } from "./OutputGallery.jsx";
import { CommandRows } from "./OperationsView.jsx";
import { activeJobStates, jobPresentation } from "../domain/job-presentation.js";

export function ExportView({ workspace, commands, jobs, onOpenCommand, onError, onNotice, onOpenJob }) {
  const { t } = useI18n();
  const job = jobs.find(job => job.commandId.startsWith("encode.") && activeJobStates.has(job.state))
    ?? jobs.find(job => job.commandId.startsWith("encode."));
  const presentation = jobPresentation(job);
  return <section className="operation-view export-view">
    <header className="operation-header"><div><h2>{t("视频导出")}</h2><p>{t("先检查成片，再按需要重新导出。")}</p></div>
      {job ? <button type="button" className={`button secondary is-${presentation.tone}`} onClick={() => onOpenJob(job.id)}>{t(presentation.label)} · {t("查看任务日志")}</button> : null}
    </header>
    {workspace ? <OutputGallery workspace={workspace} jobs={jobs} onError={onError} onNotice={onNotice} onOpenJob={onOpenJob}/> : <p role="status">{t("正在读取项目成果…")}</p>}
    <section className="export-recommended"><div><strong>{t("MP4 · 推荐用于播放和分享")}</strong><p>{t("包含原视频音频，同时生成遮罩视频。无损格式通常占用更多空间。")}</p></div>
      <button type="button" className="button primary" disabled={activeJobStates.has(job?.state)} onClick={() => onOpenCommand("encode.mp4")}>{t("导出 MP4")}</button>
    </section>
    <details className="export-formats"><summary>{t("其他视频格式")}</summary><CommandRows commands={commands.filter(command => command.category === "encode" && command.id !== "encode.mp4")} onOpenCommand={onOpenCommand}/></details>
    <details className="export-formats"><summary>{t("模型导出（DeepFaceLive）")}</summary><CommandRows commands={commands.filter(command => command.category === "model")} onOpenCommand={onOpenCommand}/></details>
  </section>;
}
