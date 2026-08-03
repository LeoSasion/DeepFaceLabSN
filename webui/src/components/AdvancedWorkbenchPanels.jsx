import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconArrowBackUp,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDeviceFloppy,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconRestore,
  IconRoute,
  IconScissors,
  IconSparkles,
} from "@tabler/icons-react";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";
import { DatasetAuditPanel } from "./ToolWorkbenchPanels.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const REVIEW_PAGE_SIZE = 60;
const LANDMARK_GROUPS = {
  all: Array.from({ length: 68 }, (_, index) => index),
  jaw: Array.from({ length: 17 }, (_, index) => index),
  brows: Array.from({ length: 10 }, (_, index) => index + 17),
  nose: Array.from({ length: 9 }, (_, index) => index + 27),
  eyes: Array.from({ length: 12 }, (_, index) => index + 36),
  mouth: Array.from({ length: 20 }, (_, index) => index + 48),
};

function PanelState({ icon, title, detail, loading = false }) {
  return (
    <div className={`tool-workbench-state${loading ? " is-loading" : ""}`} role={loading ? undefined : "status"}>
      {loading ? <LoadingProgress className="in-panel" label={title} detail={detail} /> : (
        <>
          {icon}
          <strong>{title}</strong>
          <span>{detail}</span>
        </>
      )}
    </div>
  );
}

export function DatasetCleaningPanel(props) {
  const { t } = useI18n();
  const [mode, setMode] = useState("quality");
  return (
    <div className="advanced-audit-shell">
      <div className="advanced-mode-switch" role="tablist" aria-label={t("清洗分析模式") }>
        <button className={mode === "quality" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "quality"} onClick={() => setMode("quality")}>
          <IconAdjustmentsHorizontal size={15} />{t("质量审计")}
        </button>
        <button className={mode === "similarity" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "similarity"} onClick={() => setMode("similarity")}>
          <IconSparkles size={15} />{t("相似组清洗")}
        </button>
        <span>{t("相似度只用于生成候选组，不代表身份识别结论")}</span>
      </div>
      {mode === "quality" ? <DatasetAuditPanel {...props} /> : <SimilarityAuditPanel {...props} />}
    </div>
  );
}

function SimilarityAuditPanel({ side, refreshVersion, onError, onNotice, onNavigateDataset }) {
  const { t } = useI18n();
  const [threshold, setThreshold] = useState(0.86);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setData(null);
      void runtimeApi.alignedSimilarity(side, {
        threshold,
        refresh: refreshVersion > 0 || retry > 0,
      }).then((value) => {
        if (cancelled) return;
        setData(value);
        setSelected([]);
      }).catch((error) => {
        if (!cancelled) onError(error);
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [onError, refreshVersion, retry, side, threshold]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (name) => setSelected((current) => (
    current.includes(name) ? current.filter((value) => value !== name) : [...current, name]
  ));
  const selectGroupDuplicates = (group) => {
    const names = group.members.filter((member) => !member.representative).map((member) => member.name);
    setSelected((current) => [...new Set([...current, ...names])]);
  };
  const quarantine = async () => {
    if (!selected.length || !window.confirm(t(
      "将选中的 {count} 张候选重复图移入可恢复隔离区吗？代表图不会自动处理。",
      { count: selected.length },
    ))) return;
    setBusy(true);
    try {
      const result = await runtimeApi.quarantineAlignedBatch(side, selected);
      onNotice(t("已隔离 {count} 张相似候选，可在数据集页恢复。", { count: result.count }));
      setRetry((value) => value + 1);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <PanelState loading icon={<IconSparkles size={26} />} title={t("正在建立视觉相似候选组…")} detail={t("本地使用 DCT、色彩与边缘描述子，最多分析 500 张，不调用外部识别服务。") } />;
  return (
    <div className="similarity-workbench">
      {busy ? <LoadingProgress compact label={t("正在隔离相似候选…")} detail={t("批次共用一个可恢复令牌")} /> : null}
      <header className="similarity-toolbar">
        <div>
          <strong>{t("视觉相似候选")}</strong>
          <span>{t("{groups} 组 · {items} 张成组 · {single} 张未成组", {
            groups: data.groupCount,
            items: data.groupedCount,
            single: data.ungroupedCount,
          })}</span>
        </div>
        <label>
          <span>{t("相似阈值")}</span>
          <input type="range" min="0.72" max="0.98" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
          <strong>{threshold.toFixed(2)}</strong>
        </label>
        <button className="button secondary" type="button" onClick={() => setRetry((value) => value + 1)}><IconRefresh size={15} />{t("重新分析")}</button>
      </header>
      <div className="similarity-summary">
        <div><span>{t("已分析")}</span><strong>{data.analyzedCount}</strong></div>
        <div><span>{t("候选组")}</span><strong>{data.groupCount}</strong></div>
        <div><span>{t("已选择隔离")}</span><strong>{selected.length}</strong></div>
        <p>{data.truncated ? t("数据量超过 500 张；当前结果是有界预检，可分批复核。") : t("当前 aligned 已完整分析。")}</p>
      </div>
      {data.groups.length ? (
        <div className="similarity-groups">
          {data.groups.map((group) => (
            <section key={group.id}>
              <header>
                <div><strong>{t("候选组 {id}", { id: group.id.replace("similar-", "") })}</strong><span>{t("{count} 张 · 平均 {score}", { count: group.memberCount, score: group.meanScore.toFixed(3) })}</span></div>
                <button type="button" onClick={() => selectGroupDuplicates(group)}><IconCheck size={14} />{t("选中非代表图")}</button>
              </header>
              <div className="similarity-members">
                {group.members.map((member) => (
                  <article className={`${member.representative ? "is-representative" : ""} ${selectedSet.has(member.name) ? "is-selected" : ""}`} key={member.name}>
                    <button type="button" disabled={member.representative} onClick={() => toggle(member.name)} aria-pressed={selectedSet.has(member.name)}>
                      <img src={member.imageUrl} alt="" loading="lazy" decoding="async" />
                      <span>{member.representative ? t("代表图") : selectedSet.has(member.name) ? t("待隔离") : t("候选")}</span>
                    </button>
                    <div><strong title={member.name}>{member.name}</strong><small>{member.score.toFixed(3)}</small></div>
                    <button type="button" onClick={() => onNavigateDataset(side, member)}>{t("查看")}</button>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : <PanelState icon={<IconCheck size={26} />} title={t("当前阈值下没有相似组")} detail={t("可适当降低阈值生成更宽松的候选，但仍需人工复核。") } />}
      <footer className="similarity-action-dock">
        <div><IconArchive size={18} /><span><strong>{t("{count} 张待处理", { count: selected.length })}</strong><small>{t("批次共用一个恢复令牌，不会删除原图")}</small></span></div>
        <button className="button primary" type="button" disabled={!selected.length || busy} onClick={() => void quarantine()}>{busy ? t("正在隔离…") : t("移入可恢复隔离区")}</button>
      </footer>
    </div>
  );
}

function cloneLandmarks(points) {
  return points.map(([x, y]) => [Number(x), Number(y)]);
}

function sameLandmarks(left, right) {
  return left?.length === 68
    && right?.length === 68
    && left.every(([x, y], index) => (
      Math.abs(x - right[index][0]) < 0.001
      && Math.abs(y - right[index][1]) < 0.001
    ));
}

export function AlignmentRepairPanel({ side, refreshVersion, onError, onNotice, onOpenCommand }) {
  const { t } = useI18n();
  const [coverage, setCoverage] = useState(null);
  const [offset, setOffset] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [faceIndex, setFaceIndex] = useState(0);
  const [landmarks, setLandmarks] = useState([]);
  const [baseline, setBaseline] = useState([]);
  const [group, setGroup] = useState("all");
  const [dragging, setDragging] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [retry, setRetry] = useState(0);
  const [backups, setBackups] = useState([]);

  useEffect(() => setOffset(0), [side]);
  useEffect(() => {
    let cancelled = false;
    setCoverage(null);
    Promise.all([
      runtimeApi.extractionCoverage(side, { refresh: refreshVersion > 0 || retry > 0, offset, limit: REVIEW_PAGE_SIZE }),
      runtimeApi.alignedRepairBackups(side),
    ]).then(([nextCoverage, nextBackups]) => {
      if (cancelled) return;
      setCoverage(nextCoverage);
      setBackups(nextBackups);
      setFrameIndex(0);
      setFaceIndex(0);
    }).catch((error) => { if (!cancelled) onError(error); });
    return () => { cancelled = true; };
  }, [offset, onError, refreshVersion, retry, side]);

  const frames = coverage?.items ?? [];
  const frame = frames[Math.min(frameIndex, Math.max(frames.length - 1, 0))] ?? null;
  const face = frame?.faces[Math.min(faceIndex, Math.max(frame.faces.length - 1, 0))] ?? null;
  const faceLandmarksKey = JSON.stringify(face?.landmarks ?? []);
  useEffect(() => {
    const next = face?.landmarks?.length === 68 ? cloneLandmarks(face.landmarks) : [];
    setLandmarks(next);
    setBaseline(cloneLandmarks(next));
    setPreview(null);
  }, [face?.alignedName, faceLandmarksKey]);

  const previewMatches = sameLandmarks(preview?.sourceLandmarks, landmarks);

  const updatePoint = (event) => {
    if (dragging == null || !frame?.width || !frame?.height) return;
    const svg = event.currentTarget;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(svg.getScreenCTM().inverse());
    const x = Math.min(Math.max(local.x, 0), frame.width - 1);
    const y = Math.min(Math.max(local.y, 0), frame.height - 1);
    setPreview(null);
    setLandmarks((current) => current.map((point, index) => index === dragging ? [x, y] : point));
  };
  const nudge = (dx, dy) => {
    const indexes = new Set(LANDMARK_GROUPS[group]);
    setPreview(null);
    setLandmarks((current) => current.map(([x, y], index) => indexes.has(index)
      ? [Math.min(Math.max(x + dx, 0), frame.width - 1), Math.min(Math.max(y + dy, 0), frame.height - 1)]
      : [x, y]));
  };
  const neighborFace = (direction) => {
    for (let next = frameIndex + direction; next >= 0 && next < frames.length; next += direction) {
      if (frames[next].faces[0]?.landmarks?.length === 68) return frames[next].faces[0];
    }
    return null;
  };
  const inherit = (mode) => {
    const previous = neighborFace(-1);
    const next = neighborFace(1);
    if (mode === "previous" && previous) setLandmarks(cloneLandmarks(previous.landmarks));
    if (mode === "next" && next) setLandmarks(cloneLandmarks(next.landmarks));
    if (mode === "interpolate" && previous && next) setLandmarks(previous.landmarks.map(([x, y], index) => [
      (x + next.landmarks[index][0]) / 2,
      (y + next.landmarks[index][1]) / 2,
    ]));
    setPreview(null);
  };
  const runPreview = async () => {
    if (!face || landmarks.length !== 68) return;
    setBusy("preview");
    try {
      setPreview(await runtimeApi.previewAlignedRepair(side, face.alignedName, landmarks));
    } catch (error) { onError(error); } finally { setBusy(null); }
  };
  const applyRepair = async () => {
    if (!face || !previewMatches || !window.confirm(t("将按当前 68 点重新裁切 {name} 吗？原文件会先进入对齐恢复区。", { name: face.alignedName }))) return;
    setBusy("apply");
    try {
      const result = await runtimeApi.applyAlignedRepair(side, face.alignedName, landmarks);
      onNotice(t("对齐已重裁并原子替换；恢复令牌 {token}", { token: result.token }));
      setRetry((value) => value + 1);
    } catch (error) { onError(error); } finally { setBusy(null); }
  };
  const restore = async (backup) => {
    if (!window.confirm(t("恢复 {name} 的对齐备份吗？当前版本也会保留一份撤销副本。", { name: backup.name }))) return;
    setBusy("restore");
    try {
      await runtimeApi.restoreAlignedRepair(side, backup.token, backup.name);
      onNotice(t("已恢复 {name}", { name: backup.name }));
      setRetry((value) => value + 1);
    } catch (error) { onError(error); } finally { setBusy(null); }
  };

  if (!coverage) return <PanelState loading icon={<IconRoute size={26} />} title={t("正在关联源帧与 aligned 元数据…")} detail={t("修复只对已有 68 点人脸开放。") } />;
  if (!coverage.total) return <PanelState icon={<IconPhoto size={26} />} title={t("还没有源帧")} detail={t("先提取视频帧，再进入对齐修复。") } />;
  return (
    <div className="alignment-repair-workbench">
      {busy ? (
        <LoadingProgress
          compact
          label={t({ preview: "正在生成修复预览…", apply: "正在应用对齐修复…", restore: "正在恢复对齐备份…" }[busy])}
          detail={t("原图始终保留可恢复副本")}
        />
      ) : null}
      <header className="alignment-toolbar">
        <div><strong>{t("对齐修复工作台")}</strong><span>{t("拖动源帧 landmarks，预览确认后重新裁切；不会只改元数据。")}</span></div>
        <div className="frame-stepper">
          <button type="button" disabled={frameIndex <= 0} onClick={() => { setFrameIndex((value) => value - 1); setFaceIndex(0); }}><IconChevronLeft size={17} /></button>
          <span>{frameIndex + 1} / {frames.length}</span>
          <button type="button" disabled={frameIndex >= frames.length - 1} onClick={() => { setFrameIndex((value) => value + 1); setFaceIndex(0); }}><IconChevronRight size={17} /></button>
        </div>
        <div className="frame-stepper">
          <button type="button" disabled={offset <= 0} onClick={() => setOffset((value) => Math.max(0, value - REVIEW_PAGE_SIZE))}><IconChevronLeft size={17} /></button>
          <span>{coverage.offset + 1}–{coverage.offset + coverage.analyzedCount} / {coverage.total}</span>
          <button type="button" disabled={coverage.offset + coverage.analyzedCount >= coverage.total} onClick={() => setOffset((value) => value + REVIEW_PAGE_SIZE)}><IconChevronRight size={17} /></button>
        </div>
      </header>
      <div className="alignment-repair-layout">
        <section className="alignment-source-stage">
          {frame ? (
            <div className="alignment-source-canvas" style={{ aspectRatio: `${frame.width || 16}/${frame.height || 9}` }}>
              <svg
                viewBox={`0 0 ${frame.width} ${frame.height}`}
                onPointerMove={updatePoint}
                onPointerUp={() => setDragging(null)}
                onPointerLeave={() => setDragging(null)}
              >
                <image href={frame.frameUrl} x="0" y="0" width={frame.width} height={frame.height} preserveAspectRatio="none" />
                {face?.rect && <rect className="alignment-original-rect" x={face.rect[0]} y={face.rect[1]} width={face.rect[2] - face.rect[0]} height={face.rect[3] - face.rect[1]} />}
                {landmarks.map(([x, y], pointIndex) => (
                  <circle
                    className={LANDMARK_GROUPS[group].includes(pointIndex) ? "is-active" : ""}
                    key={pointIndex}
                    cx={x}
                    cy={y}
                    r={dragging === pointIndex ? 3.3 : 2.2}
                    onPointerDown={(event) => { event.preventDefault(); setDragging(pointIndex); }}
                  />
                ))}
              </svg>
              <span>{frame.name}</span>
            </div>
          ) : null}
          <div className="alignment-face-picker">
            {frame?.faces.map((item, itemIndex) => (
              <button className={itemIndex === faceIndex ? "is-active" : ""} type="button" key={item.alignedName} onClick={() => setFaceIndex(itemIndex)}>
                <img src={item.alignedUrl} alt="" loading="lazy" decoding="async" /><span>{item.alignedName}</span>
              </button>
            ))}
            {frame && !frame.faces.length ? <span>{t("该帧没有可修复的 aligned 人脸")}</span> : null}
          </div>
        </section>
        <aside className="alignment-control-panel">
          <section>
            <header><strong>{t("点组与微调")}</strong><span>{landmarks.length}/68</span></header>
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="all">{t("全部点")}</option><option value="jaw">{t("下颌")}</option><option value="brows">{t("眉毛")}</option>
              <option value="nose">{t("鼻部")}</option><option value="eyes">{t("双眼")}</option><option value="mouth">{t("嘴部")}</option>
            </select>
            <div className="alignment-nudge-grid">
              <button type="button" onClick={() => nudge(0, -1)}>↑</button>
              <button type="button" onClick={() => nudge(-1, 0)}>←</button>
              <button type="button" onClick={() => nudge(1, 0)}>→</button>
              <button type="button" onClick={() => nudge(0, 1)}>↓</button>
            </div>
            <button type="button" onClick={() => { setLandmarks(cloneLandmarks(baseline)); setPreview(null); }}><IconArrowBackUp size={15} />{t("恢复本帧原始点")}</button>
          </section>
          <section>
            <header><strong>{t("邻帧继承")}</strong><span>{t("先复制，再人工校正")}</span></header>
            <div className="alignment-inherit-actions">
              <button type="button" onClick={() => inherit("previous")}><IconCopy size={14} />{t("上一帧")}</button>
              <button type="button" onClick={() => inherit("interpolate")}><IconRoute size={14} />{t("前后插值")}</button>
              <button type="button" onClick={() => inherit("next")}><IconCopy size={14} />{t("下一帧")}</button>
            </div>
          </section>
          <section className="alignment-preview-card">
            <header><strong>{t("重裁预览")}</strong><span>{preview ? t("待确认") : t("尚未生成")}</span></header>
            {preview ? <img src={preview.previewDataUrl} alt="" decoding="async" /> : face ? <img src={face.alignedUrl} alt="" decoding="async" /> : <div>{t("选择已有 aligned 人脸")}</div>}
            <button className="button secondary" type="button" disabled={!face || landmarks.length !== 68 || busy} onClick={() => void runPreview()}><IconRefresh size={15} />{t("生成新裁切预览")}</button>
            <button className="button primary" type="button" disabled={!previewMatches || busy} onClick={() => void applyRepair()}><IconCheck size={15} />{t("确认并原子替换")}</button>
          </section>
          <section className="alignment-backups">
            <header><strong>{t("最近恢复点")}</strong><span>{backups.length}</span></header>
            {backups.slice(0, 4).map((backup) => <button key={`${backup.token}-${backup.name}`} type="button" disabled={Boolean(busy)} onClick={() => void restore(backup)}><IconRestore size={14} /><span>{backup.name}<small>{backup.token}</small></span></button>)}
            {!backups.length ? <small>{t("首次应用修复后会在这里出现")}</small> : null}
          </section>
          <button className="alignment-manual-link" type="button" onClick={() => onOpenCommand(`${side}.extract_faces`)}><IconPlayerPlay size={15} />{t("需要重跑检测器？打开提取任务")}</button>
        </aside>
      </div>
    </div>
  );
}

function formatTime(value) {
  const seconds = Math.max(Number(value) || 0, 0);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

export function SegmentTimelinePanel({ side, refreshVersion, onError, onNotice, onOpenCommand }) {
  const { t } = useI18n();
  const videoRef = useRef(null);
  const [timeline, setTimeline] = useState(null);
  const [segments, setSegments] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [markIn, setMarkIn] = useState(0);
  const [markOut, setMarkOut] = useState(null);
  const [threshold, setThreshold] = useState(0.35);
  const [fps, setFps] = useState(0);
  const [busy, setBusy] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    void runtimeApi.videoTimeline(side).then((value) => {
      if (cancelled) return;
      setTimeline(value);
      setSegments(value.segments ?? []);
      setThreshold(value.sceneThreshold ?? 0.35);
      setMarkOut(value.material?.durationSeconds ?? null);
    }).catch((error) => { if (!cancelled) onError(error); });
    return () => { cancelled = true; };
  }, [onError, refreshVersion, retry, side]);
  const duration = Number(timeline?.material?.durationSeconds) || 0;
  const activeScene = timeline?.scenes.find((scene) => currentTime >= scene.start && currentTime < scene.end) ?? null;
  const addSegment = (start = markIn, end = markOut) => {
    if (end == null || end <= start) return onError(new Error(t("出点必须晚于入点")));
    setSegments((current) => [...current, {
      id: `seg-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
      label: t("片段 {count}", { count: current.length + 1 }),
      start,
      end,
      selected: true,
    }].sort((left, right) => left.start - right.start));
  };
  const seek = (time) => {
    if (videoRef.current) videoRef.current.currentTime = time;
    setCurrentTime(time);
  };
  const save = async () => {
    setBusy("save");
    try {
      const result = await runtimeApi.saveVideoSegments(side, segments);
      setSegments(result.segments);
      onNotice(t("已保存 {count} 个分段", { count: result.segments.length }));
    } catch (error) { onError(error); } finally { setBusy(null); }
  };
  const detect = async () => {
    setBusy("detect");
    try {
      const result = await runtimeApi.detectVideoScenes(side, threshold);
      setTimeline((current) => ({ ...current, scenes: result.scenes, sceneThreshold: result.threshold }));
      onNotice(t("已检测 {count} 个场景", { count: result.scenes.length }));
    } catch (error) { onError(error); } finally { setBusy(null); }
  };
  const extract = async () => {
    const count = segments.filter((segment) => segment.selected).length;
    if (!count || !window.confirm(t("将从 {count} 个分段批量提帧吗？现有直接帧会先归档，aligned 目录不会被改动。", { count }))) return;
    setBusy("extract");
    try {
      const result = await runtimeApi.extractVideoSegments(side, segments, fps);
      const archives = await runtimeApi.frameArchives(side);
      setTimeline((current) => ({ ...current, archives }));
      onNotice(t("已提取 {frames} 帧；原有 {archived} 帧已归档。", { frames: result.frameCount, archived: result.archivedFrameCount }));
    } catch (error) { onError(error); } finally { setBusy(null); }
  };
  const restoreArchive = async (archive) => {
    if (!window.confirm(t("恢复包含 {count} 帧的归档 {token} 吗？当前直接帧也会先形成新的撤销归档。", { count: archive.frameCount, token: archive.token }))) return;
    setBusy("restore");
    try {
      const result = await runtimeApi.restoreFrameArchive(side, archive.token);
      const archives = await runtimeApi.frameArchives(side);
      setTimeline((current) => ({ ...current, archives }));
      onNotice(t("已恢复 {count} 帧；撤销令牌 {token}", { count: result.restoredFrameCount, token: result.undoToken }));
    } catch (error) { onError(error); } finally { setBusy(null); }
  };

  if (!timeline) return <PanelState loading icon={<IconScissors size={26} />} title={t("正在读取素材时间线…")} detail={t("场景和分段清单保存在当前项目内。") } />;
  if (!timeline.material) return <PanelState icon={<IconPhoto size={26} />} title={t("{side} 视频尚未导入", { side: side.toUpperCase() })} detail={t("导入素材后即可检测场景和批量分段提帧。") } />;
  return (
    <div className="segment-timeline-workbench">
      {busy ? (
        <LoadingProgress
          compact
          label={t({ save: "正在保存分段清单…", detect: "正在检测场景边界…", extract: "正在提取选中分段…", restore: "正在恢复帧归档…" }[busy])}
          detail={t("当前时间线保持可见，完成后自动刷新")}
        />
      ) : null}
      <section className="segment-video-column">
        <video ref={videoRef} controls preload="metadata" src={timeline.material.url} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} />
        <div className="scene-timeline" aria-label={t("场景时间线") }>
          <div className="scene-track">
            {timeline.scenes.map((scene) => <button key={scene.id} type="button" title={`${scene.id} ${formatTime(scene.start)}–${formatTime(scene.end)}`} style={{ left: `${scene.start / Math.max(duration, 1) * 100}%`, width: `${(scene.end - scene.start) / Math.max(duration, 1) * 100}%` }} onClick={() => seek(scene.start)} />)}
            {segments.map((segment) => <span className={segment.selected ? "is-selected" : ""} key={segment.id} style={{ left: `${segment.start / Math.max(duration, 1) * 100}%`, width: `${(segment.end - segment.start) / Math.max(duration, 1) * 100}%` }} />)}
            <i style={{ left: `${currentTime / Math.max(duration, 1) * 100}%` }} />
          </div>
          <div><span>00:00</span><strong>{formatTime(currentTime)}</strong><span>{formatTime(duration)}</span></div>
        </div>
        <div className="segment-mark-controls">
          <button type="button" onClick={() => setMarkIn(currentTime)}>{t("设为入点")}<strong>{formatTime(markIn)}</strong></button>
          <button type="button" onClick={() => setMarkOut(currentTime)}>{t("设为出点")}<strong>{formatTime(markOut)}</strong></button>
          <button className="button primary" type="button" onClick={() => addSegment()}><IconScissors size={15} />{t("添加分段")}</button>
          <button type="button" disabled={!activeScene} onClick={() => activeScene && addSegment(activeScene.start, activeScene.end)}>{t("添加当前场景")}</button>
        </div>
        <div className="segment-list">
          {segments.map((segment, index) => (
            <article key={segment.id}>
              <input type="checkbox" checked={segment.selected} onChange={(event) => setSegments((current) => current.map((item) => item.id === segment.id ? { ...item, selected: event.target.checked } : item))} />
              <button type="button" onClick={() => seek(segment.start)}><strong>{segment.label}</strong><span>{formatTime(segment.start)} – {formatTime(segment.end)}</span></button>
              <small>{(segment.end - segment.start).toFixed(2)} s</small>
              <button type="button" aria-label={t("移除片段")} onClick={() => setSegments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
            </article>
          ))}
          {!segments.length ? <span>{t("尚未添加分段；可手动标记或从检测场景生成。")}</span> : null}
        </div>
      </section>
      <aside className="segment-control-panel">
        <header><div><span>{side.toUpperCase()}</span><strong>{timeline.material.name}</strong></div><small>{formatTime(duration)}</small></header>
        <section>
          <strong>{t("场景检测")}</strong>
          <label><span>{t("敏感度阈值")}</span><input type="range" min="0.08" max="0.85" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><b>{threshold.toFixed(2)}</b></label>
          <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void detect()}><IconSparkles size={15} />{busy === "detect" ? t("正在检测…") : t("检测场景边界")}</button>
          <small>{t("只生成时间边界，不会修改视频。阈值越低，分段越密。")}</small>
        </section>
        <section>
          <strong>{t("批量提帧")}</strong>
          <label><span>{t("输出帧率")}</span><select value={fps} onChange={(event) => setFps(Number(event.target.value))}><option value="0">{t("保持源帧")}</option><option value="5">5 fps</option><option value="10">10 fps</option><option value="15">15 fps</option><option value="25">25 fps</option></select></label>
          <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void save()}><IconDeviceFloppy size={15} />{busy === "save" ? t("正在保存…") : t("保存分段清单")}</button>
          <button className="button primary" type="button" disabled={Boolean(busy) || !segments.some((segment) => segment.selected)} onClick={() => void extract()}><IconPlayerPlay size={15} />{busy === "extract" ? t("正在提帧…") : t("提取选中分段")}</button>
          <small>{t("提交前会再次确认；现有直接帧先进入项目归档，aligned 不受影响。")}</small>
        </section>
        <section className="segment-archives">
          <strong>{t("帧恢复点")}</strong>
          {timeline.archives?.slice(0, 4).map((archive) => (
            <button type="button" key={archive.token} disabled={Boolean(busy)} onClick={() => void restoreArchive(archive)}>
              <IconRestore size={14} /><span>{archive.token}<small>{t("{count} 帧", { count: archive.frameCount })}</small></span>
            </button>
          ))}
          {!timeline.archives?.length ? <small>{t("首次分段提帧并归档旧帧后出现")}</small> : null}
        </section>
        <button className="segment-command-link" type="button" onClick={() => onOpenCommand(`${side}.extract_frames`)}>{t("打开完整视频提帧命令")}</button>
      </aside>
    </div>
  );
}
