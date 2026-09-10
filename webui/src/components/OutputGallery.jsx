import { useState } from "react";
import { IconCopy, IconFolderOpen, IconMovie } from "@tabler/icons-react";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";

export function OutputGallery({ workspace, jobs = [], onError, onNotice, onOpenJob }) {
  const { t, language } = useI18n();
  const outputs = workspace?.outputs ?? [];
  const [selectedName, setSelectedName] = useState(null);
  const [revealing, setRevealing] = useState(false);
  const selected = outputs.find(output => output.name === selectedName)
    ?? outputs.find(output => !output.name.includes("_mask")) ?? outputs[0];
  const label = output => t(output.name.includes("_mask") ? "遮罩视频" : "合成视频");
  const date = value => value ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US") : "—";
  const records = new Map((workspace?.exportHistory ?? []).map(record => [record.id, record]));
  for (const job of jobs) {
    if (job.commandId.startsWith("encode.") && job.state === "succeeded" && !records.has(job.id)) records.set(job.id, job);
  }
  const history = [...records.values()].sort((a,b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(selected.path); onNotice?.(t("文件路径已复制")); }
    catch { onNotice?.(selected.path, "warning"); }
  };
  const reveal = async () => {
    setRevealing(true);
    try { await runtimeApi.revealWorkspace(); }
    catch (error) { onError?.(error); }
    finally { setRevealing(false); }
  };
  return <section className="output-gallery" aria-label={t("项目成果")}>
    <header><h3><IconMovie size={18} />{t("项目成果")}</h3><span>{t("{count} 个文件", {count:outputs.length})}</span></header>
    {selected ? <>
      <div className="output-gallery-layout">
        <video key={`${workspace.root}:${selected.name}:${selected.modifiedAt}`} controls playsInline preload="metadata"
          src={`${selected.url}?v=${encodeURIComponent(selected.modifiedAt)}`} aria-label={`${label(selected)} · ${selected.name}`} />
        <div className="output-gallery-detail">
          <label className="wizard-field"><span>{t("查看成果")}</span><select value={selected.name} onChange={event => setSelectedName(event.target.value)}>
            {outputs.map(output => <option key={output.name} value={output.name}>{label(output)} · {output.name}</option>)}
          </select></label>
          <p>{selected.name.includes("_mask") ? t("黑白遮罩，用于检查替换范围。") : t("合成后的视频，可直接播放检查。")}</p>
          <dl>
            <div><dt>{t("时长")}</dt><dd>{selected.durationSeconds ? `${selected.durationSeconds.toFixed(1)} s` : "—"}</dd></div>
            <div><dt>{t("分辨率")}</dt><dd>{selected.width ? `${selected.width} × ${selected.height}` : "—"}</dd></div>
            <div><dt>{t("大小")}</dt><dd>{(selected.bytes / 1024 / 1024).toFixed(1)} MB</dd></div>
            <div><dt>{t("生成时间")}</dt><dd>{date(selected.modifiedAt)}</dd></div>
          </dl>
          <div className="output-actions">
            <button type="button" className="button secondary" disabled={revealing} onClick={() => void reveal()}><IconFolderOpen size={16}/>{t("打开文件夹")}</button>
            <button type="button" className="button secondary" onClick={() => void copyPath()}><IconCopy size={16}/>{t("复制路径")}</button>
          </div>
        </div>
      </div>
    </> : <p className="output-empty">{t("还没有成片。完成合成后，选择推荐的 MP4 导出。")}</p>}
    <details className="export-history"><summary>{t("生成记录")} · {history.length}</summary>
      <p>{t("记录保留任务和参数；历史视频可能已被后续导出更新。")}</p>
      {history.map(record => <article key={record.id}>
        <strong>{record.label ?? record.commandId}</strong><time>{date(record.endedAt)}</time>
        {onOpenJob && jobs.some(job => job.id === record.id) ? <button className="text-button" type="button" onClick={() => onOpenJob(record.id)}>{t("查看任务日志")}</button> : null}
        <details><summary>{t("任务参数")}</summary><pre>{JSON.stringify(record.parameters ?? {},null,2)}</pre><small>{record.id}{record.appVersion ? ` · v${record.appVersion}` : ""}</small></details>
      </article>)}
    </details>
  </section>;
}
